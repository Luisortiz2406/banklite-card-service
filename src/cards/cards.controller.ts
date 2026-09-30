import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { IssueCardDto } from './dto/issue-card.dto';
import { UpdateCardStatusDto } from './dto/update-card-status.dto';
import { CardsService } from './cards.service';

@Controller('cards')
@UseGuards(JwtAuthGuard)
export class CardsController {
  constructor(private readonly cards: CardsService) {}

  @Get()
  list(@Req() request: Request) {
    return this.cards.list((request as any).user.idUser);
  }

  @Post()
  issue(@Body() dto: IssueCardDto, @Req() request: Request) {
    return this.cards.issue(dto, (request as any).user.idUser, (request as any).accessToken);
  }

  @Get(':id/reveal')
  reveal(@Param('id', ParseUUIDPipe) id: string, @Req() request: Request) {
    return this.cards.reveal(id, (request as any).user.idUser);
  }

  @Patch(':id/status')
  updateStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCardStatusDto,
    @Req() request: Request,
  ) {
    return this.cards.updateStatus(id, dto, (request as any).user.idUser);
  }
}