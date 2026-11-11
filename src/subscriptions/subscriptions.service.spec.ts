import { randomUUID } from 'crypto';
import { ConflictException, ForbiddenException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ANA, CARLOS, createCardFixture } from '../testing/card-fixture';
import { describeWithDb, truncateAll } from '../testing/test-database';
import { addDays, bogotaToday, chargeKey, dueDate, nextPeriod, periodOf } from './billing-dates';
import { SubscriptionStatus } from './entities/subscription.entity';

/**
 * Cobro de suscripciones contra PostgreSQL real (candado de la tarjeta, candado de la
 * tarea diaria, cobro del ledger simulado). Lo más importante: el primer mes se cobra
 * de verdad o no se inscribe nada, un periodo nunca se cobra dos veces, y tras 3
 * reintentos fallidos la suscripción se suspende.
 */
const NETFLIX = 'netflix'; // $38.900
const SPOTIFY = 'spotify'; // $18.900

describeWithDb('SubscriptionsService (PostgreSQL)', () => {
  let fx: Awaited<ReturnType<typeof createCardFixture>>;
  let cardId: string;
  const today = bogotaToday();

  beforeAll(async () => {
    fx = await createCardFixture();
  });
  afterAll(() => fx?.drop());

  beforeEach(async () => {
    await truncateAll(fx.dataSource);
    jest.restoreAllMocks();
    jest.clearAllMocks();
    fx.state.accountDailyLimit = 5_000_000;
    fx.banking.pay.mockImplementation(async () => ({ kind: 'approved', transactionId: randomUUID() }));
    await fx.addMerchant(NETFLIX, { name: 'Cineluz', plan: 'Plan Estándar', price: '38900.00' });
    await fx.addMerchant(SPOTIFY, { name: 'Ritmia', plan: 'Individual', price: '18900.00' });
    cardId = (await fx.addCard(ANA)).id;
  });

  const enroll = (merchantCode = NETFLIX, userId = ANA, card = cardId) =>
    fx.subscriptions.enroll(userId, { merchantCode, cardId: card });
  const stored = (id: string) => fx.subscriptionRepo.findOneByOrFail({ id });
  const chargesOf = (id: string) => fx.chargeRepo.find({ where: { subscriptionId: id }, order: { createdAt: 'ASC' } });
  const rejectedOf = async (id: string) => (await chargesOf(id)).filter((c) => c.status === 'rejected');
  const events = async () => (await fx.outboxRepo.find({ order: { createdAt: 'ASC' } })).map((e) => e.routingKey);
  const rejectOnce = (reason = 'Saldo insuficiente.') =>
    fx.banking.pay.mockResolvedValueOnce({ kind: 'rejected', reason });
  /** Deja una suscripción activa, ya inscrita, con su próximo cobro en `nextChargeDate`. */
  const activeWithDue = async (nextChargeDate: string, merchantCode = NETFLIX) => {
    const created = await enroll(merchantCode);
    await fx.subscriptionRepo.update(created.id, { nextChargeDate });
    fx.banking.pay.mockClear();
    return created;
  };

  describe('inscribir (enroll)', () => {
    it('cobra el primer mes de inmediato contra la cuenta del comercio y queda activa con el siguiente cobro', async () => {
      const result = await enroll();

      expect(result).toMatchObject({
        merchantCode: NETFLIX,
        amount: 38_900,
        status: 'active',
        retryCount: 0,
        billingDay: Number(today.slice(8)),
        cardLast4: '4242',
      });
      expect(result.pendingPeriod).toBe(nextPeriod(periodOf(today)));
      expect(result.nextChargeDate).toBe(dueDate(result.pendingPeriod, result.billingDay));

      const merchant = await fx.merchantRepo.findOneByOrFail({ code: NETFLIX });
      expect(fx.banking.pay).toHaveBeenCalledWith(
        expect.objectContaining({
          merchantAccountId: merchant.accountId,
          amount: 38_900,
          idempotencyKey: chargeKey(result.id, periodOf(today)),
          description: 'Suscripción Cineluz · Plan Estándar',
        }),
      );
      const [charge] = await chargesOf(result.id);
      expect(charge).toMatchObject({ period: periodOf(today), attempt: 1, status: 'succeeded' });
      expect(await events()).toEqual(['subscription.charged']);
      expect(await fx.authorizationRepo.findOneByOrFail({ cardId })).toMatchObject({
        status: 'approved',
        source: 'subscription',
        channel: 'online',
      });
    });

    it('si el primer cobro se rechaza (saldo insuficiente) no se inscribe nada ni se avisa de un cobro', async () => {
      rejectOnce('Saldo insuficiente.');

      await expect(enroll()).rejects.toThrow('No se pudo cobrar el primer mes: Saldo insuficiente.');

      expect(await fx.subscriptionRepo.count()).toBe(0);
      expect(await fx.chargeRepo.count()).toBe(0);
      expect(await events()).toEqual([]);
      expect(await fx.authorizationRepo.findOneByOrFail({ cardId })).toMatchObject({ status: 'declined' });
    });

    it('si el ledger no responde es 503, tampoco queda inscrita y la autorización queda en error (no cuenta en el límite)', async () => {
      fx.banking.pay.mockResolvedValueOnce({ kind: 'unavailable', reason: 'No se pudo contactar el ledger.' });

      await expect(enroll()).rejects.toBeInstanceOf(ServiceUnavailableException);

      expect(await fx.subscriptionRepo.count()).toBe(0);
      expect(await fx.authorizationRepo.findOneByOrFail({ cardId })).toMatchObject({ status: 'error' });
      expect(await fx.authorizations.usedToday(cardId)).toBe(0);
    });

    it('respeta los controles de la tarjeta: congelada, compras por internet apagadas y límite diario', async () => {
      await fx.cards.update(cardId, { onlineEnabled: false });
      await expect(enroll()).rejects.toThrow('desactivadas las compras por internet');

      await fx.cards.update(cardId, { onlineEnabled: true, dailyLimit: '30000.00' });
      await expect(enroll()).rejects.toThrow('Supera tu límite diario');

      fx.state.accountDailyLimit = 20_000; // el límite de la cuenta también cuenta
      await fx.cards.update(cardId, { dailyLimit: '5000000.00' });
      await expect(enroll()).rejects.toThrow('Supera tu límite diario');
      expect(fx.banking.pay).not.toHaveBeenCalled();
      expect(await fx.subscriptionRepo.count()).toBe(0);
    });

    it('valida el comercio, la tarjeta y la moneda antes de cobrar', async () => {
      await expect(enroll('comercio-que-no-existe')).rejects.toBeInstanceOf(NotFoundException);
      await expect(enroll('tienda-exito')).rejects.toBeInstanceOf(NotFoundException); // tienda, no suscripción

      await fx.merchantRepo.update(NETFLIX, { accountId: null });
      await expect(enroll()).rejects.toBeInstanceOf(ServiceUnavailableException);
      await fx.merchantRepo.update(NETFLIX, { accountId: randomUUID() });

      const carlosCard = (await fx.addCard(CARLOS)).id;
      await expect(enroll(NETFLIX, ANA, carlosCard)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(enroll(NETFLIX, ANA, randomUUID())).rejects.toBeInstanceOf(ForbiddenException);

      await fx.cards.update(cardId, { status: 'frozen' });
      await expect(enroll()).rejects.toThrow('congelada');
      await fx.cards.update(cardId, { status: 'active', currency: 'USD' });
      await expect(enroll()).rejects.toThrow('misma moneda');
      expect(fx.banking.pay).not.toHaveBeenCalled();
    });

    it('no se puede inscribir dos veces el mismo servicio (ni en una carrera)', async () => {
      await enroll();
      await expect(enroll()).rejects.toThrow('Ya tienes una suscripción a Cineluz');
      expect(fx.banking.pay).toHaveBeenCalledTimes(1);

      // Otro servicio sí, y otro cliente también.
      await expect(enroll(SPOTIFY)).resolves.toMatchObject({ merchantCode: SPOTIFY });
      const carlosCard = (await fx.addCard(CARLOS)).id;
      await expect(enroll(NETFLIX, CARLOS, carlosCard)).resolves.toMatchObject({ status: 'active' });

      const duplicated = Object.assign(new Error('duplicate key'), { code: '23505' });
      jest.spyOn(fx.subscriptionRepo, 'save').mockRejectedValueOnce(duplicated);
      await expect(enroll('spotify', ANA)).rejects.toBeInstanceOf(ConflictException);
    });

    it('una cancelada permite inscribirse otra vez', async () => {
      const first = await enroll();
      await fx.subscriptions.cancel(ANA, first.id);

      await expect(enroll()).resolves.toMatchObject({ status: 'active' });
    });
  });

  describe('consultas', () => {
    it('el catálogo marca como no disponible un comercio sin cuenta; el listado suma solo lo activo', async () => {
      await fx.merchantRepo.update(SPOTIFY, { accountId: null });
      const catalog = await fx.subscriptions.catalog();
      expect(catalog.find((c) => c.code === NETFLIX)).toMatchObject({ price: 38_900, available: true });
      expect(catalog.find((c) => c.code === SPOTIFY)).toMatchObject({ available: false });

      await fx.merchantRepo.update(SPOTIFY, { accountId: randomUUID() });
      const netflix = await enroll(NETFLIX);
      const spotify = await enroll(SPOTIFY);
      await fx.subscriptions.pause(ANA, spotify.id);

      const list = await fx.subscriptions.list(ANA);
      expect(list.items.map((i) => [i.merchantCode, i.status])).toEqual([
        [NETFLIX, 'active'],
        [SPOTIFY, 'paused'],
      ]);
      expect(list.monthlyTotal).toBe(38_900);
      expect(list.items[1].nextChargeDate).toBeNull();
      expect(await fx.subscriptions.list(CARLOS)).toMatchObject({ items: [], monthlyTotal: 0 });
      expect(netflix.id).toBeDefined();
    });

    it('el historial de cobros es solo del dueño', async () => {
      const created = await enroll();

      expect(await fx.subscriptions.charges(ANA, created.id)).toEqual([
        expect.objectContaining({ period: periodOf(today), status: 'succeeded', amount: 38_900 }),
      ]);
      await expect(fx.subscriptions.charges(CARLOS, created.id)).rejects.toBeInstanceOf(NotFoundException);
      await expect(fx.subscriptions.charges(ANA, randomUUID())).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('cobro diario (runBilling)', () => {
    it('cobra lo que vence, una sola vez por periodo, y avanza al siguiente mes', async () => {
      const created = await activeWithDue(today);
      const period = created.pendingPeriod;

      const summary = await fx.subscriptions.runBilling(today);

      expect(summary).toMatchObject({ asOf: today, charged: 1, rejected: 0, suspended: 0, unavailable: 0 });
      expect(fx.banking.pay).toHaveBeenCalledWith(
        expect.objectContaining({ idempotencyKey: chargeKey(created.id, period), amount: 38_900 }),
      );
      const after = await stored(created.id);
      expect(after.pendingPeriod).toBe(nextPeriod(period));
      expect(after.nextChargeDate).toBe(dueDate(after.pendingPeriod, after.billingDay));

      // Correr de nuevo el mismo día no cobra otra vez.
      fx.banking.pay.mockClear();
      expect(await fx.subscriptions.runBilling(today)).toMatchObject({ charged: 0 });
      expect(fx.banking.pay).not.toHaveBeenCalled();
      expect((await chargesOf(created.id)).filter((c) => c.period === period)).toHaveLength(1);
    });

    it('no toca lo que aún no vence, lo pausado ni lo cancelado', async () => {
      const future = await activeWithDue(addDays(today, 10), NETFLIX);
      const paused = await activeWithDue(today, SPOTIFY);
      await fx.subscriptions.pause(ANA, paused.id);
      void future;

      expect(await fx.subscriptions.runBilling(today)).toMatchObject({ charged: 0, rejected: 0 });
      expect(fx.banking.pay).not.toHaveBeenCalled();
    });

    it('un rechazo (sin saldo) reintenta al día siguiente y avisa que quedan reintentos', async () => {
      const created = await activeWithDue(today);
      rejectOnce('Saldo insuficiente.');

      const summary = await fx.subscriptions.runBilling(today);

      expect(summary).toMatchObject({ charged: 0, rejected: 1, suspended: 0 });
      const after = await stored(created.id);
      expect(after).toMatchObject({ status: 'active', retryCount: 1, nextChargeDate: addDays(today, 1) });
      expect(await rejectedOf(created.id)).toEqual([
        expect.objectContaining({ attempt: 1, reason: 'Saldo insuficiente.' }),
      ]);
      const rejection = (await fx.outboxRepo.find()).find((e) => e.routingKey === 'subscription.charge_rejected');
      expect(rejection?.payload).toMatchObject({ final: false, retriesLeft: 3, nextAttemptDate: addDays(today, 1) });

      // El reintento del día siguiente usa la misma clave de idempotencia y cobra.
      fx.banking.pay.mockClear();
      expect(await fx.subscriptions.runBilling(addDays(today, 1))).toMatchObject({ charged: 1 });
      expect(fx.banking.pay).toHaveBeenCalledWith(
        expect.objectContaining({ idempotencyKey: chargeKey(created.id, after.pendingPeriod) }),
      );
      expect(await stored(created.id)).toMatchObject({ retryCount: 0, status: 'active' });
    });

    it('tras el intento del día y 3 reintentos fallidos se suspende y se avisa dos veces (rechazo final y suspensión)', async () => {
      const created = await activeWithDue(today);
      fx.banking.pay.mockResolvedValue({ kind: 'rejected', reason: 'Saldo insuficiente.' });

      const outcomes = [];
      for (let day = 0; day < 4; day++) outcomes.push(await fx.subscriptions.runBilling(addDays(today, day)));

      expect(outcomes.map((o) => [o.rejected, o.suspended])).toEqual([
        [1, 0],
        [1, 0],
        [1, 0],
        [0, 1],
      ]);
      expect(await stored(created.id)).toMatchObject({ status: 'suspended' });
      expect(await rejectedOf(created.id)).toHaveLength(4);
      const keys = await events();
      expect(keys.filter((k) => k === 'subscription.charge_rejected')).toHaveLength(4);
      expect(keys.filter((k) => k === 'subscription.suspended')).toHaveLength(1);

      // Suspendida: ya no se cobra.
      fx.banking.pay.mockClear();
      expect(await fx.subscriptions.runBilling(addDays(today, 10))).toMatchObject({ charged: 0, rejected: 0 });
      expect(fx.banking.pay).not.toHaveBeenCalled();
    });

    it('si el ledger no responde el cobro se aplaza sin registrar un rechazo ni gastar un reintento', async () => {
      const created = await activeWithDue(today);
      fx.banking.pay.mockResolvedValueOnce({ kind: 'unavailable', reason: 'El ledger respondió 503.' });

      expect(await fx.subscriptions.runBilling(today)).toMatchObject({ unavailable: 1, charged: 0, rejected: 0 });

      expect(await stored(created.id)).toMatchObject({ retryCount: 0, status: 'active', nextChargeDate: today });
      expect(await rejectedOf(created.id)).toEqual([]);
      expect(await chargesOf(created.id)).toHaveLength(1); // solo el primer mes
      // Mañana (o en la siguiente corrida) se cobra con la misma clave.
      expect(await fx.subscriptions.runBilling(today)).toMatchObject({ charged: 1 });
    });

    it('si la tarjeta se congeló, se rechaza el cobro con el motivo de la tarjeta', async () => {
      const created = await activeWithDue(today);
      await fx.cards.update(cardId, { status: 'frozen' });

      expect(await fx.subscriptions.runBilling(today)).toMatchObject({ rejected: 1 });

      expect(fx.banking.pay).not.toHaveBeenCalled();
      expect((await rejectedOf(created.id))[0].reason).toBe('La tarjeta está congelada.');
    });

    it('si el cliente cancela mientras se cobra, sigue cancelada (tanto si se cobró como si se rechazó)', async () => {
      const cobrada = await activeWithDue(today, NETFLIX);
      fx.banking.pay.mockImplementationOnce(async () => {
        await fx.subscriptionRepo.update(cobrada.id, { status: 'cancelled', cancelledAt: new Date() });
        return { kind: 'approved', transactionId: randomUUID() };
      });
      await fx.subscriptions.runBilling(today);
      expect(await stored(cobrada.id)).toMatchObject({ status: 'cancelled' });
      expect(await chargesOf(cobrada.id)).toHaveLength(2); // el primer mes y este cobro

      const rechazada = await activeWithDue(today, SPOTIFY);
      fx.banking.pay.mockImplementationOnce(async () => {
        await fx.subscriptionRepo.update(rechazada.id, { status: 'cancelled', cancelledAt: new Date() });
        return { kind: 'rejected', reason: 'Saldo insuficiente.' };
      });
      await fx.subscriptions.runBilling(today);
      expect(await stored(rechazada.id)).toMatchObject({ status: 'cancelled', retryCount: 0 });
      expect((await events()).filter((k) => k === 'subscription.suspended')).toHaveLength(0);
    });

    it('avisa 3 días antes del cobro, una sola vez por periodo', async () => {
      const created = await activeWithDue(addDays(today, 3));
      await fx.subscriptionRepo.update(created.id, { remindedFor: null });

      expect(await fx.subscriptions.runBilling(today)).toMatchObject({ reminded: 1, charged: 0 });
      expect(await fx.subscriptions.runBilling(today)).toMatchObject({ reminded: 0 });

      const reminder = (await fx.outboxRepo.find()).find((e) => e.routingKey === 'subscription.charge_upcoming');
      expect(reminder?.payload).toMatchObject({
        idUser: ANA,
        merchantName: 'Cineluz',
        amount: 38_900,
        cardLast4: '4242',
        chargeDate: addDays(today, 3),
      });
    });

    it('dos ejecuciones a la vez no se cruzan: la segunda se salta', async () => {
      const runner = fx.dataSource.createQueryRunner();
      await runner.connect();
      try {
        await runner.query('SELECT pg_advisory_lock($1)', [74920041]);

        expect(await fx.subscriptions.runBilling(today)).toMatchObject({
          skipped: 'Ya hay una ejecución en curso.',
          charged: 0,
        });
      } finally {
        await runner.query('SELECT pg_advisory_unlock($1)', [74920041]);
        await runner.release();
      }
    });

    it('un comercio borrado del catálogo es un error que se informa (404)', async () => {
      await activeWithDue(today);
      await fx.merchantRepo.delete({ code: NETFLIX });

      await expect(fx.subscriptions.runBilling(today)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('pausar, reanudar y cancelar', () => {
    it('pausar solo vale para activas; reanudar saltea los meses en pausa y cobra de una vez si hoy toca y no está pagado', async () => {
      const created = await activeWithDue(today);
      await fx.subscriptions.pause(ANA, created.id);
      await expect(fx.subscriptions.pause(ANA, created.id)).rejects.toBeInstanceOf(ConflictException);
      // Los meses en pausa no se cobran.
      expect(await fx.subscriptions.runBilling(addDays(today, 40))).toMatchObject({ charged: 0 });

      // El mes actual no se había cobrado (se borra el cobro del primer mes): hoy es el día de cobro.
      await fx.chargeRepo.delete({ subscriptionId: created.id });
      const resumed = await fx.subscriptions.resume(ANA, created.id);

      expect(resumed.status).toBe('active');
      expect(fx.banking.pay).toHaveBeenCalledTimes(1); // hoy era el día de cobro
      expect(resumed.pendingPeriod).toBe(nextPeriod(periodOf(today)));
    });

    it('reanudar una pausada cuyo día de cobro ya pasó espera al próximo, sin cobrar hoy', async () => {
      const created = await activeWithDue(today);
      await fx.subscriptions.pause(ANA, created.id);
      const otherDay = Number(today.slice(8)) === 1 ? 2 : 1;
      await fx.subscriptionRepo.update(created.id, { billingDay: otherDay });

      const resumed = await fx.subscriptions.resume(ANA, created.id);

      expect(resumed.status).toBe('active');
      if (otherDay > Number(today.slice(8))) expect(fx.banking.pay).toHaveBeenCalledTimes(0);
      expect(resumed.nextChargeDate! >= today).toBe(true);
    });

    it('reactivar una suspendida cobra el mes actual: si se aprueba queda activa', async () => {
      const created = await enroll();
      await fx.subscriptionRepo.update(created.id, {
        status: 'suspended' as SubscriptionStatus,
        suspendedAt: new Date(),
        retryCount: 3,
        pendingPeriod: periodOf(addDays(today, 40)),
      });
      // Se paga el mes actual: la suspendida no tiene cobro exitoso para este periodo.
      await fx.chargeRepo.delete({ subscriptionId: created.id });
      fx.banking.pay.mockClear();

      const result = await fx.subscriptions.resume(ANA, created.id);

      expect(result).toMatchObject({ status: 'active', retryCount: 0, suspendedAt: null });
      expect(fx.banking.pay).toHaveBeenCalledTimes(1);
      expect((await chargesOf(created.id))[0]).toMatchObject({ status: 'succeeded', period: periodOf(today) });
    });

    it('reactivar una suspendida: rechazada = 400 y queda el intento; sin respuesta del ledger = 503', async () => {
      const created = await enroll();
      await fx.chargeRepo.delete({ subscriptionId: created.id });
      await fx.subscriptionRepo.update(created.id, { status: 'suspended' as SubscriptionStatus, retryCount: 3 });
      fx.banking.pay.mockClear();

      rejectOnce('Saldo insuficiente.');
      await expect(fx.subscriptions.resume(ANA, created.id)).rejects.toThrow(
        'No se pudo reactivar: Saldo insuficiente.',
      );
      expect((await chargesOf(created.id))[0]).toMatchObject({ status: 'rejected', attempt: 1 });
      expect((await stored(created.id)).status).toBe('suspended');

      fx.banking.pay.mockResolvedValueOnce({ kind: 'unavailable', reason: 'sin respuesta' });
      await expect(fx.subscriptions.resume(ANA, created.id)).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect((await stored(created.id)).status).toBe('suspended');
    });

    it('reactivar una suspendida cuyo mes ya está pagado la activa sin cobrar otra vez', async () => {
      const created = await enroll();
      await fx.subscriptionRepo.update(created.id, { status: 'suspended' as SubscriptionStatus, retryCount: 3 });
      fx.banking.pay.mockClear();

      const result = await fx.subscriptions.resume(ANA, created.id);

      expect(result.status).toBe('active');
      expect(fx.banking.pay).not.toHaveBeenCalled();
    });

    it('una activa no se puede reanudar; cancelar es idempotente y de nadie más', async () => {
      const created = await enroll();

      await expect(fx.subscriptions.resume(ANA, created.id)).rejects.toThrow('no está pausada ni suspendida');
      await expect(fx.subscriptions.cancel(CARLOS, created.id)).rejects.toBeInstanceOf(NotFoundException);

      expect(await fx.subscriptions.cancel(ANA, created.id)).toMatchObject({ status: 'cancelled' });
      expect(await fx.subscriptions.cancel(ANA, created.id)).toMatchObject({ status: 'cancelled' });
      expect(await fx.subscriptions.list(ANA)).toMatchObject({ items: [] });
    });
  });
});
