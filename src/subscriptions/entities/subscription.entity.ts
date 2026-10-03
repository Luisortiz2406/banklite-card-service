import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * pending: recién creada, mientras se cobra el primer mes (si falla se borra).
 * active: se cobra cada mes. paused: no se cobra. suspended: falló el cobro y
 * sus 3 reintentos. cancelled: definitiva.
 */
export type SubscriptionStatus = 'pending' | 'active' | 'paused' | 'suspended' | 'cancelled';

@Entity('subscriptions')
@Index('idx_subscriptions_user', ['userId'])
@Index('idx_subscriptions_due', ['status', 'nextChargeDate'])
// Una sola suscripción viva por cliente y comercio.
@Index('uq_subscriptions_user_merchant', ['userId', 'merchantCode'], { unique: true, where: "status <> 'cancelled'" })
export class Subscription {
  // Se genera antes del primer cobro: forma parte de la clave de idempotencia.
  @PrimaryColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @Column({ name: 'card_id', type: 'uuid' })
  cardId: string;

  @Column({ name: 'merchant_code', type: 'varchar', length: 40 })
  merchantCode: string;

  @Column({ type: 'numeric', precision: 18, scale: 2 })
  amount: string;

  @Column({ type: 'varchar', length: 3 })
  currency: string;

  // Día del mes en que se cobra (1-31). En meses más cortos, el último día.
  @Column({ name: 'billing_day', type: 'smallint' })
  billingDay: number;

  @Column({ type: 'varchar', length: 12 })
  status: SubscriptionStatus;

  // Periodo (YYYY-MM) que falta por cobrar y fecha (Bogotá) del próximo intento.
  @Column({ name: 'pending_period', type: 'varchar', length: 7 })
  pendingPeriod: string;

  @Column({ name: 'next_charge_date', type: 'date' })
  nextChargeDate: string;

  // Reintentos ya hechos del periodo pendiente (máximo 3; luego se suspende).
  @Column({ name: 'retry_count', type: 'smallint', default: 0 })
  retryCount: number;

  // Periodo del que ya se envió el aviso de "próximo cobro".
  @Column({ name: 'reminded_for', type: 'varchar', length: 7, nullable: true })
  remindedFor: string | null;

  @Column({ name: 'last_charged_at', type: 'timestamptz', nullable: true })
  lastChargedAt: Date | null;

  @Column({ name: 'paused_at', type: 'timestamptz', nullable: true })
  pausedAt: Date | null;

  @Column({ name: 'suspended_at', type: 'timestamptz', nullable: true })
  suspendedAt: Date | null;

  @Column({ name: 'cancelled_at', type: 'timestamptz', nullable: true })
  cancelledAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
