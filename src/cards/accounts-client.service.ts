import { ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
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
    if (response.status === 403 || response.status === 404) throw new ForbiddenException('No tienes acceso a esa cuenta.');
    if (!response.ok) throw new ServiceUnavailableException('No se pudo validar la cuenta en Account Service.');
    return response.json() as Promise<CardAccountInfo>;
  }

  /** Límites de la cuenta (solo su dueño, con el token de la sesión). */
  async getLimits(accountId: string, accessToken: string): Promise<{ dailyLimit: number; monthlyLimit: number }> {
    const baseUrl = this.config.get<string>('ACCOUNT_SERVICE_URL', 'http://localhost:3002');
    let response: Response;
    try {
      response = await fetchWithRetry(`${baseUrl}/accounts/${encodeURIComponent(accountId)}/limits`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
    } catch {
      throw new ServiceUnavailableException('No se pudo contactar Account Service.');
    }
    if (response.status === 401) throw new UnauthorizedException('La sesión no es válida para consultar la cuenta.');
    if (response.status === 403 || response.status === 404) throw new ForbiddenException('No tienes acceso a esa cuenta.');
    if (!response.ok) throw new ServiceUnavailableException('No se pudieron consultar los límites de la cuenta.');
    const body = await response.json() as { dailyLimit: number; monthlyLimit: number };
    return { dailyLimit: Number(body.dailyLimit), monthlyLimit: Number(body.monthlyLimit) };
  }
}
