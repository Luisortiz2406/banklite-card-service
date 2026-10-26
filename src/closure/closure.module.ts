import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AccountClosedConsumer } from './account-closed.consumer';
import { CardClosureService } from './card-closure.service';

/** Cuenta cancelada por el cliente: escucha account.closed y cancela sus tarjetas y suscripciones. */
@Module({
  imports: [ConfigModule],
  providers: [CardClosureService, AccountClosedConsumer],
})
export class ClosureModule {}
