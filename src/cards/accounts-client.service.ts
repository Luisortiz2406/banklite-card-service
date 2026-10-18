import { ForbiddenException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { callService, HTTP_TIMEOUTS } from '../common/http/internal-http';

export interface CardAccountInfo {
  id: string;
  idUser: string;
  accountNumber: string;
  currency: string;
  status: string;
}

/** Cuentas en account-service. Errores: regla común de common/http/internal-http.ts. */
@Injectable()
export class AccountsClientService {
  constructor(private readonly config: ConfigService) {}

  async getOwnedAccount(accountId: string, accessToken: string): Promise<CardAccountInfo> {
    // 403 y 404 se responden igual: no se revela si la cuenta existe.
    const noAccess = () => new ForbiddenException('No tienes acceso a esa cuenta.');
    return callService<CardAccountInfo>(
      `${this.baseUrl()}/accounts/${encodeURIComponent(accountId)}`,
      { headers: { Authorization: `Bearer ${accessToken}` }, timeoutMs: HTTP_TIMEOUTS.read, retry: true },
      {
        service: 'Account Service',
        internal: false,
        unavailable: 'No se pudo validar la cuenta. Inténtalo de nuevo.',
        on: { 403: noAccess, 404: noAccess },
      },
    );
  }

  /**
   * Límite diario de la cuenta por la red interna (INTERNAL_API_KEY; account-service
   * confía en card). Sirve también sin sesión, p. ej. en el cobro mensual de suscripciones.
   * Quien llama ya validó que la tarjeta (y su cuenta) es del usuario.
   */
  async getAccountDailyLimit(accountId: string): Promise<number> {
    const key = this.config.get<string>('INTERNAL_API_KEY');
    if (!key) throw new ServiceUnavailableException('INTERNAL_API_KEY no está configurada en Card Service.');
    const body = await callService<{ dailyLimit: number }>(
      `${this.baseUrl()}/internal/accounts/${encodeURIComponent(accountId)}/ledger-info`,
      { headers: { 'x-internal-key': key }, timeoutMs: HTTP_TIMEOUTS.read, retry: true },
      {
        service: 'Account Service',
        internal: true,
        unavailable: 'No se pudo consultar el límite diario de la cuenta. Inténtalo de nuevo.',
      },
    );
    const limit = Number(body.dailyLimit);
    if (!Number.isFinite(limit))
      throw new ServiceUnavailableException('Account Service no devolvió el límite diario de la cuenta.');
    return limit;
  }

  private baseUrl() {
    return this.config.get<string>('ACCOUNT_SERVICE_URL', 'http://localhost:3002');
  }
}
