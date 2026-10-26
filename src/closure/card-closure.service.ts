import { Injectable, Logger } from '@nestjs/common';
import { DataSource, Not } from 'typeorm';
import { Card } from '../cards/entities/card.entity';
import { Subscription } from '../subscriptions/entities/subscription.entity';

export interface AccountClosedData {
  idUser: string;
  cerradaEn?: string;
}

/**
 * El cliente canceló su cuenta (evento account.closed de account-service):
 * se cancelan todas sus tarjetas y suscripciones y se borra el número cifrado de
 * las tarjetas (quedan solo los últimos 4 dígitos). Las filas no se borran.
 * Idempotente: procesar el evento dos veces no cambia la primera fecha.
 */
@Injectable()
export class CardClosureService {
  private readonly logger = new Logger('CardClosure');

  constructor(private readonly dataSource: DataSource) {}

  async handleAccountClosed(data: AccountClosedData) {
    const parsed = data.cerradaEn ? new Date(data.cerradaEn) : new Date();
    const cancelledAt = Number.isNaN(parsed.getTime()) ? new Date() : parsed;

    return this.dataSource.transaction(async (manager) => {
      const cards = await manager.update(
        Card,
        { userId: data.idUser, status: Not('cancelled') },
        { status: 'cancelled', cancelledAt, encryptedPan: null },
      );
      // Por si una ya cancelada conservara el número (no debería): se borra igual.
      await manager.update(Card, { userId: data.idUser, status: 'cancelled' }, { encryptedPan: null });
      // Las pendientes (cobrando el primer mes) también: el cobro ya no pasará los controles.
      const subscriptions = await manager.update(
        Subscription,
        { userId: data.idUser, status: Not('cancelled') },
        { status: 'cancelled', cancelledAt },
      );
      const result = { tarjetas: cards.affected ?? 0, suscripciones: subscriptions.affected ?? 0 };
      this.logger.log(
        `Cuenta cancelada: ${result.tarjetas} tarjeta(s) y ${result.suscripciones} suscripción(es) canceladas.`,
      );
      return result;
    });
  }
}
