import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { InternalKeyGuard } from '../common/guards/internal-key.guard';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { isIsoDate } from './billing-dates';
import { EnrollSubscriptionDto, RunBillingDto } from './dto/subscription.dto';
import { SubscriptionsService } from './subscriptions.service';

const userOf = (request: Request): string => (request as any).user.idUser;

/** Suscripciones del cliente (cobros mensuales a su tarjeta). */
@Controller('cards/subscriptions')
@UseGuards(JwtAuthGuard)
export class SubscriptionsController {
  constructor(private readonly subscriptions: SubscriptionsService) {}

  @Get('catalog')
  catalog() {
    return this.subscriptions.catalog();
  }

  @Get()
  list(@Req() request: Request) {
    return this.subscriptions.list(userOf(request));
  }

  @Post()
  enroll(@Body() dto: EnrollSubscriptionDto, @Req() request: Request) {
    return this.subscriptions.enroll(userOf(request), dto);
  }

  @Get(':id/charges')
  charges(@Param('id', ParseUUIDPipe) id: string, @Req() request: Request) {
    return this.subscriptions.charges(userOf(request), id);
  }

  @Post(':id/pause')
  @HttpCode(HttpStatus.OK)
  pause(@Param('id', ParseUUIDPipe) id: string, @Req() request: Request) {
    return this.subscriptions.pause(userOf(request), id);
  }

  @Post(':id/resume')
  @HttpCode(HttpStatus.OK)
  resume(@Param('id', ParseUUIDPipe) id: string, @Req() request: Request) {
    return this.subscriptions.resume(userOf(request), id);
  }

  @Delete(':id')
  cancel(@Param('id', ParseUUIDPipe) id: string, @Req() request: Request) {
    return this.subscriptions.cancel(userOf(request), id);
  }
}

/**
 * Ejecuta a demanda la misma tarea del cron (p. ej. para la presentación).
 * Solo red interna: INTERNAL_API_KEY y el gateway no publica /internal.
 */
@Controller('internal/subscriptions')
@UseGuards(InternalKeyGuard)
export class InternalSubscriptionsController {
  constructor(private readonly subscriptions: SubscriptionsService) {}

  @Post('run-billing')
  @HttpCode(HttpStatus.OK)
  runBilling(@Body() dto: RunBillingDto) {
    if (dto.date && !isIsoDate(dto.date)) throw new BadRequestException('date no es una fecha válida.');
    return this.subscriptions.runBilling(dto.date);
  }
}
