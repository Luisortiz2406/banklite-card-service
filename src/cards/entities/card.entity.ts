import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

@Entity('cards')
@Index('idx_cards_user', ['userId'])
export class Card {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index({ unique: true })
  @Column({ name: 'account_id', type: 'uuid' })
  accountId: string;

  @Column({ name: 'account_number', type: 'varchar', length: 11 })
  accountNumber: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @Column({ name: 'pan_encrypted', type: 'text' })
  encryptedPan: string;

  @Column({ name: 'last_four', type: 'varchar', length: 4 })
  lastFour: string;

  @Column({ length: 3 })
  currency: string;

  @Column({ name: 'expiry_month', type: 'smallint' })
  expiryMonth: number;

  @Column({ name: 'expiry_year', type: 'smallint' })
  expiryYear: number;

  @Column({ type: 'varchar', default: 'active' })
  status: 'active' | 'frozen';

  @Column({ type: 'varchar', default: 'virtual' })
  type: 'virtual';

  // Controles de la tarjeta. Columnas nuevas con DEFAULT: las tarjetas que ya
  // existían quedan con compras por internet activas y $5.000.000 (el límite
  // diario por defecto de las cuentas); las nuevas toman el de su cuenta.
  @Column({ name: 'online_enabled', type: 'boolean', default: true })
  onlineEnabled: boolean;

  @Column({ name: 'daily_limit', type: 'numeric', precision: 18, scale: 2, default: 5000000 })
  dailyLimit: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}