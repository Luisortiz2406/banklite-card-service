import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CardAuthorization } from './cards/entities/card-authorization.entity';
import { CardSettingsAudit } from './cards/entities/card-settings-audit.entity';
import { Card } from './cards/entities/card.entity';
import { CardsModule } from './cards/cards.module';
import { CardOutbox } from './events/card-outbox.entity';
import { Merchant } from './subscriptions/entities/merchant.entity';
import { SubscriptionCharge } from './subscriptions/entities/subscription-charge.entity';
import { Subscription } from './subscriptions/entities/subscription.entity';
import { SubscriptionsModule } from './subscriptions/subscriptions.module';
import { HealthController } from './health.controller';
import { validateEnv } from './config/env.validation';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
      validate: validateEnv(
        [
        { key: 'JWT_SECRET', type: 'secret' },
        { key: 'STAFF_JWT_SECRET', type: 'secret' },
        { key: 'CARD_ENCRYPTION_KEY', type: 'hex64' },
        { key: 'INTERNAL_API_KEY', type: 'secret' },
        // Opcional: solo para disparar run-billing a mano (p. ej. "ops:<clave>").
        { key: 'INTERNAL_TRUSTED_KEYS', type: 'trusted-keys', optional: true },
        { key: 'DATABASE_URL', type: 'url' },
        { key: 'RABBITMQ_URL', type: 'url', optional: true },
      ],
        ['JWT_SECRET', 'STAFF_JWT_SECRET', 'CARD_ENCRYPTION_KEY', 'INTERNAL_API_KEY'],
      ),
    }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres' as const,
        url: config.get<string>('DATABASE_URL'),
        entities: [Card, CardAuthorization, CardSettingsAudit, Subscription, SubscriptionCharge, Merchant, CardOutbox],
        synchronize: true,
        logging: false,
      }),
    }),
    ScheduleModule.forRoot(),
    // Antes que CardsModule: sus rutas fijas (/cards/subscriptions) van primero.
    SubscriptionsModule,
    CardsModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}