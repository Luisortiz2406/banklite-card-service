import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CardControlsService } from './card-controls.service';
import { CardPurchaseDto, UpdateDailyLimitDto, UpdateOnlineDto } from './dto/card-controls.dto';

const userOf = (request: Request): string => (request as any).user.idUser;

/** Compras por internet, límite diario y compra simulada con la tarjeta (solo su dueño). */
@Controller('cards')
@UseGuards(JwtAuthGuard)
export class CardControlsController {
  constructor(private readonly controls: CardControlsService) {}

  @Get('purchase-stores')
  stores() {
    return this.controls.stores();
  }

  @Get(':id/controls')
  get(@Param('id', ParseUUIDPipe) id: string, @Req() request: Request) {
    return this.controls.get(id, userOf(request));
  }

  @Patch(':id/controls/online')
  setOnline(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateOnlineDto, @Req() request: Request) {
    return this.controls.setOnline(id, userOf(request), dto.enabled);
  }

  @Patch(':id/controls/daily-limit')
  setDailyLimit(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateDailyLimitDto, @Req() request: Request) {
    return this.controls.setDailyLimit(id, userOf(request), dto);
  }

  @Post(':id/purchases')
  purchase(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CardPurchaseDto, @Req() request: Request) {
    return this.controls.purchase(id, userOf(request), dto);
  }
}
