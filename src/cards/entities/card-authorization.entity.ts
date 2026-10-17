import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export type CardChannel = 'online' | 'in_store';
export type CardChargeSource = 'purchase' | 'subscription';

/**
 * pending: aprobada por los controles de la tarjeta, esperando al ledger (ya
 * cuenta en el límite del día). approved: el ledger cobró. declined: rechazada
 * por la tarjeta o por el ledger (saldo, límites de la cuenta), con su motivo.
 * error: el ledger no respondió; no cuenta y se puede reintentar con la misma clave.
 */
export type CardAuthorizationStatus = 'pending' | 'approved' | 'declined' | 'error';

/** Cada intento de cargo con la tarjeta (compras y cobros de suscripciones). */
@Entity('card_authorizations')
@Index('idx_card_authorizations_day', ['cardId', 'bogotaDate'])
// Una sola autorización viva por clave; los rechazos y errores quedan como historial.
@Index('uq_card_authorizations_key', ['idempotencyKey'], { unique: true, where: "status IN ('pending', 'approved')" })
export class CardAuthorization {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'card_id', type: 'uuid' })
  cardId: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @Column({ type: 'numeric', precision: 18, scale: 2 })
  amount: string;

  @Column({ type: 'varchar', length: 3 })
  currency: string;

  @Column({ type: 'varchar', length: 10 })
  channel: CardChannel;

  @Column({ type: 'varchar', length: 15 })
  source: CardChargeSource;

  @Column({ name: 'merchant_code', type: 'varchar', length: 40 })
  merchantCode: string;

  @Column({ name: 'merchant_name', type: 'varchar', length: 80 })
  merchantName: string;

  @Column({ type: 'varchar', length: 10 })
  status: CardAuthorizationStatus;

  @Column({ type: 'varchar', length: 200, nullable: true })
  reason: string | null;

  // Clave de idempotencia del cobro en el ledger.
  @Column({ name: 'idempotency_key', type: 'uuid' })
  idempotencyKey: string;

  @Column({ name: 'ledger_transaction_id', type: 'uuid', nullable: true })
  ledgerTransactionId: string | null;

  // Día (hora de Colombia) al que se carga en el límite diario.
  @Column({ name: 'bogota_date', type: 'date' })
  bogotaDate: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
