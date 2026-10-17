import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { DataSource, EntityManager, In, LessThanOrEqual, Not, Repository } from 'typeorm';
import { CardAuthorizationService } from '../cards/card-authorization.service';
import { Card } from '../cards/entities/card.entity';
import { OutboxService } from '../events/outbox.service';
import { BankingClientService, PaymentResult } from './banking-client.service';
import {
  addDays,
  bogotaToday,
  chargeKey,
  dueDate,
  firstPeriodOnOrAfter,
  nextPeriod,
  periodOf,
} from './billing-dates';
import { EnrollSubscriptionDto } from './dto/subscription.dto';
import { Merchant } from './entities/merchant.entity';
import { SubscriptionCharge } from './entities/subscription-charge.entity';
import { Subscription } from './entities/subscription.entity';
import { MerchantsService } from './merchants.service';
import { isSubscriptionMerchant } from './catalog';

// Tras el intento del día de cobro hay 3 reintentos (días siguientes); luego se suspende.
const MAX_RETRIES = 3;
const REMINDER_DAYS_BEFORE = 3;
// Candado de Postgres para que la tarea diaria no corra dos veces a la vez.
const BILLING_LOCK_KEY = 74920041;

export const SUBSCRIPTION_EVENTS = {
  upcoming: 'subscription.charge_upcoming',
  charged: 'subscription.charged',
  rejected: 'subscription.charge_rejected',
  suspended: 'subscription.suspended',
} as const;

export interface BillingRunSummary {
  asOf: string;
  skipped?: string;
  reminded: number;
  charged: number;
  rejected: number;
  suspended: number;
  unavailable: number;
}

