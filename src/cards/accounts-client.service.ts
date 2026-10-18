import { ForbiddenException, Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { fetchWithRetry } from '../common/http/fetch-with-retry';

export interface CardAccountInfo {
  id: string;
  idUser: string;
  accountNumber: string;
  currency: string;
  status: string;
}

@Injectable()
export class AccountsClientService {
  constructor(private readonly config: ConfigService) {}

  async getOwnedAccount(accountId: string, accessToken: string): Promise<CardAccountInfo> {
    const baseUrl = this.config.get<string>('ACCOUNT_SERVICE_URL', 'http://localhost:3002');
    let response: Response;
    try {
      response = await fetchWithRetry(`${baseUrl}/accounts/${encodeURIComponent(accountId)}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
    } catch {
      throw new ServiceUnavailableException('No se pudo contactar Account Service.');
    }
    if (response.status === 401) throw new UnauthorizedException('La sesión no es válida para consultar la cuenta.');
    if (response.status === 403 || response.status === 404)
      throw new ForbiddenException('No tienes acceso a esa cuenta.');
    if (!response.ok) throw new ServiceUnavailableException('No se pudo validar la cuenta en Account Service.');
    return response.json() as Promise<CardAccountInfo>;
  }

  /**
   * Límite diario de la cuenta por la red interna (INTERNAL_API_KEY; account-service
   * confía en card). Sirve también sin sesión, p. ej. en el cobro mensual de suscripciones.
   * Quien llama ya validó que la tarjeta (y su cuenta) es del usuario.
   */
  async getAccountDailyLimit(accountId: string): Promise<number> {
    const baseUrl = this.config.get<string>('ACCOUNT_SERVICE_URL', 'http://localhost:3002');
    const key = this.config.get<string>('INTERNAL_API_KEY');
    if (!key) throw new ServiceUnavailableException('INTERNAL_API_KEY no está configurada en Card Service.');
    let response: Response;
    try {
      response = await fetchWithRetry(`${baseUrl}/internal/accounts/${encodeURIComponent(accountId)}/ledger-info`, {
        headers: { 'x-internal-key': key },
      });
    } catch {
      throw new ServiceUnavailableException('No se pudo contactar Account Service.');
    }
    if (!response.ok) throw new ServiceUnavailableException('No se pudo consultar el límite diario de la cuenta.');
    const body = (await response.json()) as { dailyLimit: number };
    const limit = Number(body.dailyLimit);
    if (!Number.isFinite(limit))
      throw new ServiceUnavailableException('Account Service no devolvió el límite diario de la cuenta.');
    return limit;
  }
}
