import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CardsModule } from '../cards/cards.module';
import { Card } from '../cards/entities/card.entity';
import { InternalKeyGuard } from '../common/guards/internal-key.guard';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { EventsModule } from '../events/events.module';
import { CommerceModule } from './commerce.module';
import { SubscriptionCharge } from './entities/subscription-charge.entity';
import { Subscription } from './entities/subscription.entity';
import { InternalSubscriptionsController, SubscriptionsController } from './subscriptions.controller';
import { SubscriptionsScheduler } from './subscriptions.scheduler';
import { SubscriptionsService } from './subscriptions.service';

@Module({
  imports: [
    ConfigModule,
    JwtModule.register({}),
    TypeOrmModule.forFeature([Subscription, SubscriptionCharge, Card]),
    EventsModule,
    CommerceModule,
    // Los cobros pasan por los controles de la tarjeta (CardAuthorizationService).
    CardsModule,
  ],
  controllers: [SubscriptionsController, InternalSubscriptionsController],
  providers: [SubscriptionsService, SubscriptionsScheduler, JwtAuthGuard, InternalKeyGuard],
})
export class SubscriptionsModule {}
