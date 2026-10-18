import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BankingClientService } from './banking-client.service';
import { isSubscriptionMerchant, PURCHASE_STORES, SUBSCRIPTION_CATALOG } from './catalog';
import { Merchant } from './entities/merchant.entity';

const RETRY_MS = 30_000;

/**
 * Al arrancar, sincroniza el catálogo (suscripciones y tiendas de compras) en la tabla merchants y se asegura de que
 * cada comercio tenga su cuenta en account-service. Si account-service no está
 * listo, reintenta cada 30 s sin bloquear el arranque del servicio.
 */
@Injectable()
export class MerchantsService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('Merchants');
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @InjectRepository(Merchant) private readonly merchants: Repository<Merchant>,
    private readonly banking: BankingClientService,
  ) {}

  async onApplicationBootstrap() {
    await this.merchants.upsert(
      SUBSCRIPTION_CATALOG.map((item) => ({
        code: item.code,
        name: item.name,
        plan: item.plan,
        price: item.price.toFixed(2),
        currency: 'COP',
      })),
      ['code'],
    );
    await this.merchants.upsert(
      PURCHASE_STORES.map((store) => ({
        code: store.code,
        name: store.name,
        plan: 'Compras con tarjeta',
        price: '0.00',
        currency: 'COP',
      })),
      ['code'],
    );
    void this.ensureAccounts();
  }

  onModuleDestroy() {
    if (this.timer) clearTimeout(this.timer);
  }

  /** Crea las cuentas que falten; true cuando todos los comercios tienen cuenta. */
  async ensureAccounts(): Promise<boolean> {
    const missing = (await this.merchants.find()).filter((merchant) => !merchant.accountId);
    for (const merchant of missing) {
      try {
        const account = await this.banking.ensureMerchantAccount(merchant.code, merchant.name, merchant.currency);
        await this.merchants.update(merchant.code, { accountId: account.id, accountNumber: account.accountNumber });
      } catch (error) {
        this.logger.warn(
          `Cuenta del comercio ${merchant.code} pendiente: ${(error as Error).message}. Reintento en 30 s.`,
        );
        this.timer = setTimeout(() => void this.ensureAccounts(), RETRY_MS);
        return false;
      }
    }
    if (missing.length) this.logger.log(`Cuentas de comercio listas (${missing.length} nuevas).`);
    return true;
  }

  async findAll() {
    return this.merchants.find({ order: { name: 'ASC' } });
  }

  /** Solo los comercios del catálogo de suscripciones. */
  async findSubscriptionMerchants() {
    return (await this.findAll()).filter((merchant) => isSubscriptionMerchant(merchant.code));
  }

  async findByCode(code: string) {
    return this.merchants.findOne({ where: { code } });
  }
}
