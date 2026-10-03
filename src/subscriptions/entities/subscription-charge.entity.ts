import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/** Historial de intentos de cobro (exitosos y rechazados con su motivo). */
@Entity('subscription_charges')
@Index('idx_subscription_charges_sub', ['subscriptionId', 'createdAt'])
// Un solo cobro exitoso por suscripción y periodo.
@Index('uq_subscription_charges_paid', ['subscriptionId', 'period'], { unique: true, where: "status = 'succeeded'" })
export class SubscriptionCharge {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'subscription_id', type: 'uuid' })
  subscriptionId: string;

  @Column({ type: 'varchar', length: 7 })
  period: string;

  // 1 = cobro del día; 2..4 = reintentos.
  @Column({ type: 'smallint' })
  attempt: number;

  @Column({ type: 'varchar', length: 10 })
  status: 'succeeded' | 'rejected';

  @Column({ type: 'varchar', length: 200, nullable: true })
  reason: string | null;

  @Column({ type: 'numeric', precision: 18, scale: 2 })
  amount: string;

  @Column({ type: 'varchar', length: 3 })
  currency: string;

  @Column({ name: 'ledger_transaction_id', type: 'uuid', nullable: true })
  ledgerTransactionId: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
