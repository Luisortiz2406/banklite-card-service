import { randomUUID } from 'crypto';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InternalKeyGuard } from '../common/guards/internal-key.guard';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { StaffAuthGuard } from '../common/staff/staff-auth.guard';
import { bogotaToday } from '../subscriptions/billing-dates';
import { InternalSubscriptionsController, SubscriptionsController } from '../subscriptions/subscriptions.controller';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { ANA, CARLOS, createCardFixture } from '../testing/card-fixture';
import { describeWithDb, truncateAll } from '../testing/test-database';
import { AdminCardsController } from './admin-cards.controller';
import { CardControlsController } from './card-controls.controller';
import { CardControlsService } from './card-controls.service';
import { CardsController } from './cards.controller';
import { CardsService } from './cards.service';

const request = { user: { idUser: 'user-1' }, accessToken: 'token-1' } as never;
const guardsOf = (controller: object) => Reflect.getMetadata('__guards__', controller) ?? [];

describe('CardsController', () => {
  const service = {
    list: jest.fn().mockResolvedValue(['c1']),
    issue: jest.fn().mockResolvedValue({ id: 'c1' }),
    reveal: jest.fn().mockResolvedValue({ cardNumber: '4111' }),
    updateStatus: jest.fn().mockResolvedValue({ status: 'frozen' }),
  };
  const controller = new CardsController(service as unknown as CardsService);

  it('exige sesión del cliente y siempre usa al cliente de la sesión (y su token para consultar la cuenta)', async () => {
    expect(guardsOf(CardsController)).toContain(JwtAuthGuard);

    expect(await controller.list(request)).toEqual(['c1']);
    expect(service.list).toHaveBeenCalledWith('user-1');
    await controller.issue({ accountId: 'a1' } as never, request);
    expect(service.issue).toHaveBeenCalledWith({ accountId: 'a1' }, 'user-1', 'token-1');
    await controller.reveal('c1', request);
    expect(service.reveal).toHaveBeenCalledWith('c1', 'user-1');
    await controller.updateStatus('c1', { status: 'frozen' } as never, request);
    expect(service.updateStatus).toHaveBeenCalledWith('c1', { status: 'frozen' }, 'user-1');
  });
});

describe('CardControlsController', () => {
  const service = {
    stores: jest.fn().mockResolvedValue([]),
    get: jest.fn().mockResolvedValue({ dailyLimit: 1 }),
    setOnline: jest.fn().mockResolvedValue({ onlineEnabled: false }),
    setDailyLimit: jest.fn().mockResolvedValue({ dailyLimit: 2 }),
    purchase: jest.fn().mockResolvedValue({ status: 'approved' }),
  };
  const controller = new CardControlsController(service as unknown as CardControlsService);

  it('exige sesión y pasa al servicio la tarjeta, el cliente de la sesión y el cuerpo', async () => {
    expect(guardsOf(CardControlsController)).toContain(JwtAuthGuard);

    await controller.stores();
    await controller.get('c1', request);
    expect(service.get).toHaveBeenCalledWith('c1', 'user-1');
    await controller.setOnline('c1', { enabled: false } as never, request);
    expect(service.setOnline).toHaveBeenCalledWith('c1', 'user-1', false);
    const limit = { dailyLimit: 1_000_000, dynamicCode: '123456' } as never;
    await controller.setDailyLimit('c1', limit, request);
    expect(service.setDailyLimit).toHaveBeenCalledWith('c1', 'user-1', limit);
    const purchase = { storeCode: 'tienda-exito', amount: 1000 } as never;
    await controller.purchase('c1', purchase, request);
    expect(service.purchase).toHaveBeenCalledWith('c1', 'user-1', purchase);
  });
});

