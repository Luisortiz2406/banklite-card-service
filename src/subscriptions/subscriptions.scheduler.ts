import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { BILLING_TIME_ZONE } from './billing-dates';
import { SubscriptionsService } from './subscriptions.service';

// Al arrancar se recupera lo que no se cobró si el servicio estuvo caído a las 6:00.
const CATCH_UP_DELAY_MS = 20_000;

/**
 * Tarea diaria de cobro de suscripciones: todos los días a las 6:00 a. m. hora
 * de Colombia. La zona va explícita porque Railway corre en UTC.
 */
@Injectable()
export class SubscriptionsScheduler implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('SubscriptionsScheduler');
  private catchUp: NodeJS.Timeout | null = null;

  constructor(private readonly subscriptions: SubscriptionsService) {}

  onApplicationBootstrap() {
    this.catchUp = setTimeout(() => void this.run('arranque'), CATCH_UP_DELAY_MS);
  }

  onModuleDestroy() {
    if (this.catchUp) clearTimeout(this.catchUp);
  }

  @Cron('0 0 6 * * *', { name: 'subscriptions-billing', timeZone: BILLING_TIME_ZONE })
  daily() {
    return this.run('cron diario');
  }

  private async run(origin: string) {
    try {
      await this.subscriptions.runBilling();
    } catch (error) {
      this.logger.error(`Falló el cobro de suscripciones (${origin}): ${(error as Error).message}`);
    }
  }
}
