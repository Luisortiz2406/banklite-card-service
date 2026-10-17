import { IsBoolean, IsIn, IsInt, IsUUID, Matches, Max, Min } from 'class-validator';

export class UpdateOnlineDto {
  @IsBoolean()
  enabled: boolean;
}

export class UpdateDailyLimitDto {
  // El rango real (de $100.000 al límite diario de la cuenta) lo valida el servicio.
  @IsInt({ message: 'El límite debe ser un valor entero en pesos.' })
  @Min(1)
  dailyLimit: number;

  // Clave dinámica de 6 dígitos (cambia cada 60 s). La valida Auth Service.
  @Matches(/^\d{6}$/, { message: 'Ingresa tu clave dinámica de 6 dígitos.' })
  dynamicCode: string;
}

export class CardPurchaseDto {
  @Matches(/^[a-z0-9-]{2,40}$/, { message: 'storeCode no es válido.' })
  storeCode: string;

  @IsIn(['online', 'in_store'], { message: 'channel debe ser online o in_store.' })
  channel: 'online' | 'in_store';

  @IsInt({ message: 'El valor debe ser un entero en pesos.' })
  @Min(1000, { message: 'El valor mínimo de una compra es $1.000.' })
  @Max(50_000_000)
  amount: number;

  // Una por intento: un doble clic reusa la misma y no se cobra dos veces.
  @IsUUID()
  idempotencyKey: string;

  @Matches(/^\d{6}$/, { message: 'Ingresa tu clave dinámica de 6 dígitos.' })
  dynamicCode: string;
}
