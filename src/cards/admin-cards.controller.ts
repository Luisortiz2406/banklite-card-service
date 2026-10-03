import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { Repository } from 'typeorm';
import { StaffAuthGuard } from '../common/staff/staff-auth.guard';
import { Card } from './entities/card.entity';

export class AdminCardsQueryDto {
  @IsOptional() @IsUUID() userId?: string;
  @IsOptional() @IsUUID() accountId?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}

/**
 * Panel administrativo de Card Service (solo lectura). Nunca expone el número
 * completo ni lo descifra: solo los últimos cuatro dígitos.
 */
@Controller('cards/admin')
@UseGuards(StaffAuthGuard)
export class AdminCardsController {
  constructor(@InjectRepository(Card) private readonly cards: Repository<Card>) {}

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
      createdAt: c.createdAt,
    }));
    return { items, total, page, limit };
  }
}
