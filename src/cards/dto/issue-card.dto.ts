import { IsUUID } from 'class-validator';

export class IssueCardDto {
  @IsUUID()
  accountId: string;
}