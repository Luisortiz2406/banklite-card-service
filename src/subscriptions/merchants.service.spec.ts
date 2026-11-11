import { Repository } from 'typeorm';
import { BankingClientService } from './banking-client.service';
import { PURCHASE_STORES, SUBSCRIPTION_CATALOG } from './catalog';
import { Merchant } from './entities/merchant.entity';
import { MerchantsService } from './merchants.service';
import { SubscriptionsScheduler } from './subscriptions.scheduler';
import { SubscriptionsService } from './subscriptions.service';

describe('MerchantsService', () => {
  const merchant = (code: string, accountId: string | null = null) =>
    ({ code, name: `Comercio ${code}`, currency: 'COP', accountId, accountNumber: null }) as Merchant;
  const setup = (rows: Merchant[]) => {
    const repo = {
      upsert: jest.fn().mockResolvedValue(undefined),
      find: jest.fn().mockImplementation(async () => rows),
      update: jest.fn().mockResolvedValue(undefined),
      findOne: jest.fn().mockResolvedValue(rows[0]),
    };
    const banking = {
      ensureMerchantAccount: jest.fn().mockImplementation(async (code: string) => ({
        id: `cuenta-${code}`,
        accountNumber: '90000000001',
      })),
    };
    const service = new MerchantsService(
      repo as unknown as Repository<Merchant>,
      banking as unknown as BankingClientService,
    );
    return { service, repo, banking };
  };

  afterEach(() => jest.useRealTimers());

  it('al arrancar sincroniza el catálogo de suscripciones y las tiendas de compras, y pide las cuentas que faltan', async () => {
    const { service, repo } = setup([]);
    jest.spyOn(service, 'ensureAccounts').mockResolvedValue(true);

    await service.onApplicationBootstrap();

    const [subscriptions] = repo.upsert.mock.calls[0];
    const [stores] = repo.upsert.mock.calls[1];
    expect(subscriptions).toHaveLength(SUBSCRIPTION_CATALOG.length);
    expect(subscriptions[0]).toMatchObject({ code: SUBSCRIPTION_CATALOG[0].code, currency: 'COP' });
    expect(stores).toHaveLength(PURCHASE_STORES.length);
    expect(stores[0]).toMatchObject({ plan: 'Compras con tarjeta', price: '0.00' });
    expect(repo.upsert.mock.calls.every((call) => call[1][0] === 'code')).toBe(true);
    expect(service.ensureAccounts).toHaveBeenCalledTimes(1);
  });

  it('crea la cuenta solo de los comercios que no la tienen', async () => {
    const { service, repo, banking } = setup([merchant('a', 'ya-tiene'), merchant('b'), merchant('c')]);

    expect(await service.ensureAccounts()).toBe(true);

    expect(banking.ensureMerchantAccount).toHaveBeenCalledTimes(2);
    expect(repo.update).toHaveBeenCalledWith('b', { accountId: 'cuenta-b', accountNumber: '90000000001' });
    expect(repo.update).toHaveBeenCalledWith('c', { accountId: 'cuenta-c', accountNumber: '90000000001' });
  });

  it('si account-service no está listo, reintenta en 30 s; cerrar el módulo cancela el reintento', async () => {
    jest.useFakeTimers();
    const { service, banking } = setup([merchant('a')]);
    banking.ensureMerchantAccount.mockRejectedValueOnce(new Error('Account Service no disponible'));

    expect(await service.ensureAccounts()).toBe(false);
    await jest.advanceTimersByTimeAsync(30_000);
    expect(banking.ensureMerchantAccount).toHaveBeenCalledTimes(2);

    banking.ensureMerchantAccount.mockRejectedValue(new Error('caído'));
    await service.ensureAccounts();
    service.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(120_000);
    expect(banking.ensureMerchantAccount).toHaveBeenCalledTimes(3);
  });

  it('las consultas separan los comercios de suscripción de las tiendas de compras', async () => {
    const { service } = setup([merchant('netflix'), merchant('tienda-exito'), merchant('spotify')]);

    expect((await service.findSubscriptionMerchants()).map((m) => m.code)).toEqual(['netflix', 'spotify']);
    expect(await service.findAll()).toHaveLength(3);
    expect(await service.findByCode('netflix')).toMatchObject({ code: 'netflix' });
  });
});

describe('SubscriptionsScheduler', () => {
  afterEach(() => jest.useRealTimers());

  it('a los 20 s de arrancar recupera el cobro que se hubiera perdido; si falla, lo registra y no tumba el servicio', async () => {
    jest.useFakeTimers();
    const billing = {
      runBilling: jest.fn().mockResolvedValueOnce({ charged: 1 }).mockRejectedValueOnce(new Error('caído')),
    };
    const scheduler = new SubscriptionsScheduler(billing as unknown as SubscriptionsService);

    scheduler.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(20_000);
    expect(billing.runBilling).toHaveBeenCalledTimes(1);

    await expect(scheduler.daily()).resolves.toBeUndefined(); // el error se captura
    expect(billing.runBilling).toHaveBeenCalledTimes(2);
  });

  it('cerrar el módulo cancela la recuperación pendiente', async () => {
    jest.useFakeTimers();
    const billing = { runBilling: jest.fn() };
    const scheduler = new SubscriptionsScheduler(billing as unknown as SubscriptionsService);

    scheduler.onApplicationBootstrap();
    scheduler.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(60_000);

    expect(billing.runBilling).not.toHaveBeenCalled();
  });

  it('el cobro diario está programado a las 6:00 a. m. hora de Colombia', () => {
    const keys = Reflect.getMetadataKeys(SubscriptionsScheduler.prototype.daily);
    const options = keys.map((key) => Reflect.getMetadata(key, SubscriptionsScheduler.prototype.daily));
    expect(JSON.stringify(options)).toContain('0 0 6 * * *');
    expect(JSON.stringify(options)).toContain('America/Bogota');
  });
});
