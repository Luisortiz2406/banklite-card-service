import { Controller, Get, NotFoundException, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { In, Repository } from 'typeorm';
import { StaffAuthGuard, StaffRoles } from '../common/staff/staff-auth.guard';
import { CardAuthorization } from './entities/card-authorization.entity';
import { Card } from './entities/card.entity';

export class AdminCardsQueryDto {
  @IsOptional() @IsUUID() userId?: string;
  @IsOptional() @IsUUID() accountId?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}

const DECLINES_LIMIT = 50;

/**
 * Panel administrativo de Card Service (solo lectura). Nunca expone el número
 * completo ni lo descifra: solo los últimos cuatro dígitos.
 * Lo ven Soporte, Cumplimiento (las alertas de fraude suelen venir de compras
 * con tarjeta) y Administración. Las acciones que se agreguen sobre tarjetas
 * serán solo para Soporte y Administración.
 */
@Controller('cards/admin')
@UseGuards(StaffAuthGuard)
@StaffRoles('support', 'compliance', 'admin')
export class AdminCardsController {
  constructor(
    @InjectRepository(Card) private readonly cards: Repository<Card>,
    @InjectRepository(CardAuthorization) private readonly authorizations: Repository<CardAuthorization>,
  ) {}

  @Get('cards')
  async list(@Query() q: AdminCardsQueryDto) {
    const page = q.page ?? 1;
    const limit = q.limit ?? 25;
    const [rows, total] = await this.cards.findAndCount({
      where: { ...(q.userId ? { userId: q.userId } : {}), ...(q.accountId ? { accountId: q.accountId } : {}) },
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });

    // Intentos de cargo rechazados por tarjeta (para ubicar rápido las que tienen actividad sospechosa)
    const declined = rows.length
      ? await this.authorizations
          .createQueryBuilder('a')
          .select('a.cardId', 'cardId')
          .addSelect('COUNT(*)', 'count')
          .where({ cardId: In(rows.map((c) => c.id)), status: 'declined' })
          .groupBy('a.cardId')
          .getRawMany<{ cardId: string; count: string }>()
      : [];
    const declinedBy = new Map(declined.map((d) => [d.cardId, Number(d.count)]));

    const items = rows.map((c) => ({
      id: c.id,
      userId: c.userId,
      accountId: c.accountId,
      accountNumber: c.accountNumber,
      lastFour: c.lastFour,
      currency: c.currency,
      expiry: `${String(c.expiryMonth).padStart(2, '0')}/${String(c.expiryYear).slice(-2)}`,
      status: c.status,
      type: c.type,
      declinedCount: declinedBy.get(c.id) ?? 0,
      createdAt: c.createdAt,
    }));
    return { items, total, page, limit };
  }

  /** Últimos intentos de cargo rechazados de una tarjeta (comercio, monto, canal y motivo). */
  @Get('cards/:id/declines')
  async declines(@Param('id', new ParseUUIDPipe()) id: string) {
    const card = await this.cards.findOne({ where: { id } });
    if (!card) throw new NotFoundException('Tarjeta no encontrada.');
    const rows = await this.authorizations.find({
      where: { cardId: id, status: 'declined' },
      order: { createdAt: 'DESC' },
      take: DECLINES_LIMIT,
    });
    return {
      card: { id: card.id, lastFour: card.lastFour, status: card.status },
      items: rows.map((a) => ({
        id: a.id,
        amount: Number(a.amount),
        currency: a.currency,
        channel: a.channel,
        source: a.source,
        merchantName: a.merchantName,
        reason: a.reason,
        createdAt: a.createdAt,
      })),
    };
  }
}