describe('SubscriptionsController', () => {
  const service = {
    catalog: jest.fn().mockResolvedValue([]),
    list: jest.fn().mockResolvedValue({ items: [] }),
    enroll: jest.fn().mockResolvedValue({ id: 's1' }),
    charges: jest.fn().mockResolvedValue([]),
    pause: jest.fn().mockResolvedValue({ status: 'paused' }),
    resume: jest.fn().mockResolvedValue({ status: 'active' }),
    cancel: jest.fn().mockResolvedValue({ status: 'cancelled' }),
    runBilling: jest.fn().mockResolvedValue({ charged: 0 }),
  };
  const controller = new SubscriptionsController(service as unknown as SubscriptionsService);

  it('exige sesión y cada acción es del cliente de la sesión', async () => {
    expect(guardsOf(SubscriptionsController)).toContain(JwtAuthGuard);

    await controller.catalog();
    await controller.list(request);
    expect(service.list).toHaveBeenCalledWith('user-1');
    const dto = { merchantCode: 'netflix', cardId: 'c1' } as never;
    await controller.enroll(dto, request);
    expect(service.enroll).toHaveBeenCalledWith('user-1', dto);
    await controller.charges('s1', request);
    await controller.pause('s1', request);
    await controller.resume('s1', request);
    await controller.cancel('s1', request);
    for (const method of ['charges', 'pause', 'resume', 'cancel'] as const) {
      expect(service[method]).toHaveBeenCalledWith('user-1', 's1');
    }
  });

  describe('cobro a demanda (red interna)', () => {
    // ConfigService lee primero process.env: se fija ahí (con set) y se restaura al terminar cada prueba.
    const internal = (env: Record<string, string> = {}) => {
      process.env.NODE_ENV = 'test';
      delete process.env.ALLOW_BILLING_DATE_OVERRIDE;
      const config = new ConfigService();
      for (const [key, value] of Object.entries(env)) config.set(key, value);
      return new InternalSubscriptionsController(service as unknown as SubscriptionsService, config);
    };
    afterEach(() => {
      process.env.NODE_ENV = 'test';
      delete process.env.ALLOW_BILLING_DATE_OVERRIDE;
    });

    it('exige la clave interna', () => {
      expect(guardsOf(InternalSubscriptionsController)).toContain(InternalKeyGuard);
    });

    it('sin fecha, o con la de hoy, cobra hoy', async () => {
      await internal().runBilling({});
      await internal().runBilling({ date: bogotaToday() });

      expect(service.runBilling).toHaveBeenNthCalledWith(1, bogotaToday());
      expect(service.runBilling).toHaveBeenNthCalledWith(2, bogotaToday());
    });

    it('otra fecha se rechaza (nadie cobra meses por adelantado), también si el flag queda activado en producción', () => {
      service.runBilling.mockClear();
      const other = { date: '2030-01-15' };

      expect(() => internal().runBilling(other)).toThrow(ForbiddenException);
      expect(() => internal({ ALLOW_BILLING_DATE_OVERRIDE: 'true', NODE_ENV: 'production' }).runBilling(other)).toThrow(
        ForbiddenException,
      );
      expect(() => internal({ NODE_ENV: 'development' }).runBilling(other)).toThrow(ForbiddenException);
      expect(service.runBilling).not.toHaveBeenCalled();
    });

    it('con el flag y fuera de producción se acepta otra fecha válida, pero no una inválida', async () => {
      const env = { ALLOW_BILLING_DATE_OVERRIDE: 'true', NODE_ENV: 'development' };

      await internal(env).runBilling({ date: '2030-01-15' });
      expect(service.runBilling).toHaveBeenCalledWith('2030-01-15');
      expect(() => internal(env).runBilling({ date: '2030-02-31' })).toThrow(BadRequestException);
    });
  });
});

describeWithDb('AdminCardsController (PostgreSQL)', () => {
  let fx: Awaited<ReturnType<typeof createCardFixture>>;
  let controller: AdminCardsController;

  beforeAll(async () => {
    fx = await createCardFixture();
    controller = new AdminCardsController(fx.cards, fx.authorizationRepo);
  });
  afterAll(() => fx?.drop());
  beforeEach(() => truncateAll(fx.dataSource));

  it('solo lo ve el personal con rol de soporte, cumplimiento o administración', () => {
    expect(guardsOf(AdminCardsController)).toContain(StaffAuthGuard);
    expect(Reflect.getMetadata('staffRoles', AdminCardsController)).toEqual(['support', 'compliance', 'admin']);
  });

  it('lista las tarjetas con los últimos 4 dígitos, el vencimiento y cuántos cargos se rechazaron; nunca el número', async () => {
    const ana = await fx.addCard(ANA, { lastFour: '1111', expiryMonth: 3, expiryYear: 2030 });
    const carlos = await fx.addCard(CARLOS, { lastFour: '2222' });
    await fx.authorizations.authorize({
      cardId: ana.id,
      userId: ANA,
      amount: 10_000_000, // pasa el límite diario: rechazado
      channel: 'online',
      source: 'purchase',
      merchantCode: 'tienda-exito',
      merchantName: 'Tienda',
      idempotencyKey: randomUUID(),
    });

    const all = await controller.list({});
    expect(all.total).toBe(2);
    const row = all.items.find((item) => item.id === ana.id)!;
    expect(row).toMatchObject({ lastFour: '1111', expiry: '03/30', declinedCount: 1, userId: ANA });
    expect(all.items.find((item) => item.id === carlos.id)!.declinedCount).toBe(0);
    expect(JSON.stringify(all)).not.toMatch(/pan|encrypted|cardNumber/i);

    expect((await controller.list({ userId: CARLOS })).items.map((item) => item.id)).toEqual([carlos.id]);
    expect((await controller.list({ accountId: ana.accountId })).total).toBe(1);
    expect((await controller.list({ page: 2, limit: 1 })).items).toHaveLength(1);
  });

  it('el detalle de rechazos trae comercio, monto, canal y motivo; una tarjeta inexistente da 404', async () => {
    const card = await fx.addCard(ANA);
    await fx.authorizations.authorize({
      cardId: card.id,
      userId: ANA,
      amount: 10_000_000,
      channel: 'online',
      source: 'purchase',
      merchantCode: 'tienda-exito',
      merchantName: 'Tienda Exito',
      idempotencyKey: randomUUID(),
    });

    const detail = await controller.declines(card.id);

    expect(detail.card).toMatchObject({ id: card.id, lastFour: '4242', status: 'active' });
    expect(detail.items).toEqual([
      expect.objectContaining({
        amount: 10_000_000,
        channel: 'online',
        reason: expect.stringContaining('límite diario'),
      }),
    ]);
    await expect(controller.declines(randomUUID())).rejects.toBeInstanceOf(NotFoundException);
    expect((await controller.list({})).items).toHaveLength(1);
  });
});
