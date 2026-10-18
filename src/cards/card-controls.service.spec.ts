import { randomUUID } from 'crypto';
import { BadRequestException, ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { CardOutbox } from '../events/card-outbox.entity';
import { EventPublisherService } from '../events/event-publisher.service';
import { OutboxService } from '../events/outbox.service';
import { BankingClientService, PaymentResult } from '../subscriptions/banking-client.service';
import { Merchant } from '../subscriptions/entities/merchant.entity';
import { SubscriptionCharge } from '../subscriptions/entities/subscription-charge.entity';
import { Subscription } from '../subscriptions/entities/subscription.entity';
import { MerchantsService } from '../subscriptions/merchants.service';
import { createTestDatabase, describeWithDb, truncateAll } from '../testing/test-database';
import { AccountsClientService } from './accounts-client.service';
import { CardAuthorizationService } from './card-authorization.service';
import { CardControlsService, MIN_DAILY_LIMIT } from './card-controls.service';
import { DynamicKeyClientService } from './dynamic-key-client.service';
import { CardAuthorization } from './entities/card-authorization.entity';
import { CardSettingsAudit } from './entities/card-settings-audit.entity';
import { Card } from './entities/card.entity';

/**
 * Controles de la tarjeta contra PostgreSQL real (la reserva del cargo se hace
 * con un candado sobre la fila de la tarjeta). El ledger, account-service y la
 * clave dinámica se simulan.
 */
const ANA = '11111111-1111-4111-8111-111111111111';
const CARLOS = '22222222-2222-4222-8222-222222222222';
const DYNAMIC_KEY = '123456';

describeWithDb('Compras con tarjeta (PostgreSQL)', () => {
  let dataSource: DataSource;
  let drop: () => Promise<void>;
  let cards: Repository<Card>;
  let controls: CardControlsService;
  let accountDailyLimit: number;
  let card: Card;

  const accounts = {
    getAccountDailyLimit: jest.fn(async () => accountDailyLimit),
  };
  const dynamicKeys = {
    verify: jest.fn(async (_userId: string, code: string) => {
      if (code !== DYNAMIC_KEY) throw new BadRequestException('Clave dinámica incorrecta o vencida.');
    }),
  };
  const banking = {
    pay: jest.fn(async (): Promise<PaymentResult> => ({ kind: 'approved', transactionId: randomUUID() })),
  };

  beforeAll(async () => {
    ({ dataSource, drop } = await createTestDatabase('card', [
      Card,
      CardAuthorization,
      CardSettingsAudit,
      CardOutbox,
      Merchant,
      Subscription,
      SubscriptionCharge,
    ]));
    cards = dataSource.getRepository(Card);
    const outbox = new OutboxService(dataSource, { isReady: () => false } as unknown as EventPublisherService);
    const merchantRepo = dataSource.getRepository(Merchant);
    controls = new CardControlsService(
      dataSource,
      accounts as unknown as AccountsClientService,
      dynamicKeys as unknown as DynamicKeyClientService,
      new CardAuthorizationService(dataSource, outbox, accounts as unknown as AccountsClientService),
      { findByCode: (code: string) => merchantRepo.findOne({ where: { code } }) } as unknown as MerchantsService,
      banking as unknown as BankingClientService,
      outbox,
    );
  });

  afterAll(() => drop?.());

  beforeEach(async () => {
    await truncateAll(dataSource);
    jest.clearAllMocks();
    accountDailyLimit = 5_000_000;
    for (const code of ['tienda-exito', 'tienda-mercadolibre', 'tienda-juanvaldez']) {
      await dataSource.getRepository(Merchant).save({
        code,
        name: code,
        plan: 'Compra',
        price: '0.00',
        accountId: randomUUID(),
        accountNumber: '90000000001',
        currency: 'COP',
      } as Partial<Merchant>);
    }
    card = await cards.save(
      cards.create({
        accountId: randomUUID(),
        accountNumber: '10000000001',
        userId: ANA,
        encryptedPan: 'demo:no-revelable',
        lastFour: '0001',
        currency: 'COP',
        expiryMonth: 10,
        expiryYear: 2030,
        status: 'active',
        type: 'virtual',
        onlineEnabled: true,
        dailyLimit: '300000.00',
      }),
    );
  });

  const buy = (amount: number, channel: 'online' | 'in_store' = 'in_store', idempotencyKey = randomUUID()) =>
    controls.purchase(card.id, ANA, {
      storeCode: channel === 'online' ? 'tienda-mercadolibre' : 'tienda-exito',
      channel,
      amount,
      idempotencyKey,
      dynamicCode: DYNAMIC_KEY,
    });

  describe('tarjeta congelada', () => {
    it('rechaza el cargo sin llamar al ledger y deja el motivo', async () => {
      await cards.update(card.id, { status: 'frozen' });
      const result = await buy(10_000);
      expect(result).toMatchObject({ status: 'declined', reason: 'La tarjeta está congelada.' });
      expect(banking.pay).not.toHaveBeenCalled();
    });

    it('al descongelarla vuelve a comprar', async () => {
      await cards.update(card.id, { status: 'frozen' });
      await buy(10_000);
      await cards.update(card.id, { status: 'active' });
      await expect(buy(10_000)).resolves.toMatchObject({ status: 'approved' });
    });

    it('avisa del rechazo con el evento card.charge_declined', async () => {
      await cards.update(card.id, { status: 'frozen' });
      await buy(10_000);
      const events = await dataSource.getRepository(CardOutbox).find();
      expect(events.map((e) => e.routingKey)).toEqual(['card.charge_declined']);
    });
  });

  describe('compras por internet', () => {
    it('desactivadas: se rechaza la compra online pero no la de tienda física', async () => {
      await controls.setOnline(card.id, ANA, false);
      await expect(buy(10_000, 'online')).resolves.toMatchObject({
        status: 'declined',
        reason: 'Tienes desactivadas las compras por internet.',
      });
      await expect(buy(10_000, 'in_store')).resolves.toMatchObject({ status: 'approved' });
      expect(banking.pay).toHaveBeenCalledTimes(1);
    });

    it('el cambio del control queda en la auditoría de la tarjeta', async () => {
      await controls.setOnline(card.id, ANA, false);
      const audit = await dataSource.getRepository(CardSettingsAudit).find();
      expect(audit).toEqual([
        expect.objectContaining({ field: 'online_enabled', oldValue: 'true', newValue: 'false' }),
      ]);
    });

    it('un comercio que no vende por internet no acepta ese canal', async () => {
      await expect(
        controls.purchase(card.id, ANA, {
          storeCode: 'tienda-juanvaldez',
          channel: 'online',
          amount: 10_000,
          idempotencyKey: randomUUID(),
          dynamicCode: DYNAMIC_KEY,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('límite diario', () => {
    it('suma lo comprado hoy y rechaza lo que se pasa del límite', async () => {
      await expect(buy(200_000)).resolves.toMatchObject({ status: 'approved' });
      await expect(buy(100_001)).resolves.toMatchObject({ status: 'declined' });
      await expect(buy(100_000)).resolves.toMatchObject({ status: 'approved' });
      await expect(buy(1)).resolves.toMatchObject({ status: 'declined' });
      expect(banking.pay).toHaveBeenCalledTimes(2);
    });

    it('aplica el menor entre el límite de la tarjeta y el de la cuenta', async () => {
      accountDailyLimit = 150_000;
      await expect(buy(150_001)).resolves.toMatchObject({ status: 'declined' });
      await expect(buy(150_000)).resolves.toMatchObject({ status: 'approved' });
    });

    it('un cargo rechazado por el ledger no consume cupo', async () => {
      banking.pay.mockResolvedValueOnce({ kind: 'rejected', reason: 'Saldo insuficiente.' });
      await expect(buy(300_000)).resolves.toMatchObject({ status: 'declined', reason: 'Saldo insuficiente.' });
      await expect(buy(300_000)).resolves.toMatchObject({ status: 'approved' });
    });

    it('compras simultáneas no se pasan juntas del límite', async () => {
      const results = await Promise.all(Array.from({ length: 6 }, () => buy(100_000)));
      expect(results.filter((r) => r.status === 'approved')).toHaveLength(3);
      expect(banking.pay).toHaveBeenCalledTimes(3);
    });

    it('el nuevo límite debe estar entre el mínimo y el límite de la cuenta, y exige la clave dinámica', async () => {
      const set = (dailyLimit: number, dynamicCode = DYNAMIC_KEY) =>
        controls.setDailyLimit(card.id, ANA, { dailyLimit, dynamicCode });
      await expect(set(MIN_DAILY_LIMIT - 1)).rejects.toBeInstanceOf(BadRequestException);
      await expect(set(accountDailyLimit + 1)).rejects.toBeInstanceOf(BadRequestException);
      await expect(set(1_000_000, '000000')).rejects.toBeInstanceOf(BadRequestException);
      await expect(set(1_000_000)).resolves.toMatchObject({ cardDailyLimit: 1_000_000 });
    });
  });

  describe('cobro e idempotencia', () => {
    it('reenviar la misma compra no cobra dos veces', async () => {
      const key = randomUUID();
      const first = await buy(50_000, 'in_store', key);
      const second = await buy(50_000, 'in_store', key);
      expect(second.id).toBe(first.id);
      expect(banking.pay).toHaveBeenCalledTimes(1);
    });

    it('si el ledger no responde, el reintento usa la misma clave del ledger', async () => {
      const key = randomUUID();
      banking.pay.mockResolvedValueOnce({ kind: 'unavailable', reason: 'Ledger caído' });
      await expect(buy(50_000, 'in_store', key)).rejects.toBeInstanceOf(ServiceUnavailableException);
      await expect(buy(50_000, 'in_store', key)).resolves.toMatchObject({ status: 'approved' });
      const keys = banking.pay.mock.calls.map(
        (call: unknown[]) => (call[0] as { idempotencyKey: string }).idempotencyKey,
      );
      expect(keys).toHaveLength(2);
      expect(new Set(keys).size).toBe(1);
    });

    it('sin clave dinámica válida no hay cargo', async () => {
      await expect(
        controls.purchase(card.id, ANA, {
          storeCode: 'tienda-exito',
          channel: 'in_store',
          amount: 10_000,
          idempotencyKey: randomUUID(),
          dynamicCode: '000000',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(await dataSource.getRepository(CardAuthorization).count()).toBe(0);
    });

    it('nadie compra con una tarjeta ajena', async () => {
      await expect(
        controls.purchase(card.id, CARLOS, {
          storeCode: 'tienda-exito',
          channel: 'in_store',
          amount: 10_000,
          idempotencyKey: randomUUID(),
          dynamicCode: DYNAMIC_KEY,
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});
