import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { DataSource, EntityManager, In } from 'typeorm';
import { OutboxService } from '../events/outbox.service';
import { PaymentResult } from '../subscriptions/banking-client.service';
import { bogotaToday } from '../subscriptions/billing-dates';
import { AccountsClientService } from './accounts-client.service';
import { CardAuthorization, CardChannel, CardChargeSource } from './entities/card-authorization.entity';
import { Card } from './entities/card.entity';

export const CARD_EVENTS = {
  controlsChanged: 'card.controls_changed',
  chargeDeclined: 'card.charge_declined',
} as const;

export interface ChargeRequest {
  cardId: string;
  userId: string;
  amount: number;
  channel: CardChannel;
  source: CardChargeSource;
  merchantCode: string;
  merchantName: string;
  idempotencyKey: string;
}

export type AuthorizationResult =
  | { kind: 'reserved'; authorization: CardAuthorization }
  | { kind: 'declined'; reason: string; authorization: CardAuthorization }
  // No se pudo consultar el límite de la cuenta: no se cobra y se puede reintentar.
  | { kind: 'unavailable'; reason: string };

/**
 * Límite que se aplica de verdad: el menor entre el de la tarjeta y el límite
 * diario de la cuenta (una tarjeta anterior puede tener $5.000.000 aunque su
 * cuenta permita menos).
 */
export const effectiveDailyLimit = (card: Card, accountDailyLimit: number) =>
  Math.min(Number(card.dailyLimit), accountDailyLimit);

export const formatCop = (value: number) =>
  `$ ${Math.round(value).toLocaleString('es-CO', { maximumFractionDigits: 0 })}`;

/**
 * Controles de la tarjeta para CUALQUIER cargo (compras y suscripciones), en
 * este orden: congelada → compra por internet desactivada → límite diario
 * (lo usado hoy en hora de Colombia + el monto, contra el menor entre el
 * límite de la tarjeta y el de la cuenta) → saldo (lo valida el ledger).
 *
 * El cargo se reserva como 'pending' bajo un candado de la fila de la tarjeta,
 * así dos cargos simultáneos no pueden pasarse juntos del límite. Después de
 * llamar al ledger, complete() lo deja aprobado, rechazado o en error.
 */
