import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { callService } from '../common/http/internal-http';

/**
 * Valida la clave dinámica con Auth Service (red interna, INTERNAL_API_KEY).
 * Errores: regla común de common/http/internal-http.ts.
 */
@Injectable()
export class DynamicKeyClientService {
  constructor(private readonly config: ConfigService) {}

  async verify(userId: string, code: string): Promise<void> {
    const baseUrl = this.config.get<string>('AUTH_SERVICE_URL', 'http://localhost:3001');
    const key = this.config.get<string>('INTERNAL_API_KEY');
    if (!key) throw new ServiceUnavailableException('INTERNAL_API_KEY no está configurada en Card Service.');
    const payload = await callService<{ valid?: boolean; message?: string }>(
      `${baseUrl}/internal/dynamic-key/verify`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-internal-key': key },
        body: JSON.stringify({ idUser: userId, code }),
      },
      {
        service: 'Auth Service',
        internal: true,
        unavailable: 'No se pudo validar la clave dinámica. Inténtalo de nuevo.',
      },
    );
    if (payload?.valid !== true) {
      throw new BadRequestException(payload?.message || 'Clave dinámica incorrecta o vencida.');
    }
  }
}
