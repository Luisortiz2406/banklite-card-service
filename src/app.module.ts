import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Card } from './cards/entities/card.entity';
import { CardsModule } from './cards/cards.module';
import { CardOutbox } from './events/card-outbox.entity';
import { Merchant } from './subscriptions/entities/merchant.entity';
import { SubscriptionCharge } from './subscriptions/entities/subscription-charge.entity';
import { Subscription } from './subscriptions/entities/subscription.entity';
import { SubscriptionsModule } from './subscriptions/subscriptions.module';
import { HealthController } from './health.controller';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: '.env' }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres' as const,
        url: config.get<string>('DATABASE_URL'),
        entities: [Card, Subscription, SubscriptionCharge, Merchant, CardOutbox],
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