@Injectable()
export class CardAuthorizationService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly outbox: OutboxService,
    private readonly accounts: AccountsClientService,
  ) {}

  async authorize(request: ChargeRequest): Promise<AuthorizationResult> {
    // Fuera de la transacción: no se hace una llamada HTTP con la fila bloqueada.
    let accountDailyLimit: number | null = null;
    const owner = await this.dataSource.getRepository(Card).findOne({ where: { id: request.cardId } });
    if (owner) {
      try {
        accountDailyLimit = await this.accounts.getAccountDailyLimit(owner.accountId);
      } catch (error) {
        if (!(error instanceof ServiceUnavailableException)) throw error;
        return { kind: 'unavailable', reason: error.message };
      }
    }

    const result = await this.dataSource.transaction(async (manager) => {
      const card = await manager.findOne(Card, { where: { id: request.cardId }, lock: { mode: 'pessimistic_write' } });

      // Reintento con la misma clave: se reusa la reserva o el cargo ya aprobado.
      const live = await manager.findOne(CardAuthorization, {
        where: { idempotencyKey: request.idempotencyKey, status: In(['pending', 'approved']) },
      });
      if (live && live.cardId === request.cardId) return { kind: 'reserved' as const, authorization: live };

      const today = bogotaToday();
      const reason = await this.declineReason(manager, card, request, today, accountDailyLimit);
      const authorization = manager.create(CardAuthorization, {
        cardId: request.cardId,
        userId: request.userId,
        amount: request.amount.toFixed(2),
        currency: card?.currency ?? 'COP',
        channel: request.channel,
        source: request.source,
        merchantCode: request.merchantCode,
        merchantName: request.merchantName.slice(0, 80),
        status: reason ? 'declined' : 'pending',
        reason,
        idempotencyKey: request.idempotencyKey,
        ledgerTransactionId: null,
        bogotaDate: today,
      });
      await manager.save(authorization);
      if (reason) {
        await this.enqueueDeclined(manager, authorization, card);
        return { kind: 'declined' as const, reason, authorization };
      }
      return { kind: 'reserved' as const, authorization };
    });
    if (result.kind === 'declined') void this.outbox.flush();
    return result;
  }

  /** Registra lo que respondió el ledger para un cargo reservado. */
  async complete(authorization: CardAuthorization, result: PaymentResult) {
    if (authorization.status === 'approved') return;
    if (result.kind === 'approved') {
      await this.dataSource.getRepository(CardAuthorization).update(
        { id: authorization.id },
        { status: 'approved', reason: null, ledgerTransactionId: result.transactionId },
      );
      authorization.status = 'approved';
      authorization.ledgerTransactionId = result.transactionId;
      return;
    }
    if (result.kind === 'unavailable') {
      // No cuenta en el límite; el reintento usa la misma clave y el ledger no duplica.
      await this.dataSource.getRepository(CardAuthorization).update(
        { id: authorization.id },
        { status: 'error', reason: result.reason.slice(0, 200) },
      );
      authorization.status = 'error';
      return;
    }
    await this.dataSource.transaction(async (manager) => {
      await manager.update(CardAuthorization, { id: authorization.id }, { status: 'declined', reason: result.reason.slice(0, 200) });
      authorization.status = 'declined';
      authorization.reason = result.reason.slice(0, 200);
      const card = await manager.findOne(Card, { where: { id: authorization.cardId } });
      await this.enqueueDeclined(manager, authorization, card);
    });
    void this.outbox.flush();
  }

  /** Lo cargado hoy (hora de Colombia) a la tarjeta: aprobado más lo que está en curso. */
  async usedToday(cardId: string, manager: EntityManager = this.dataSource.manager, today = bogotaToday()) {
    const [row] = await manager.query(
      `SELECT COALESCE(SUM(amount), 0) AS total FROM card_authorizations
        WHERE card_id = $1 AND bogota_date = $2 AND status IN ('pending', 'approved')`,
      [cardId, today],
    );
    return Number(row.total);
  }

  private async declineReason(
    manager: EntityManager,
    card: Card | null,
    request: ChargeRequest,
    today: string,
    accountDailyLimit: number | null,
  ) {
    if (!card || card.userId !== request.userId) return 'La tarjeta asociada ya no está disponible.';
    if (card.status !== 'active') return 'La tarjeta está congelada.';
    if (request.channel === 'online' && !card.onlineEnabled) return 'Tienes desactivadas las compras por internet.';
    const used = await this.usedToday(card.id, manager, today);
    const limit = accountDailyLimit === null ? Number(card.dailyLimit) : effectiveDailyLimit(card, accountDailyLimit);
    if (used + request.amount > limit) {
      return `Supera tu límite diario de compras. Hoy te quedan ${formatCop(Math.max(limit - used, 0))}.`;
    }
    return null;
  }

  /**
   * Aviso de compra rechazada. Los cobros de suscripciones ya avisan con
   * subscription.charge_rejected, así que aquí solo van las compras.
   */
  private async enqueueDeclined(manager: EntityManager, authorization: CardAuthorization, card: Card | null) {
    if (authorization.source !== 'purchase') return;
    await this.outbox.enqueue(manager, CARD_EVENTS.chargeDeclined, [{
      idUser: authorization.userId,
      cardId: authorization.cardId,
      cardLast4: card?.lastFour ?? null,
      merchantName: authorization.merchantName,
      channel: authorization.channel,
      amount: Number(authorization.amount),
      currency: authorization.currency,
      reason: authorization.reason,
    }]);
  }
}
