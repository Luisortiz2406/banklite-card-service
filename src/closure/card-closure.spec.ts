import { randomUUID } from 'crypto';
import { ConflictException } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { AccountsClientService } from '../cards/accounts-client.service';
import { CardAuthorizationService } from '../cards/card-authorization.service';
import { CardControlsService } from '../cards/card-controls.service';
import { CardCryptoService } from '../cards/card-crypto.service';
import { CardsService } from '../cards/cards.service';
import { DynamicKeyClientService } from '../cards/dynamic-key-client.service';
import { CardAuthorization } from '../cards/entities/card-authorization.entity';
import { CardSettingsAudit } from '../cards/entities/card-settings-audit.entity';
import { Card } from '../cards/entities/card.entity';
import { CardOutbox } from '../events/card-outbox.entity';
import { EventPublisherService } from '../events/event-publisher.service';
import { OutboxService } from '../events/outbox.service';
import { BankingClientService } from '../subscriptions/banking-client.service';
import { Merchant } from '../subscriptions/entities/merchant.entity';
import { SubscriptionCharge } from '../subscriptions/entities/subscription-charge.entity';
import { Subscription } from '../subscriptions/entities/subscription.entity';
import { MerchantsService } from '../subscriptions/merchants.service';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { createTestDatabase, describeWithDb, truncateAll } from '../testing/test-database';
import { CardClosureService } from './card-closure.service';

const ANA = '11111111-1111-4111-8111-111111111111';
const CARLOS = '22222222-2222-4222-8222-222222222222';
const DYNAMIC_KEY = '123456';

