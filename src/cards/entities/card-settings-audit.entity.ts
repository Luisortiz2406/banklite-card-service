import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/** Registro de cada cambio en los controles de la tarjeta. */
@Entity('card_settings_audit')
@Index('idx_card_settings_audit_card', ['cardId', 'createdAt'])
export class CardSettingsAudit {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'card_id', type: 'uuid' })
  cardId: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @Column({ type: 'varchar', length: 30 })
  field: 'online_enabled' | 'daily_limit';

  @Column({ name: 'old_value', type: 'varchar', length: 40 })
  oldValue: string;

  @Column({ name: 'new_value', type: 'varchar', length: 40 })
  newValue: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
