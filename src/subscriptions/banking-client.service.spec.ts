import { HttpException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BankingClientService } from './banking-client.service';

/**
 * Cobros de card al ledger: cada respuesta se traduce a "aprobado", "rechazado" (el
 * ledger dijo que no: saldo, límites, cuenta inactiva) o "no disponible" (se reintenta
 * con la misma clave). Una falla temporal nunca debe contarse como rechazo del cliente.
 */

const KEY = 'clave-interna-de-card-para-pruebas-0123456789';
const reply = (status: number, body: unknown = {}) =>
  Promise.resolve({ status, ok: status >= 200 && status < 300, json: async () => body } as unknown as Response);

describe('BankingClientService de card', () => {
  const realFetch = global.fetch;
  let fetchMock: jest.Mock;
  const build = (env: Record<string, string> = {}) =>
    new BankingClientService(new ConfigService({ INTERNAL_API_KEY: KEY, ...env }));
  const payment = {
    sourceAccountId: 'a1',
    merchantAccountId: 'm1',
    amount: 38_900,
    idempotencyKey: 'k1',
    description: 'Suscripción',
  };

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as never;
  });
  afterEach(() => {
    global.fetch = realFetch;
  });

  describe('pay (ledger)', () => {
    it('aprobado: devuelve el id de la transacción y manda el pago con la clave interna y de idempotencia', async () => {
      fetchMock.mockReturnValue(reply(201, { id: 'tx-1' }));

      const result = await build({ LEDGER_SERVICE_URL: 'http://ledger.interno:3006' }).pay(payment);

      expect(result).toEqual({ kind: 'approved', transactionId: 'tx-1' });
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('http://ledger.interno:3006/ledger/internal/payments');
      expect(init.headers['x-internal-key']).toBe(KEY);
      expect(JSON.parse(init.body)).toEqual(payment);
    });

    it('saldo insuficiente, límite diario o cuenta inactiva (4xx) son un rechazo con el motivo del ledger', async () => {
      for (const [status, message] of [
        [400, 'Saldo insuficiente.'],
        [403, 'La operación supera el límite diario de la cuenta.'],
        [400, 'La cuenta de origen no está activa.'],
      ] as const) {
        fetchMock.mockReturnValueOnce(reply(status, { message }));
        expect(await build().pay(payment)).toEqual({ kind: 'rejected', reason: message });
      }
    });

    it('un rechazo sin mensaje usa uno por defecto y el motivo se recorta a 200 caracteres', async () => {
      fetchMock.mockReturnValueOnce(reply(400, {}));
      expect(await build().pay(payment)).toEqual({ kind: 'rejected', reason: 'Cobro rechazado.' });

      fetchMock.mockReturnValueOnce(reply(409, { message: 'x'.repeat(500) }));
      const result = await build().pay(payment);
      expect(result.kind === 'rejected' && result.reason).toHaveLength(200);
    });

    it('fallas temporales (5xx, sin respuesta o clave interna rechazada) NO son un rechazo: quedan como no disponible', async () => {
      fetchMock.mockReturnValueOnce(reply(500, { message: 'boom' }));
      expect(await build().pay(payment)).toEqual({ kind: 'unavailable', reason: 'boom' });

      fetchMock.mockReturnValueOnce(reply(503, {}));
      expect(await build().pay(payment)).toEqual({ kind: 'unavailable', reason: 'El ledger respondió 503.' });

      fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      expect(await build().pay(payment)).toEqual({ kind: 'unavailable', reason: 'No se pudo contactar el ledger.' });

      // 401 = el ledger no aceptó nuestra clave interna: es configuración nuestra, no del cliente.
      fetchMock.mockReturnValueOnce(reply(401, { message: 'Clave interna inválida' }));
      expect((await build().pay(payment)).kind).toBe('unavailable');
    });

    it('un cobro nunca se reintenta solo (la clave de idempotencia evita duplicarlo en el siguiente intento)', async () => {
      fetchMock.mockReturnValue(reply(503, {}));

      await build().pay(payment);

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('sin INTERNAL_API_KEY no sale ninguna llamada', async () => {
      const service = new BankingClientService(new ConfigService({}));

      await expect(service.pay(payment)).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('ensureMerchantAccount (account-service)', () => {
    it('crea u obtiene la cuenta del comercio mandando código, nombre y moneda', async () => {
      fetchMock.mockReturnValue(reply(200, { id: 'm1', accountNumber: '90000000001', currency: 'COP' }));

      const account = await build().ensureMerchantAccount('netflix', 'Cineluz', 'COP');

      expect(account.id).toBe('m1');
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('http://localhost:3002/internal/accounts/merchants');
      expect(JSON.parse(init.body)).toEqual({ code: 'netflix', name: 'Cineluz', currency: 'COP' });
    });

    it('si account-service falla o rechaza, lanza (MerchantsService lo reintenta en 30 s)', async () => {
      fetchMock.mockReturnValueOnce(reply(500, { message: 'boom' }));
      await expect(build().ensureMerchantAccount('netflix', 'Cineluz', 'COP')).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );

      fetchMock.mockReturnValueOnce(reply(400, { message: 'Moneda no soportada' }));
      await expect(build().ensureMerchantAccount('netflix', 'Cineluz', 'XXX')).rejects.toBeInstanceOf(HttpException);
    });
  });
});
