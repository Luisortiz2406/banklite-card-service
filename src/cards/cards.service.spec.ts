import { randomUUID } from 'crypto';
import { ConflictException, ForbiddenException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ANA, CARLOS, createCardFixture } from '../testing/card-fixture';
import { describeWithDb, truncateAll } from '../testing/test-database';
import { AccountsClientService } from './accounts-client.service';
import { CardCryptoService } from './card-crypto.service';
import { CardsService } from './cards.service';

/**
 * Emisión y datos de la tarjeta: el número se guarda cifrado (AES-256-GCM), solo el
 * titular lo ve, una tarjeta cancelada no se reactiva. El PAN sale con dígito de Luhn.
 */
const KEY = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

function luhnValid(pan: string) {
  let sum = 0;
  [...pan].reverse().forEach((char, index) => {
    let digit = Number(char);
    if (index % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  });
  return sum % 10 === 0;
}

describe('CardCryptoService', () => {
  const crypto = new CardCryptoService(new ConfigService({ CARD_ENCRYPTION_KEY: KEY }));

  it('genera un número de 16 dígitos que empieza por 4, válido por Luhn, con CVV y vencimiento a 4 años', () => {
    for (let i = 0; i < 50; i++) {
      const credentials = crypto.createCredentials();
      expect(credentials.pan).toMatch(/^4\d{15}$/);
      expect(luhnValid(credentials.pan)).toBe(true);
      expect(credentials.cvv).toMatch(/^\d{3}$/);
      expect(credentials.expiryYear).toBe(new Date().getFullYear() + 4);
      expect(credentials.expiryMonth).toBeGreaterThanOrEqual(1);
      expect(credentials.expiryMonth).toBeLessThanOrEqual(12);
    }
  });

  it('cifra y descifra; el mismo número cifrado dos veces da textos distintos y el original no queda a la vista', () => {
    const { pan } = crypto.createCredentials();
    const first = crypto.encrypt(pan);
    const second = crypto.encrypt(pan);

    expect(first).not.toBe(second);
    expect(first).not.toContain(pan);
    expect(first.split(':')).toHaveLength(3);
    expect(crypto.decrypt(first)).toBe(pan);
    expect(crypto.decrypt(second)).toBe(pan);
  });

  it('un dato alterado, mal formado o cifrado con otra llave se rechaza (503)', () => {
    const encrypted = crypto.encrypt('4111111111111111');
    const [iv, tag, data] = encrypted.split(':');
    const tampered = [iv, tag, data.replace(/^./, data[0] === '0' ? '1' : '0')].join(':');
    const other = new CardCryptoService(new ConfigService({ CARD_ENCRYPTION_KEY: 'f'.repeat(64) }));

    expect(() => crypto.decrypt(tampered)).toThrow(ServiceUnavailableException);
    expect(() => crypto.decrypt('sin-formato')).toThrow('no son válidos');
    expect(() => other.decrypt(encrypted)).toThrow('No se pudo descifrar la tarjeta');
  });

  it('sin una llave válida de 64 hexadecimales no cifra ni descifra, y avisa al arrancar', () => {
    for (const bad of [undefined, '', 'corta', 'z'.repeat(64)]) {
      const broken = new CardCryptoService(new ConfigService({ CARD_ENCRYPTION_KEY: bad }));
      expect(() => broken.encrypt('4111111111111111')).toThrow('64 caracteres hexadecimales');
      expect(() => broken.onModuleInit()).not.toThrow();
    }
    expect(() => crypto.onModuleInit()).not.toThrow();
  });
});

describeWithDb('CardsService (PostgreSQL)', () => {
  let fx: Awaited<ReturnType<typeof createCardFixture>>;
  let cards: CardsService;
  let accountId: string;
  const crypto = new CardCryptoService(new ConfigService({ CARD_ENCRYPTION_KEY: KEY }));
  const accountsClient = {
    getOwnedAccount: jest.fn(),
    getAccountDailyLimit: jest.fn(),
  };

  beforeAll(async () => {
    fx = await createCardFixture();
    cards = new CardsService(fx.cards, accountsClient as unknown as AccountsClientService, crypto);
  });
  afterAll(() => fx?.drop());

  beforeEach(async () => {
    await truncateAll(fx.dataSource);
    jest.restoreAllMocks();
    accountId = randomUUID();
    accountsClient.getOwnedAccount.mockImplementation(async (id: string) => ({
      id,
      accountNumber: '10000000001',
      currency: 'COP',
      status: 'active',
    }));
    accountsClient.getAccountDailyLimit.mockResolvedValue(2_000_000);
  });

  const issue = (userId = ANA, id = accountId) => cards.issue({ accountId: id }, userId, 'token');

  describe('emitir', () => {
    it('crea la tarjeta virtual: muestra el número y el CVV una sola vez y guarda el número cifrado', async () => {
      const issued = await issue();

      expect(issued).toMatchObject({
        alreadyIssued: false,
        status: 'active',
        type: 'virtual',
        onlineEnabled: true,
        dailyLimit: 2_000_000,
        currency: 'COP',
      });
      expect(issued.cardNumber).toMatch(/^4\d{15}$/);
      expect(issued.cvv).toMatch(/^\d{3}$/);
      expect(issued.lastFour).toBe(issued.cardNumber!.slice(-4));

      const row = await fx.cards.findOneByOrFail({ id: issued.id });
      expect(row.encryptedPan).not.toContain(issued.cardNumber!);
      expect(crypto.decrypt(row.encryptedPan!)).toBe(issued.cardNumber);
      expect(JSON.stringify(row)).not.toContain(issued.cvv!); // el CVV no se guarda
    });

    it('pedirla otra vez devuelve la misma sin número ni CVV; la cuenta de otro cliente da 403', async () => {
      const first = await issue();
      const again = await issue();

      expect(again).toMatchObject({ id: first.id, alreadyIssued: true, cardNumber: null, cvv: null });
      expect(await fx.cards.count()).toBe(1);
      await expect(issue(CARLOS)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('exige una cuenta activa y propia; si account-service falla no se emite', async () => {
      accountsClient.getOwnedAccount.mockResolvedValueOnce({ id: accountId, status: 'blocked', currency: 'COP' });
      await expect(issue()).rejects.toThrow('La cuenta debe estar activa');

      accountsClient.getOwnedAccount.mockRejectedValueOnce(new ForbiddenException('No tienes acceso a esta cuenta.'));
      await expect(issue()).rejects.toBeInstanceOf(ForbiddenException);

      accountsClient.getAccountDailyLimit.mockRejectedValueOnce(new ServiceUnavailableException('sin límite'));
      await expect(issue()).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(await fx.cards.count()).toBe(0);
    });

    it('si dos peticiones emiten a la vez, la perdedora devuelve la tarjeta ganadora', async () => {
      const winner = await issue();
      jest.spyOn(fx.cards, 'findOne').mockResolvedValueOnce(null); // no la ve al principio

      const raced = await issue();

      expect(raced).toMatchObject({ id: winner.id, alreadyIssued: true, cardNumber: null });
      expect(await fx.cards.count()).toBe(1);
    });

    it('sin la llave de cifrado válida no se emite una tarjeta', async () => {
      const broken = new CardsService(
        fx.cards,
        accountsClient as unknown as AccountsClientService,
        new CardCryptoService(new ConfigService({})),
      );

      await expect(broken.issue({ accountId }, ANA, 'token')).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(await fx.cards.count()).toBe(0);
    });
  });

  describe('listar, ver el número y cambiar el estado', () => {
    it('lista solo las tarjetas del cliente, sin el número cifrado', async () => {
      await issue();
      await issue(CARLOS, randomUUID());

      const list = await cards.list(ANA);

      expect(list).toHaveLength(1);
      expect(list[0]).not.toHaveProperty('encryptedPan');
      expect(list[0]).not.toHaveProperty('cardNumber');
    });

    it('el titular ve el número completo; otro cliente no, una inexistente da 404, una cancelada 409', async () => {
      const issued = await issue();

      expect(await cards.reveal(issued.id, ANA)).toMatchObject({ id: issued.id, cardNumber: issued.cardNumber });
      await expect(cards.reveal(issued.id, CARLOS)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(cards.reveal(randomUUID(), ANA)).rejects.toBeInstanceOf(NotFoundException);

      await fx.cards.update(issued.id, { status: 'cancelled', encryptedPan: null });
      await expect(cards.reveal(issued.id, ANA)).rejects.toBeInstanceOf(ConflictException);
    });

    it('congelar y reactivar es del titular; una cancelada no se reactiva', async () => {
      const issued = await issue();

      expect(await cards.updateStatus(issued.id, { status: 'frozen' }, ANA)).toMatchObject({ status: 'frozen' });
      expect(await cards.updateStatus(issued.id, { status: 'active' }, ANA)).toMatchObject({ status: 'active' });
      await expect(cards.updateStatus(issued.id, { status: 'frozen' }, CARLOS)).rejects.toBeInstanceOf(
        ForbiddenException,
      );

      await fx.cards.update(issued.id, { status: 'cancelled' });
      await expect(cards.updateStatus(issued.id, { status: 'active' }, ANA)).rejects.toThrow('no se puede reactivar');
    });
  });
});
