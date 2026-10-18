import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { callService, HTTP_TIMEOUTS, requestService } from '../common/http/internal-http';

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
 * Errores: regla común de common/http/internal-http.ts.
 */
@Injectable()
export class BankingClientService {
  constructor(private readonly config: ConfigService) {}

  /** Crea u obtiene la cuenta del comercio (idempotente por código). */
  async ensureMerchantAccount(code: string, name: string, currency: string): Promise<MerchantAccount> {
    const baseUrl = this.config.get<string>('ACCOUNT_SERVICE_URL', 'http://localhost:3002');
    return callService<MerchantAccount>(
      `${baseUrl}/internal/accounts/merchants`,
      { method: 'POST', headers: this.internalHeaders(), body: JSON.stringify({ code, name, currency }) },
      { service: 'Account Service', internal: true },
    );
  }

  /**
   * Pago cliente → comercio en el ledger (doble partida, saldo, límites e idempotencia).
   * Misma regla, como resultado: 4xx = el ledger rechazó el cobro (saldo, límites,
   * cuenta inactiva...); 5xx, sin respuesta o clave interna rechazada (401) = falla temporal.
   */
  async pay(params: {
    sourceAccountId: string;
    merchantAccountId: string;
    amount: number;
    idempotencyKey: string;
    description: string;
  }): Promise<PaymentResult> {
    const baseUrl = this.config.get<string>('LEDGER_SERVICE_URL', 'http://localhost:3006');
    const response = await requestService<{ id: string }>(`${baseUrl}/ledger/internal/payments`, {
      method: 'POST',
      headers: this.internalHeaders(),
      body: JSON.stringify(params),
      timeoutMs: HTTP_TIMEOUTS.slow,
    });
    if (!response) return { kind: 'unavailable', reason: 'No se pudo contactar el ledger.' };
    if (response.ok) return { kind: 'approved', transactionId: response.body.id };
    // 401 = el ledger no aceptó nuestra clave interna: problema de configuración, no del cliente
    const internalKeyRejected = response.status === 401;
    if (response.status >= 400 && response.status < 500 && !internalKeyRejected) {
      return { kind: 'rejected', reason: (response.message || 'Cobro rechazado.').slice(0, 200) };
    }
    return {
      kind: 'unavailable',
      reason: (response.message || `El ledger respondió ${response.status}.`).slice(0, 200),
    };
  }

  private internalHeaders() {
    const key = this.config.get<string>('INTERNAL_API_KEY');
    if (!key) throw new ServiceUnavailableException('INTERNAL_API_KEY no está configurada en Card Service.');
    return { 'Content-Type': 'application/json', 'x-internal-key': key };
  }
}
