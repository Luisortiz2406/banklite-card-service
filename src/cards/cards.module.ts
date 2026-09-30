import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AccountsClientService } from './accounts-client.service';
import { CardCryptoService } from './card-crypto.service';
import { Card } from './entities/card.entity';
import { CardsController } from './cards.controller';
import { CardsService } from './cards.service';

@Module({
  imports: [ConfigModule, JwtModule.register({}), TypeOrmModule.forFeature([Card])],
  controllers: [CardsController],
  providers: [CardsService, AccountsClientService, CardCryptoService, JwtAuthGuard],
})
export class CardsModule {}