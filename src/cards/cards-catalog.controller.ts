import { Controller, Get } from '@nestjs/common';
import { MIN_DAILY_LIMIT } from './card-controls.service';

/**
 * Límites de la tarjeta, públicos (sin sesión): los usan los términos y Banki.
 * El máximo del límite diario es el límite diario de cada cuenta (account-service).
 */
@Controller('cards')
export class CardsCatalogController {
  @Get('catalog')
  catalog() {
    return { dailyLimit: { min: MIN_DAILY_LIMIT } };
  }
}
