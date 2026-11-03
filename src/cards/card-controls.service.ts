import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { OutboxService } from '../events/outbox.service';
import { BankingClientService } from '../subscriptions/banking-client.service';
import { uuidV5 } from '../subscriptions/billing-dates';
import { currentMerchantName, PURCHASE_STORES } from '../subscriptions/catalog';
import { MerchantsService } from '../subscriptions/merchants.service';
import { AccountsClientService } from './accounts-client.service';
import { CARD_EVENTS, CardAuthorizationService, effectiveDailyLimit, formatCop } from './card-authorization.service';
import { DynamicKeyClientService } from './dynamic-key-client.service';
import { CardPurchaseDto, UpdateDailyLimitDto } from './dto/card-controls.dto';
import { CardAuthorization } from './entities/card-authorization.entity';
import { CardSettingsAudit } from './entities/card-settings-audit.entity';
import { Card } from './entities/card.entity';

/** Límite diario mínimo de compras; el máximo es el límite diario de la cuenta. */
export const MIN_DAILY_LIMIT = 100_000;

const CHANNEL_TEXT = { online: 'por internet', in_store: 'en tienda física' } as const;

/**
 * Controles de la tarjeta (compras por internet y límite diario) y la compra
 * simulada con la tarjeta, que se cobra de verdad en el ledger.
 */
@Injectable()
export class CardControlsService {
  private readonly logger = new Logger('CardControls');

  constructor(
    private readonly dataSource: DataSource,
    private readonly accounts: AccountsClientService,
    private readonly dynamicKeys: DynamicKeyClientService,
    private readonly authorizations: CardAuthorizationService,
    private readonly merchants: MerchantsService,
    private readonly banking: BankingClientService,
    private readonly outbox: OutboxService,
  ) {}

  /**
   * Sin el límite de la cuenta no se puede saber cuánto queda disponible de
   * verdad, así que si account-service no responde se devuelve 503 en lugar
   * de mostrar un "Disponible" mayor al real.
   */
  async get(cardId: string, userId: string) {
    const card = await this.findOwnedCard(cardId, userId);
    return this.publicControls(
      card,
      await this.authorizations.usedToday(card.id),
      await this.accounts.getAccountDailyLimit(card.accountId),
    );
  }

  async setOnline(cardId: string, userId: string, enabled: boolean) {
    const card = await this.findOwnedCard(cardId, userId);
    this.assertNotCancelled(card);
    // Antes de guardar: si account-service no responde, no queda un cambio a medias.
    const accountLimit = await this.accounts.getAccountDailyLimit(card.accountId);
    if (card.onlineEnabled !== enabled) {
      await this.saveChange(card, userId, 'online_enabled', String(card.onlineEnabled), String(enabled), {
        onlineEnabled: enabled,
      });
    }
    return this.publicControls(card, await this.authorizations.usedToday(card.id), accountLimit);
  }

  async setDailyLimit(cardId: string, userId: string, dto: UpdateDailyLimitDto) {
    const card = await this.findOwnedCard(cardId, userId);
    this.assertNotCancelled(card);
    const accountLimit = await this.accounts.getAccountDailyLimit(card.accountId);
    const { min, max } = this.range(accountLimit);
    if (dto.dailyLimit < min || dto.dailyLimit > max) {
      throw new BadRequestException(
        `El límite debe estar entre ${formatCop(min)} y ${formatCop(max)} (el límite diario de tu cuenta).`,
      );
    }
    await this.dynamicKeys.verify(userId, dto.dynamicCode);

    const current = Number(card.dailyLimit);
    if (current !== dto.dailyLimit) {
      await this.saveChange(card, userId, 'daily_limit', current.toFixed(0), String(dto.dailyLimit), {
        dailyLimit: dto.dailyLimit.toFixed(2),
      });
    }
    return this.publicControls(card, await this.authorizations.usedToday(card.id), accountLimit);
  }

  stores() {
    return PURCHASE_STORES.map((store) => ({ code: store.code, name: store.name, channels: store.channels }));
  }

