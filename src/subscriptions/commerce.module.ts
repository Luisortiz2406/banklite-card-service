import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BankingClientService } from './banking-client.service';
import { Merchant } from './entities/merchant.entity';
import { MerchantsService } from './merchants.service';

/** Comercios (con su cuenta en account-service) y cobros en el ledger: los usan las suscripciones y las compras. */
@Module({
  imports: [ConfigModule, TypeOrmModule.forFeature([Merchant])],
  providers: [MerchantsService, BankingClientService],
  exports: [MerchantsService, BankingClientService],
})
export class CommerceModule {}
