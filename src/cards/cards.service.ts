import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AccountsClientService } from './accounts-client.service';
import { CardCryptoService } from './card-crypto.service';
import { IssueCardDto } from './dto/issue-card.dto';
import { UpdateCardStatusDto } from './dto/update-card-status.dto';
import { Card } from './entities/card.entity';

@Injectable()
export class CardsService {
  constructor(
    @InjectRepository(Card) private readonly cards: Repository<Card>,
    private readonly accounts: AccountsClientService,
    private readonly crypto: CardCryptoService,
  ) {}

  async list(userId: string) {
    const cards = await this.cards.find({ where: { userId }, order: { createdAt: 'DESC' } });
    return cards.map((card) => this.publicCard(card));
  }

  async issue(dto: IssueCardDto, userId: string, accessToken: string) {
    const account = await this.accounts.getOwnedAccount(dto.accountId, accessToken);
    if (account.status !== 'active')
      throw new BadRequestException('La cuenta debe estar activa para emitir una tarjeta.');

    const existing = await this.cards.findOne({ where: { accountId: account.id } });
    if (existing) {
      if (existing.userId !== userId) throw new ForbiddenException('No puedes acceder a esta tarjeta.');
      return { ...this.publicCard(existing), alreadyIssued: true, cardNumber: null, cvv: null };
    }

    // El límite diario de compras arranca en el límite diario de la cuenta.
    const dailyLimit = await this.accounts.getAccountDailyLimit(account.id);

    const credentials = this.crypto.createCredentials();
    const card = this.cards.create({
      accountId: account.id,
      accountNumber: account.accountNumber,
      userId,
      encryptedPan: this.crypto.encrypt(credentials.pan),
      lastFour: credentials.pan.slice(-4),
      currency: account.currency,
      expiryMonth: credentials.expiryMonth,
      expiryYear: credentials.expiryYear,
      status: 'active',
      type: 'virtual',
      onlineEnabled: true,
      dailyLimit: dailyLimit.toFixed(2),
    });
    try {
      await this.cards.save(card);
    } catch (error) {
      if ((error as any)?.code !== '23505') throw error;
      const raced = await this.cards.findOne({ where: { accountId: account.id } });
      if (!raced || raced.userId !== userId) throw new ConflictException('No se pudo emitir la tarjeta.');
      return { ...this.publicCard(raced), alreadyIssued: true, cardNumber: null, cvv: null };
    }

    return {
      ...this.publicCard(card),
      alreadyIssued: false,
      cardNumber: credentials.pan,
      cvv: credentials.cvv,
    };
  }

  async reveal(cardId: string, userId: string) {
    const card = await this.findOwnedCard(cardId, userId);
    if (card.status === 'cancelled' || !card.encryptedPan) throw new ConflictException('La tarjeta fue cancelada.');
    return {
      id: card.id,
      cardNumber: this.crypto.decrypt(card.encryptedPan),
      expiryMonth: card.expiryMonth,
      expiryYear: card.expiryYear,
      status: card.status,
    };
  }

  async updateStatus(cardId: string, dto: UpdateCardStatusDto, userId: string) {
    const card = await this.findOwnedCard(cardId, userId);
    if (card.status === 'cancelled') throw new ConflictException('La tarjeta fue cancelada y no se puede reactivar.');
    card.status = dto.status;
    await this.cards.save(card);
    return this.publicCard(card);
  }

  private async findOwnedCard(cardId: string, userId: string) {
    const card = await this.cards.findOne({ where: { id: cardId } });
    if (!card) throw new NotFoundException('Tarjeta no encontrada.');
    if (card.userId !== userId) throw new ForbiddenException('No puedes acceder a esta tarjeta.');
    return card;
  }

  private publicCard(card: Card) {
    return {
      id: card.id,
      accountId: card.accountId,
      accountNumber: card.accountNumber,
      lastFour: card.lastFour,
      currency: card.currency,
      expiryMonth: card.expiryMonth,
      expiryYear: card.expiryYear,
      status: card.status,
      type: card.type,
      onlineEnabled: card.onlineEnabled,
      dailyLimit: Number(card.dailyLimit),
      createdAt: card.createdAt,
    };
  }
}
