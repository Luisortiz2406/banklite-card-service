import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CardOutbox } from './card-outbox.entity';
import { EventPublisherService } from './event-publisher.service';
import { OutboxService } from './outbox.service';

/** Un solo publicador y un solo relevo del outbox para todo el servicio. */
@Module({
  imports: [ConfigModule, TypeOrmModule.forFeature([CardOutbox])],
  providers: [EventPublisherService, OutboxService],
  exports: [OutboxService],
})
export class EventsModule {}