/** Cuenta cancelada (account.closed): tarjetas y suscripciones del cliente quedan canceladas. */
describeWithDb('Cierre de cuenta en card-service (PostgreSQL)', () => {
  let dataSource: DataSource;
  let drop: () => Promise<void>;
  let cards: Repository<Card>;
  let subscriptions: Repository<Subscription>;
  let closure: CardClosureService;
  let cardsService: CardsService;
  let controls: CardControlsService;
  let subscriptionsService: SubscriptionsService;
  const accounts = { getAccountDailyLimit: jest.fn(async () => 5_000_000) };
  const banking = { pay: jest.fn() };

  beforeAll(async () => {
    ({ dataSource, drop } = await createTestDatabase('card_cierre', [
      Card,
      CardAuthorization,
      CardSettingsAudit,
      CardOutbox,
      Merchant,
      Subscription,
      SubscriptionCharge,
    ]));
    cards = dataSource.getRepository(Card);
    subscriptions = dataSource.getRepository(Subscription);
    closure = new CardClosureService(dataSource);
    const outbox = new OutboxService(dataSource, { isReady: () => false } as unknown as EventPublisherService);
    const merchants = {
      findByCode: (code: string) => dataSource.getRepository(Merchant).findOne({ where: { code } }),
    } as unknown as MerchantsService;
    const authorizations = new CardAuthorizationService(
      dataSource,
      outbox,
      accounts as unknown as AccountsClientService,
    );
    cardsService = new CardsService(cards, accounts as unknown as AccountsClientService, {} as CardCryptoService);
    controls = new CardControlsService(
      dataSource,
      accounts as unknown as AccountsClientService,
      { verify: jest.fn(async () => undefined) } as unknown as DynamicKeyClientService,
      authorizations,
      merchants,
      banking as unknown as BankingClientService,
      outbox,
    );
    subscriptionsService = new SubscriptionsService(
      dataSource,
      subscriptions,
      dataSource.getRepository(SubscriptionCharge),
      cards,
      merchants,
      banking as unknown as BankingClientService,
      outbox,
      authorizations,
    );
  });
  afterAll(() => drop?.());
  beforeEach(async () => {
    await truncateAll(dataSource);
    jest.clearAllMocks();
    await dataSource.getRepository(Merchant).save({
      code: 'tienda-exito',
      name: 'Éxito',
      plan: 'Compra',
      price: '0.00',
      accountId: randomUUID(),
      accountNumber: '90000000001',
      currency: 'COP',
    } as Partial<Merchant>);
  });

  const newCard = (userId: string, status: Card['status'] = 'active') =>
    cards.save(
      cards.create({
        accountId: randomUUID(),
        accountNumber: '10000000001',
        userId,
        encryptedPan: 'demo:no-revelable',
        lastFour: '0001',
        currency: 'COP',
        expiryMonth: 10,
        expiryYear: 2030,
        status,
        type: 'virtual',
        onlineEnabled: true,
        dailyLimit: '300000.00',
      }),
    );

  const newSubscription = (userId: string, cardId: string, status: Subscription['status'], merchantCode: string) =>
    subscriptions.save(
      subscriptions.create({
        id: randomUUID(),
        userId,
        cardId,
        merchantCode,
        amount: '26900.00',
        currency: 'COP',
        billingDay: 5,
        status,
        pendingPeriod: '2026-11',
        nextChargeDate: '2026-11-05',
        retryCount: 0,
      }),
    );

  it('cancela todas las tarjetas y suscripciones del cliente, y no toca las de otros', async () => {
    const activa = await newCard(ANA);
    const congelada = await newCard(ANA, 'frozen');
    const deCarlos = await newCard(CARLOS);
    await newSubscription(ANA, activa.id, 'active', 'netflix');
    await newSubscription(ANA, activa.id, 'paused', 'spotify');
    await newSubscription(CARLOS, deCarlos.id, 'active', 'netflix');

    const fecha = '2026-10-26T15:00:00.000Z';
    expect(await closure.handleAccountClosed({ idUser: ANA, cerradaEn: fecha })).toEqual({
      tarjetas: 2,
      suscripciones: 2,
    });

    for (const id of [activa.id, congelada.id]) {
      expect(await cards.findOneByOrFail({ id })).toMatchObject({ status: 'cancelled', cancelledAt: new Date(fecha) });
    }
    expect(await subscriptions.find({ where: { userId: ANA } })).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: 'cancelled', cancelledAt: new Date(fecha) })]),
    );
    expect((await subscriptions.find({ where: { userId: ANA, status: 'cancelled' } })).length).toBe(2);
    expect((await cards.findOneByOrFail({ id: deCarlos.id })).status).toBe('active');
    expect((await subscriptions.findOneByOrFail({ userId: CARLOS })).status).toBe('active');
  });

  it('procesar el evento dos veces es inofensivo: conserva la primera fecha', async () => {
    const card = await newCard(ANA);
    await closure.handleAccountClosed({ idUser: ANA, cerradaEn: '2026-10-26T15:00:00.000Z' });
    expect(await closure.handleAccountClosed({ idUser: ANA, cerradaEn: '2026-10-27T15:00:00.000Z' })).toEqual({
      tarjetas: 0,
      suscripciones: 0,
    });
    expect((await cards.findOneByOrFail({ id: card.id })).cancelledAt).toEqual(new Date('2026-10-26T15:00:00.000Z'));
  });

  it('una tarjeta cancelada no se reactiva, no se revela, no cambia sus controles y rechaza las compras', async () => {
    const card = await newCard(ANA);
    await closure.handleAccountClosed({ idUser: ANA });

    await expect(cardsService.updateStatus(card.id, { status: 'active' }, ANA)).rejects.toBeInstanceOf(
      ConflictException,
    );
    await expect(cardsService.reveal(card.id, ANA)).rejects.toBeInstanceOf(ConflictException);
    await expect(controls.setOnline(card.id, ANA, false)).rejects.toBeInstanceOf(ConflictException);
    await expect(
      controls.setDailyLimit(card.id, ANA, { dailyLimit: 100_000, dynamicCode: DYNAMIC_KEY }),
    ).rejects.toBeInstanceOf(ConflictException);
    const result = await controls.purchase(card.id, ANA, {
      storeCode: 'tienda-exito',
      channel: 'in_store',
      amount: 10_000,
      idempotencyKey: randomUUID(),
      dynamicCode: DYNAMIC_KEY,
    });
    expect(result).toMatchObject({ status: 'declined', reason: 'La tarjeta fue cancelada.' });
    expect(banking.pay).not.toHaveBeenCalled();
    expect((await cards.findOneByOrFail({ id: card.id })).status).toBe('cancelled');
  });

  it('un cobro que termina después del cierre no revive la suscripción', async () => {
    const card = await newCard(ANA);
    const stale = await newSubscription(ANA, card.id, 'active', 'netflix');
    await closure.handleAccountClosed({ idUser: ANA });

    // El cobro arrancó con la fila aún activa (copia vieja en memoria).
    const merchant = { code: 'netflix', name: 'Netflix', plan: 'Básico' } as Merchant;
    await (subscriptionsService as any).recordSuccess(stale, merchant, card, randomUUID());
    expect((await subscriptions.findOneByOrFail({ id: stale.id })).status).toBe('cancelled');

    const stale2 = await newSubscription(ANA, card.id, 'active', 'spotify');
    await closure.handleAccountClosed({ idUser: ANA });
    stale2.retryCount = 3;
    expect(await (subscriptionsService as any).recordRejection(stale2, merchant, card, 'Sin saldo', '2026-11-05')).toBe(
      'rejected',
    );
    expect((await subscriptions.findOneByOrFail({ id: stale2.id })).status).toBe('cancelled');
    expect(await dataSource.getRepository(CardOutbox).count({ where: { routingKey: 'subscription.suspended' } })).toBe(
      0,
    );
  });
});