@Injectable()
export class SubscriptionsService {
  private readonly logger = new Logger('Subscriptions');

  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(Subscription) private readonly subscriptions: Repository<Subscription>,
    @InjectRepository(SubscriptionCharge) private readonly chargeRows: Repository<SubscriptionCharge>,
    @InjectRepository(Card) private readonly cards: Repository<Card>,
    private readonly merchants: MerchantsService,
    private readonly banking: BankingClientService,
    private readonly outbox: OutboxService,
    private readonly authorizations: CardAuthorizationService,
  ) {}

  // =====================================================
  // CLIENTE
  // =====================================================

  async catalog() {
    return (await this.merchants.findSubscriptionMerchants()).map((merchant) => ({
      code: merchant.code,
      name: merchant.name,
      plan: merchant.plan,
      price: Number(merchant.price),
      currency: merchant.currency,
      available: !!merchant.accountId,
    }));
  }

  async list(userId: string) {
    const subscriptions = await this.subscriptions.find({
      where: { userId, status: Not(In(['cancelled', 'pending'])) },
      order: { createdAt: 'ASC' },
    });
    const items = await this.publicMany(subscriptions);
    const monthlyTotal = items
      .filter((item) => item.status === 'active')
      .reduce((sum, item) => sum + item.amount, 0);
    return { items, monthlyTotal, currency: 'COP' };
  }

  /** Inscribe y cobra el primer mes de inmediato. Si el cobro falla, no se crea. */
  async enroll(userId: string, dto: EnrollSubscriptionDto) {
    const merchant = isSubscriptionMerchant(dto.merchantCode) ? await this.merchants.findByCode(dto.merchantCode) : null;
    if (!merchant) throw new NotFoundException('Ese servicio no está en el catálogo.');
    if (!merchant.accountId) {
      throw new ServiceUnavailableException(`${merchant.name} todavía no está disponible. Inténtalo en unos minutos.`);
    }

    const card = await this.cards.findOne({ where: { id: dto.cardId } });
    // La tarjeta debe ser del usuario de la sesión.
    if (!card || card.userId !== userId) throw new ForbiddenException('La tarjeta no te pertenece.');
    if (card.status !== 'active') throw new BadRequestException('La tarjeta está congelada. Reactívala para inscribir la suscripción.');
    if (card.currency !== merchant.currency) throw new BadRequestException('La tarjeta y el servicio deben usar la misma moneda.');

    const existing = await this.subscriptions.findOne({
      where: { userId, merchantCode: merchant.code, status: Not('cancelled') },
    });
    if (existing) throw new ConflictException(`Ya tienes una suscripción a ${merchant.name}.`);

    const today = bogotaToday();
    const subscription = this.subscriptions.create({
      id: randomUUID(),
      userId,
      cardId: card.id,
      merchantCode: merchant.code,
      amount: merchant.price,
      currency: merchant.currency,
      billingDay: Number(today.slice(8, 10)),
      status: 'pending',
      pendingPeriod: periodOf(today),
      nextChargeDate: today,
      retryCount: 0,
      remindedFor: periodOf(today),
    });
    try {
      await this.subscriptions.save(subscription);
    } catch (error) {
      if ((error as any)?.code === '23505') throw new ConflictException(`Ya tienes una suscripción a ${merchant.name}.`);
      throw error;
    }

    const result = await this.attemptCharge(subscription, merchant, card);
    if (result.kind !== 'approved') {
      await this.subscriptions.delete({ id: subscription.id, status: 'pending' });
      if (result.kind === 'unavailable') throw new ServiceUnavailableException(`No se pudo cobrar el primer mes: ${result.reason}`);
      throw new BadRequestException(`No se pudo cobrar el primer mes: ${result.reason}`);
    }

    await this.recordSuccess(subscription, merchant, card, result.transactionId);
    return this.publicOne(subscription);
  }

  async charges(userId: string, id: string) {
    const subscription = await this.findOwned(userId, id);
    const rows = await this.chargeRows.find({
      where: { subscriptionId: subscription.id },
      order: { createdAt: 'DESC' },
      take: 24,
    });
    return rows.map((row) => ({
      id: row.id,
      period: row.period,
      attempt: row.attempt,
      status: row.status,
      reason: row.reason,
      amount: Number(row.amount),
      currency: row.currency,
      ledgerTransactionId: row.ledgerTransactionId,
      createdAt: row.createdAt,
    }));
  }

  /** Pausar: no se cobra mientras esté pausada. */
  async pause(userId: string, id: string) {
    const subscription = await this.findOwned(userId, id);
    if (subscription.status !== 'active') throw new ConflictException('Solo se pueden pausar suscripciones activas.');
    subscription.status = 'paused';
    subscription.pausedAt = new Date();
    await this.subscriptions.save(subscription);
    return this.publicOne(subscription);
  }

  /**
   * Reanudar una pausada: no se cobran los meses en pausa; el próximo cobro es
   * el siguiente día de cobro desde hoy (si es hoy, se cobra de una vez).
   * Reactivar una suspendida: se intenta cobrar el mes actual en ese momento.
   */
  async resume(userId: string, id: string) {
    const subscription = await this.findOwned(userId, id);
    const today = bogotaToday();

    if (subscription.status === 'paused') {
      let period = firstPeriodOnOrAfter(today, subscription.billingDay);
      while (await this.isPaid(subscription.id, period)) period = nextPeriod(period);
      Object.assign(subscription, {
        status: 'active',
        pausedAt: null,
        retryCount: 0,
        pendingPeriod: period,
        nextChargeDate: dueDate(period, subscription.billingDay),
      });
      await this.subscriptions.save(subscription);
      if (subscription.nextChargeDate <= today) await this.processDue(subscription, today);
      return this.publicOne(await this.subscriptions.findOneByOrFail({ id: subscription.id }));
    }

    if (subscription.status === 'suspended') {
      let period = periodOf(today);
      if (await this.isPaid(subscription.id, period)) {
        while (await this.isPaid(subscription.id, period)) period = nextPeriod(period);
        Object.assign(subscription, {
          status: 'active',
          suspendedAt: null,
          retryCount: 0,
          pendingPeriod: period,
          nextChargeDate: dueDate(period, subscription.billingDay),
        });
        await this.subscriptions.save(subscription);
        return this.publicOne(subscription);
      }
      subscription.pendingPeriod = period;
      subscription.retryCount = 0;
      const merchant = await this.requireMerchant(subscription.merchantCode);
      const card = await this.cards.findOne({ where: { id: subscription.cardId } });
      const result = await this.attemptCharge(subscription, merchant, card);
      if (result.kind === 'unavailable') throw new ServiceUnavailableException(`No se pudo cobrar: ${result.reason}`);
      if (result.kind === 'rejected') {
        await this.chargeRows.save(this.chargeRows.create({
          subscriptionId: subscription.id,
          period,
          attempt: 1,
          status: 'rejected',
          reason: result.reason,
          amount: subscription.amount,
          currency: subscription.currency,
          ledgerTransactionId: null,
        }));
        throw new BadRequestException(`No se pudo reactivar: ${result.reason}`);
      }
      subscription.suspendedAt = null;
      await this.recordSuccess(subscription, merchant, card as Card, result.transactionId);
      return this.publicOne(subscription);
    }

    throw new ConflictException('La suscripción no está pausada ni suspendida.');
  }

  async cancel(userId: string, id: string) {
    const subscription = await this.findOwned(userId, id);
    if (subscription.status === 'cancelled') return this.publicOne(subscription);
    subscription.status = 'cancelled';
    subscription.cancelledAt = new Date();
    await this.subscriptions.save(subscription);
    return this.publicOne(subscription);
  }

  // =====================================================
  // TAREA DIARIA (cron y endpoint interno)
  // =====================================================

  /**
   * Avisa los cobros de dentro de 3 días y cobra lo que vence hoy o antes
   * (incluye reintentos y días perdidos si el servicio estuvo caído).
   * Un candado de Postgres evita que dos ejecuciones se crucen.
   */
  async runBilling(asOf = bogotaToday()): Promise<BillingRunSummary> {
    const summary: BillingRunSummary = { asOf, reminded: 0, charged: 0, rejected: 0, suspended: 0, unavailable: 0 };
    const runner = this.dataSource.createQueryRunner();
    await runner.connect();
    try {
      const [{ locked }] = await runner.query('SELECT pg_try_advisory_lock($1) AS locked', [BILLING_LOCK_KEY]);
      if (!locked) return { ...summary, skipped: 'Ya hay una ejecución en curso.' };
      try {
        summary.reminded = await this.sendReminders(asOf);
        const due = await this.subscriptions.find({
          where: { status: 'active', nextChargeDate: LessThanOrEqual(asOf) },
          order: { nextChargeDate: 'ASC' },
        });
        for (const subscription of due) {
          const outcome = await this.processDue(subscription, asOf);
          summary[outcome] += 1;
        }
      } finally {
        await runner.query('SELECT pg_advisory_unlock($1)', [BILLING_LOCK_KEY]);
      }
    } finally {
      await runner.release();
    }
    this.logger.log(`Cobro de suscripciones ${asOf}: ${JSON.stringify(summary)}`);
    return summary;
  }

  private async sendReminders(asOf: string) {
    const target = addDays(asOf, REMINDER_DAYS_BEFORE);
    const candidates = await this.subscriptions.find({ where: { status: 'active', nextChargeDate: target, retryCount: 0 } });
    let sent = 0;
    for (const subscription of candidates) {
      if (subscription.remindedFor === subscription.pendingPeriod) continue;
      const merchant = await this.requireMerchant(subscription.merchantCode);
      const card = await this.cards.findOne({ where: { id: subscription.cardId } });
      await this.dataSource.transaction(async (manager) => {
        subscription.remindedFor = subscription.pendingPeriod;
        await manager.save(subscription);
        await this.outbox.enqueue(manager, SUBSCRIPTION_EVENTS.upcoming, [
          this.eventPayload(subscription, merchant, card, { chargeDate: subscription.nextChargeDate }),
        ]);
      });
      sent += 1;
    }
    if (sent) void this.outbox.flush();
    return sent;
  }

  /** Intenta cobrar el periodo pendiente de una suscripción activa. */
  private async processDue(
    subscription: Subscription,
    asOf: string,
  ): Promise<'charged' | 'rejected' | 'suspended' | 'unavailable'> {
    const merchant = await this.requireMerchant(subscription.merchantCode);
    const card = await this.cards.findOne({ where: { id: subscription.cardId } });
    const result = await this.attemptCharge(subscription, merchant, card);

    if (result.kind === 'unavailable') {
      this.logger.warn(`Cobro de ${subscription.id} aplazado: ${result.reason}`);
      return 'unavailable';
    }
    if (result.kind === 'approved') {
      await this.recordSuccess(subscription, merchant, card as Card, result.transactionId);
      return 'charged';
    }
    return this.recordRejection(subscription, merchant, card, result.reason, asOf);
  }

  /**
   * Pasa por los controles de la tarjeta (una suscripción es una compra por
   * internet: congelada, compras por internet y límite diario) y pide el cobro
   * al ledger, que valida saldo y límites de la cuenta.
   */
  private async attemptCharge(subscription: Subscription, merchant: Merchant, card: Card | null): Promise<PaymentResult> {
    if (!card || card.userId !== subscription.userId) return { kind: 'rejected', reason: 'La tarjeta asociada ya no está disponible.' };
    if (!merchant.accountId) return { kind: 'unavailable', reason: 'La cuenta del comercio aún no está lista.' };
    const idempotencyKey = chargeKey(subscription.id, subscription.pendingPeriod);
    const authorized = await this.authorizations.authorize({
      cardId: card.id,
      userId: subscription.userId,
      amount: Number(subscription.amount),
      channel: 'online',
      source: 'subscription',
      merchantCode: merchant.code,
      merchantName: merchant.name,
      idempotencyKey,
    });
    if (authorized.kind === 'declined') return { kind: 'rejected', reason: authorized.reason };

    const result = await this.banking.pay({
      sourceAccountId: card.accountId,
      merchantAccountId: merchant.accountId,
      amount: Number(subscription.amount),
      idempotencyKey,
      description: `Suscripción ${merchant.name} · ${merchant.plan}`.slice(0, 140),
    });
    await this.authorizations.complete(authorized.authorization, result);
    return result;
  }

  private async recordSuccess(subscription: Subscription, merchant: Merchant, card: Card, transactionId: string) {
    const paidPeriod = subscription.pendingPeriod;
    const attempt = subscription.retryCount + 1;
    await this.dataSource.transaction(async (manager) => {
      // Si el cobro de este periodo ya quedó registrado (reentrega), no se duplica.
      const already = await manager.findOne(SubscriptionCharge, {
        where: { subscriptionId: subscription.id, period: paidPeriod, status: 'succeeded' },
      });
      if (!already) {
        await manager.save(manager.create(SubscriptionCharge, {
          subscriptionId: subscription.id,
          period: paidPeriod,
          attempt,
          status: 'succeeded',
          reason: null,
          amount: subscription.amount,
          currency: subscription.currency,
          ledgerTransactionId: transactionId,
        }));
      }
      subscription.status = 'active';
      subscription.lastChargedAt = new Date();
      subscription.retryCount = 0;
      subscription.pendingPeriod = nextPeriod(paidPeriod);
      subscription.nextChargeDate = dueDate(subscription.pendingPeriod, subscription.billingDay);
      await manager.save(subscription);
      if (!already) {
        await this.outbox.enqueue(manager, SUBSCRIPTION_EVENTS.charged, [
          this.eventPayload(subscription, merchant, card, { period: paidPeriod, transactionId }),
        ]);
      }
    });
    void this.outbox.flush();
  }

  private async recordRejection(
    subscription: Subscription,
    merchant: Merchant,
    card: Card | null,
    reason: string,
    asOf: string,
  ): Promise<'rejected' | 'suspended'> {
    const period = subscription.pendingPeriod;
    const attempt = subscription.retryCount + 1;
    const suspend = subscription.retryCount >= MAX_RETRIES;

    await this.dataSource.transaction(async (manager: EntityManager) => {
      await manager.save(manager.create(SubscriptionCharge, {
        subscriptionId: subscription.id,
        period,
        attempt,
        status: 'rejected',
        reason,
        amount: subscription.amount,
        currency: subscription.currency,
        ledgerTransactionId: null,
      }));
      const events: { key: string; payload: Record<string, unknown> }[] = [];
      if (suspend) {
        subscription.status = 'suspended';
        subscription.suspendedAt = new Date();
        events.push({ key: SUBSCRIPTION_EVENTS.rejected, payload: this.eventPayload(subscription, merchant, card, { period, reason, attempt, final: true }) });
        events.push({ key: SUBSCRIPTION_EVENTS.suspended, payload: this.eventPayload(subscription, merchant, card, { period, reason }) });
      } else {
        subscription.retryCount += 1;
        subscription.nextChargeDate = addDays(asOf, 1);
        events.push({
          key: SUBSCRIPTION_EVENTS.rejected,
          payload: this.eventPayload(subscription, merchant, card, {
            period,
            reason,
            attempt,
            final: false,
            nextAttemptDate: subscription.nextChargeDate,
            retriesLeft: MAX_RETRIES - subscription.retryCount + 1,
          }),
        });
      }
      await manager.save(subscription);
      for (const event of events) await this.outbox.enqueue(manager, event.key, [event.payload]);
    });
    void this.outbox.flush();
    return suspend ? 'suspended' : 'rejected';
  }

  // =====================================================
  // AUXILIARES
  // =====================================================

  private eventPayload(subscription: Subscription, merchant: Merchant, card: Card | null, extra: Record<string, unknown>) {
    return {
      idUser: subscription.userId,
      subscriptionId: subscription.id,
      merchantCode: merchant.code,
      merchantName: merchant.name,
      plan: merchant.plan,
      amount: Number(subscription.amount),
      currency: subscription.currency,
      cardLast4: card?.lastFour ?? null,
      nextChargeDate: subscription.status === 'active' ? subscription.nextChargeDate : null,
      ...extra,
    };
  }

  private async isPaid(subscriptionId: string, period: string) {
    return this.chargeRows.exist({ where: { subscriptionId, period, status: 'succeeded' } });
  }

  private async requireMerchant(code: string) {
    const merchant = await this.merchants.findByCode(code);
    if (!merchant) throw new NotFoundException(`Comercio ${code} no encontrado.`);
    return merchant;
  }

  private async findOwned(userId: string, id: string) {
    const subscription = await this.subscriptions.findOne({ where: { id } });
    if (!subscription || subscription.userId !== userId || subscription.status === 'pending') {
      throw new NotFoundException('Suscripción no encontrada.');
    }
    return subscription;
  }

  private async publicOne(subscription: Subscription) {
    return (await this.publicMany([subscription]))[0];
  }

  private async publicMany(subscriptions: Subscription[]) {
    const [merchants, cards] = await Promise.all([
      this.merchants.findAll(),
      subscriptions.length
        ? this.cards.find({ where: { id: In([...new Set(subscriptions.map((s) => s.cardId))]) } })
        : Promise.resolve([] as Card[]),
    ]);
    const merchantByCode = new Map(merchants.map((merchant) => [merchant.code, merchant]));
    const cardById = new Map(cards.map((card) => [card.id, card]));
    return subscriptions.map((subscription) => {
      const merchant = merchantByCode.get(subscription.merchantCode);
      const card = cardById.get(subscription.cardId);
      return {
        id: subscription.id,
        merchantCode: subscription.merchantCode,
        merchantName: merchant?.name ?? subscription.merchantCode,
        plan: merchant?.plan ?? '',
        amount: Number(subscription.amount),
        currency: subscription.currency,
        billingDay: subscription.billingDay,
        status: subscription.status,
        nextChargeDate: subscription.status === 'active' ? subscription.nextChargeDate : null,
        pendingPeriod: subscription.pendingPeriod,
        retryCount: subscription.retryCount,
        cardId: subscription.cardId,
        cardLast4: card?.lastFour ?? null,
        cardStatus: card?.status ?? null,
        lastChargedAt: subscription.lastChargedAt,
        pausedAt: subscription.pausedAt,
        suspendedAt: subscription.suspendedAt,
        cancelledAt: subscription.cancelledAt,
        createdAt: subscription.createdAt,
      };
    });
  }
}
