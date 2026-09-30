import { IsIn } from 'class-validator';

export class UpdateCardStatusDto {
  @IsIn(['active', 'frozen'])
  status: 'active' | 'frozen';
}