  /**
   * Compra con la tarjeta: clave dinámica → controles de la tarjeta → cobro en
   * el ledger (saldo y límites de la cuenta). Un rechazo es una respuesta
   * normal (status 'declined' con su motivo), no un error.
   */
  async purchase(cardId: string, userId: string, dto: CardPurchaseDto) {
    const card = await this.findOwnedCard(cardId, userId);
    const store = PURCHASE_STORES.find((item) => item.code === dto.storeCode);
    if (!store) throw new NotFoundException('Ese comercio no está disponible.');
    if (!store.channels.includes(dto.channel)) {
      throw new BadRequestException(`${store.name} no recibe compras ${CHANNEL_TEXT[dto.channel]}.`);
    }
    const merchant = await this.merchants.findByCode(store.code);
    if (!merchant?.accountId)
      throw new ServiceUnavailableException(`${store.name} todavía no está disponible. Inténtalo en unos minutos.`);

    // La clave del ledger se deriva de la tarjeta + la del cliente: reenviar el mismo intento no cobra dos veces.
    const idempotencyKey = uuidV5(`card-purchase:${card.id}:${dto.idempotencyKey}`);
    const previous = await this.dataSource.getRepository(CardAuthorization).findOne({
      where: { idempotencyKey, status: 'approved' },
    });
    // Un doble clic ya cobrado devuelve la misma compra sin volver a pedir la clave.
    if (previous) return this.publicPurchase(previous, card);

    await this.dynamicKeys.verify(userId, dto.dynamicCode);

    const authorized = await this.authorizations.authorize({
      cardId: card.id,
      userId,
      amount: dto.amount,
      channel: dto.channel,
      source: 'purchase',
      merchantCode: store.code,
      merchantName: store.name,
      idempotencyKey,
    });
    if (authorized.kind === 'unavailable')
      throw new ServiceUnavailableException('No pudimos validar tu compra en este momento. Inténtalo de nuevo.');
    if (authorized.kind === 'declined') return this.publicPurchase(authorized.authorization, card);

    const result = await this.banking.pay({
      sourceAccountId: card.accountId,
      merchantAccountId: merchant.accountId,
      amount: dto.amount,
      idempotencyKey,
      description: `Compra ${CHANNEL_TEXT[dto.channel]} en ${store.name} · Tarjeta ····${card.lastFour}`.slice(0, 140),
    });
    await this.authorizations.complete(authorized.authorization, result);
    if (result.kind === 'unavailable') {
      throw new ServiceUnavailableException(
        'No pudimos confirmar la compra. Inténtalo de nuevo: no se cobrará dos veces.',
      );
    }
    return this.publicPurchase(authorized.authorization, card);
  }

  /** Guarda el cambio, su registro de auditoría y el aviso en la misma transacción. */
  private async saveChange(
    card: Card,
    userId: string,
    field: CardSettingsAudit['field'],
    oldValue: string,
    newValue: string,
    changes: Pick<Partial<Card>, 'onlineEnabled' | 'dailyLimit'>,
  ) {
    Object.assign(card, changes);
    await this.dataSource.transaction(async (manager) => {
      // Solo la columna que cambió, para no pisar un cambio simultáneo de la otra.
      await manager.update(Card, { id: card.id }, changes);
      await manager.save(manager.create(CardSettingsAudit, { cardId: card.id, userId, field, oldValue, newValue }));
      await this.outbox.enqueue(manager, CARD_EVENTS.controlsChanged, [
        {
          idUser: userId,
          cardId: card.id,
          cardLast4: card.lastFour,
          field,
          onlineEnabled: card.onlineEnabled,
          dailyLimit: Number(card.dailyLimit),
          currency: card.currency,
        },
      ]);
    });
    this.logger.log(`Tarjeta ${card.id}: ${field} ${oldValue} → ${newValue}`);
    void this.outbox.flush();
  }

  private range(accountLimit: number) {
    return { min: Math.min(MIN_DAILY_LIMIT, accountLimit), max: accountLimit };
  }

  /**
   * dailyLimit es el que se aplica: el menor entre el de la tarjeta y el de la
   * cuenta. cardDailyLimit es el que el cliente configuró en la tarjeta.
   */
  private publicControls(card: Card, usedToday: number, accountLimit: number) {
    const dailyLimit = effectiveDailyLimit(card, accountLimit);
    return {
      cardId: card.id,
      onlineEnabled: card.onlineEnabled,
      dailyLimit,
      cardDailyLimit: Number(card.dailyLimit),
      accountDailyLimit: accountLimit,
      cappedByAccount: Number(card.dailyLimit) > accountLimit,
      usedToday,
      availableToday: Math.max(dailyLimit - usedToday, 0),
      minLimit: this.range(accountLimit).min,
      maxLimit: accountLimit,
      currency: card.currency,
    };
  }

  private publicPurchase(authorization: CardAuthorization, card: Card) {
    return {
      id: authorization.id,
      status: authorization.status,
      reason: authorization.reason,
      storeCode: authorization.merchantCode,
      storeName: currentMerchantName(authorization.merchantCode, authorization.merchantName),
      channel: authorization.channel,
      amount: Number(authorization.amount),
      currency: authorization.currency,
      cardLast4: card.lastFour,
      transactionId: authorization.ledgerTransactionId,
      createdAt: authorization.createdAt,
    };
  }

  private async findOwnedCard(cardId: string, userId: string) {
    const card = await this.dataSource.getRepository(Card).findOne({ where: { id: cardId } });
    if (!card) throw new NotFoundException('Tarjeta no encontrada.');
    if (card.userId !== userId) throw new ForbiddenException('No puedes acceder a esta tarjeta.');
    return card;
  }

  private assertNotCancelled(card: Card) {
    if (card.status === 'cancelled') throw new ConflictException('La tarjeta fue cancelada.');
  }
}
