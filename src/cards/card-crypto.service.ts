import { Injectable, Logger, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, randomBytes, randomInt } from 'crypto';

@Injectable()
export class CardCryptoService implements OnModuleInit {
  private readonly logger = new Logger('CardCryptoService');

  constructor(private readonly config: ConfigService) {}

  /** Avisa al arrancar (en vez de al primer uso) si la clave de cifrado no es válida. */
  onModuleInit() {
    const hex = this.config.get<string>('CARD_ENCRYPTION_KEY') || '';
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
      this.logger.error(
        'CARD_ENCRYPTION_KEY falta o no tiene 64 caracteres hexadecimales: emitir y mostrar tarjetas responderá 503.',
      );
    }
  }

  createCredentials() {
    const firstFifteen = `4${Array.from({ length: 14 }, () => randomInt(0, 10)).join('')}`;
    const pan = `${firstFifteen}${this.luhnDigit(firstFifteen)}`;
    const cvv = String(randomInt(0, 1000)).padStart(3, '0');
    const now = new Date();
    return {
      pan,
      cvv,
      expiryMonth: now.getMonth() + 1,
      expiryYear: now.getFullYear() + 4,
    };
  }

  encrypt(pan: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey(), iv);
    const encrypted = Buffer.concat([cipher.update(pan, 'utf8'), cipher.final()]);
    return [iv.toString('hex'), cipher.getAuthTag().toString('hex'), encrypted.toString('hex')].join(':');
  }

  decrypt(value: string): string {
    const [ivHex, tagHex, encryptedHex] = value.split(':');
    if (!ivHex || !tagHex || !encryptedHex) {
      throw new ServiceUnavailableException('Los datos cifrados de la tarjeta no son válidos.');
    }
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.encryptionKey(), Buffer.from(ivHex, 'hex'));
      decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
      return Buffer.concat([decipher.update(Buffer.from(encryptedHex, 'hex')), decipher.final()]).toString('utf8');
    } catch {
      throw new ServiceUnavailableException('No se pudo descifrar la tarjeta. Verifica CARD_ENCRYPTION_KEY.');
    }
  }

  private encryptionKey(): Buffer {
    const hex = this.config.get<string>('CARD_ENCRYPTION_KEY') || '';
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
      throw new ServiceUnavailableException(
        'CARD_ENCRYPTION_KEY debe contener exactamente 64 caracteres hexadecimales.',
      );
    }
    return Buffer.from(hex, 'hex');
  }

  private luhnDigit(digits: string): number {
    let sum = 0;
    let double = true;
    for (let index = digits.length - 1; index >= 0; index--) {
      let digit = Number(digits[index]);
      if (double) {
        digit *= 2;
        if (digit > 9) digit -= 9;
      }
      sum += digit;
      double = !double;
    }
    return (10 - (sum % 10)) % 10;
  }
}
