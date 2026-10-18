import { BadRequestException, ForbiddenException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** Valida la clave dinámica con Auth Service (red interna, INTERNAL_API_KEY). */
@Injectable()
export class DynamicKeyClientService {
  constructor(private readonly config: ConfigService) {}

  async verify(userId: string, code: string): Promise<void> {
    const baseUrl = this.config.get<string>('AUTH_SERVICE_URL', 'http://localhost:3001');
    const key = this.config.get<string>('INTERNAL_API_KEY');
    if (!key) throw new ServiceUnavailableException('INTERNAL_API_KEY no está configurada en Card Service.');

    let response: Response;
    try {
      response = await fetch(`${baseUrl}/internal/dynamic-key/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-internal-key': key },
        body: JSON.stringify({ idUser: userId, code }),
        signal: AbortSignal.timeout(10000),
      });
    } catch {
      throw new ServiceUnavailableException('No se pudo validar la clave dinámica. Inténtalo de nuevo.');
    }

    const payload = await response.json().catch(() => ({}));
    if (response.status === 403 && /clave dinámica/i.test(payload?.message || '')) {
      throw new ForbiddenException(payload.message);
    }
    if (!response.ok)
      throw new ServiceUnavailableException('No se pudo validar la clave dinámica. Inténtalo de nuevo.');
    if (payload?.valid !== true) {
      throw new BadRequestException(payload?.message || 'Clave dinámica incorrecta o vencida.');
    }
  }
}
