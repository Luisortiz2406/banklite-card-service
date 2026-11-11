import { randomUUID } from 'crypto';
import { ConfigService } from '@nestjs/config';
import { AccountsClientService } from '../cards/accounts-client.service';
import { CardAuthorizationService } from '../cards/card-authorization.service';
import { CardAuthorization } from '../cards/entities/card-authorization.entity';
import { CardSettingsAudit } from '../cards/entities/card-settings-audit.entity';
import { Card } from '../cards/entities/card.entity';
import { CardOutbox } from '../events/card-outbox.entity';
import { EventPublisherService } from '../events/event-publisher.service';
import { OutboxService } from '../events/outbox.service';
import { BankingClientService, PaymentResult } from '../subscriptions/banking-client.service';
import { Merchant } from '../subscriptions/entities/merchant.entity';
import { SubscriptionCharge } from '../subscriptions/entities/subscription-charge.entity';
import { Subscription } from '../subscriptions/entities/subscription.entity';
import { MerchantsService } from '../subscriptions/merchants.service';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { createTestDatabase } from './test-database';

/**
 * Servicios de card reales sobre una base PostgreSQL temporal. El ledger
 * (banking.pay) y el límite diario de la cuenta (account-service) se simulan.
 */

export const ANA = '11111111-1111-4111-8111-111111111111';
export const CARLOS = '22222222-2222-4222-8222-222222222222';

export async function createCardFixture() {
  const { dataSource, drop } = await createTestDatabase('card', [
    Card,
    CardAuthorization,
    CardSettingsAudit,
    CardOutbox,
    Merchant,
    Subscription,
    SubscriptionCharge,
  ]);
  const cards = dataSource.getRepository(Card);
  const merchantRepo = dataSource.getRepository(Merchant);
  const subscriptionRepo = dataSource.getRepository(Subscription);
  const chargeRepo = dataSource.getRepository(SubscriptionCharge);
  const authorizationRepo = dataSource.getRepository(CardAuthorization);
  const outboxRepo = dataSource.getRepository(CardOutbox);

  const state = { accountDailyLimit: 5_000_000 };
  const accounts = { getAccountDailyLimit: jest.fn(async (_accountId: string) => state.accountDailyLimit) };
  const banking = {
    pay: jest.fn(async (_params: unknown): Promise<PaymentResult> => ({
      kind: 'approved',
      transactionId: randomUUID(),
    })),
    ensureMerchantAccount: jest.fn(async (code: string) => ({
      id: randomUUID(),
      accountNumber: '90000000001',
      currency: 'COP',
      status: 'active',
      code,
    })),
  };
  const publisher = { isReady: jest.fn(() => false), publish: jest.fn() };
  const outbox = new OutboxService(dataSource, publisher as unknown as EventPublisherService);
  const authorizations = new CardAuthorizationService(dataSource, outbox, accounts as unknown as AccountsClientService);
  const merchants = new MerchantsService(merchantRepo, banking as unknown as BankingClientService);
  const subscriptions = new SubscriptionsService(
    dataSource,
    subscriptionRepo,
    chargeRepo,
    cards,
    merchants,
    banking as unknown as BankingClientService,
    outbox,
    authorizations,
  );

  const addMerchant = (code: string, overrides: Partial<Merchant> = {}) =>
    merchantRepo.save(
      merchantRepo.create({
        code,
        name: code,
        plan: 'Plan',
        price: '10000.00',
        currency: 'COP',
        accountId: randomUUID(),
        accountNumber: '90000000001',
        ...overrides,
      }),
    );
  const addCard = (userId: string, overrides: Partial<Card> = {}) =>
    cards.save(
      cards.create({
        accountId: randomUUID(),
        accountNumber: `1${Math.floor(1_000_000_000 + Math.random() * 8_999_999_999)}`,
        userId,
        lastFour: '4242',
        currency: 'COP',
        expiryMonth: 12,
        expiryYear: 2030,
        status: 'active',
        type: 'virtual',
        onlineEnabled: true,
        dailyLimit: '5000000.00',
        ...overrides,
      }),
    );

  return {
    dataSource,
    drop,
    cards,
    merchantRepo,
    subscriptionRepo,
    chargeRepo,
    authorizationRepo,
    outboxRepo,
    state,
    accounts,
    banking,
    publisher,
    outbox,
    authorizations,
    merchants,
    subscriptions,
    config: (env: Record<string, string> = {}) => new ConfigService(env),
    addMerchant,
    addCard,
  };
}
