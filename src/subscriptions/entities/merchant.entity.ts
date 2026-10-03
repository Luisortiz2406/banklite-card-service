import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * Comercios del catálogo y su cuenta de comercio en BankLite. card-service la
 * crea (o la obtiene) en account-service al arrancar; mientras account_id sea
 * nulo, ese comercio no acepta inscripciones.
 */
@Entity('merchants')
export class Merchant {
  @PrimaryColumn({ type: 'varchar', length: 40 })
  code: string;

  @Column({ type: 'varchar', length: 80 })
  name: string;

  @Column({ type: 'varchar', length: 60 })
  plan: string;

  @Column({ type: 'numeric', precision: 18, scale: 2 })
  price: string;

  @Column({ type: 'varchar', length: 3, default: 'COP' })
  currency: string;

  @Column({ name: 'account_id', type: 'uuid', nullable: true })
  accountId: string | null;

  @Column({ name: 'account_number', type: 'varchar', length: 11, nullable: true })
  accountNumber: string | null;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
