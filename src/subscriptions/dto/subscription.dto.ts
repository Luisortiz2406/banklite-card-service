import { IsOptional, IsUUID, Matches } from 'class-validator';

export class EnrollSubscriptionDto {
  @IsUUID()
  cardId: string;

  @Matches(/^[a-z0-9-]{2,40}$/, { message: 'merchantCode no es válido.' })
  merchantCode: string;
}

/** Ejecución a demanda de la tarea diaria (solo red interna). */
export class RunBillingDto {
  // Fecha de cobro (Bogotá) a procesar; por defecto, hoy.
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date debe tener el formato YYYY-MM-DD.' })
  date?: string;
}
