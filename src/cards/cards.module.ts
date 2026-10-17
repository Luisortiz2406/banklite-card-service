import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { StaffAuthGuard } from '../common/staff/staff-auth.guard';
import { EventsModule } from '../events/events.module';
import { CommerceModule } from '../subscriptions/commerce.module';
import { AccountsClientService } from './accounts-client.service';
import { AdminCardsController } from './admin-cards.controller';
import { CardAuthorizationService } from './card-authorization.service';
import { CardControlsController } from './card-controls.controller';
import { CardControlsService } from './card-controls.service';
import { CardCryptoService } from './card-crypto.service';
import { CardsController } from './cards.controller';
import { CardsService } from './cards.service';
import { DynamicKeyClientService } from './dynamic-key-client.service';
import { CardAuthorization } from './entities/card-authorization.entity';
import { CardSettingsAudit } from './entities/card-settings-audit.entity';
import { Card } from './entities/card.entity';

@Module({
  imports: [
    ConfigModule,
    JwtModule.register({}),
    TypeOrmModule.forFeature([Card, CardAuthorization, CardSettingsAudit]),
    EventsModule,
    CommerceModule,
  ],
  controllers: [AdminCardsController, CardControlsController, CardsController],
  providers: [
    CardsService,
    CardControlsService,
    CardAuthorizationService,
    AccountsClientService,
    CardCryptoService,
    DynamicKeyClientService,
    JwtAuthGuard,
    StaffAuthGuard,
  ],
  exports: [CardAuthorizationService],
})
export class CardsModule {}
