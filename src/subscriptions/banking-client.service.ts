import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface MerchantAccount {
  id: string;
  accountNumber: string;
  currency: string;
  status: string;
}

/** Resultado de un cobro: aprobado, rechazado (con motivo) o falla temporal (se reintenta luego). */
export type PaymentResult =
  | { kind: 'approved'; transactionId: string }
  | { kind: 'rejected'; reason: string }
  | { kind: 'unavailable'; reason: string };

/**
 * Llamadas servicio a servicio (red interna, INTERNAL_API_KEY): cuentas de
 * comercio en account-service y pagos cliente → comercio en ledger-service.
 */
@Injectable()
export class BankingClientService {
  constructor(private readonly config: ConfigService) {}

  /** Crea u obtiene la cuenta del comercio (idempotente por código). */
  async ensureMerchantAccount(code: string, name: string, currency: string): Promise<MerchantAccount> {
    const baseUrl = this.config.get<string>('ACCOUNT_SERVICE_URL', 'http://localhost:3002');
    let response: Response;
    try {
      response = await fetch(`${baseUrl}/internal/accounts/merchants`, {
        method: 'POST',
        headers: this.internalHeaders(),
        body: JSON.stringify({ code, name, currency }),
        signal: AbortSignal.timeout(10000),
      });
    } catch {
      throw new ServiceUnavailableException('No se pudo contactar Account Service.');
    }
    if (!response.ok) throw new ServiceUnavailableException(`Account Service respondió ${response.status}.`);
    return response.json() as Promise<MerchantAccount>;
  }

  /** Pago cliente → comercio en el ledger (doble partida, saldo, límites e idempotencia). */
  async pay(params: {
    sourceAccountId: string;
    merchantAccountId: string;
    amount: number;
    idempotencyKey: string;
    description: string;
  }): Promise<PaymentResult> {
    const baseUrl = this.config.get<string>('LEDGER_SERVICE_URL', 'http://localhost:3006');
    let response: Response;
    try {
      response = await fetch(`${baseUrl}/ledger/internal/payments`, {
        method: 'POST',
        headers: this.internalHeaders(),
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      return { kind: 'unavailable', reason: 'No se pudo contactar el ledger.' };
    }

    const payload = await response.json().catch(() => ({}));
    if (response.ok) return { kind: 'approved', transactionId: payload.id };

    const message = Array.isArray(payload?.message) ? payload.message.join(' ') : payload?.message;
    // 4xx: el ledger rechazó el cobro (saldo, límites, cuenta inactiva...). 5xx: falla temporal.
    if (response.status >= 400 && response.status < 500) {
      return { kind: 'rejected', reason: String(message || 'Cobro rechazado.').slice(0, 200) };
    }
    return { kind: 'unavailable', reason: String(message || `El ledger respondió ${response.status}.`).slice(0, 200) };
  }

  private internalHeaders() {
    const key = this.config.get<string>('INTERNAL_API_KEY');
    if (!key) throw new ServiceUnavailableException('INTERNAL_API_KEY no está configurada en Card Service.');
    return { 'Content-Type': 'application/json', 'x-internal-key': key };
  }
}
