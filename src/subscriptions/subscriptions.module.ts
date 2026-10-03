import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Card } from '../cards/entities/card.entity';
import { InternalKeyGuard } from '../common/guards/internal-key.guard';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CardOutbox } from '../events/card-outbox.entity';
import { EventPublisherService } from '../events/event-publisher.service';
import { OutboxService } from '../events/outbox.service';
import { BankingClientService } from './banking-client.service';
import { Merchant } from './entities/merchant.entity';
import { SubscriptionCharge } from './entities/subscription-charge.entity';
import { Subscription } from './entities/subscription.entity';
import { MerchantsService } from './merchants.service';
import { InternalSubscriptionsController, SubscriptionsController } from './subscriptions.controller';
import { SubscriptionsScheduler } from './subscriptions.scheduler';
import { SubscriptionsService } from './subscriptions.service';

@Module({
  imports: [
    ConfigModule,
    JwtModule.register({}),
    TypeOrmModule.forFeature([Subscription, SubscriptionCharge, Merchant, Card, CardOutbox]),
  ],
  controllers: [SubscriptionsController, InternalSubscriptionsController],
  providers: [
    SubscriptionsService,
    SubscriptionsScheduler,
    MerchantsService,
    BankingClientService,
    EventPublisherService,
    OutboxService,
    JwtAuthGuard,
    InternalKeyGuard,
  ],
})
export class SubscriptionsModule {}
