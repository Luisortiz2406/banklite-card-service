/**
 * Catálogo de comercios con los que se puede inscribir una suscripción.
 * Cada uno tiene una cuenta de comercio real en BankLite (account-service,
 * accountType 'merchant') a la que llegan los cobros por el ledger.
 * Precios mensuales en COP.
 */
export interface CatalogItem {
  code: string;
  name: string;
  plan: string;
  price: number;
}

export const SUBSCRIPTION_CATALOG: CatalogItem[] = [
  { code: 'netflix', name: 'Netflix', plan: 'Plan Estándar', price: 38900 },
  { code: 'spotify', name: 'Spotify', plan: 'Premium Individual', price: 18900 },
  { code: 'youtube', name: 'YouTube Premium', plan: 'Individual', price: 26900 },
  { code: 'prime', name: 'Prime Video', plan: 'Mensual', price: 18900 },
  { code: 'max', name: 'Max', plan: 'Estándar', price: 32900 },
  { code: 'paramount', name: 'Paramount+', plan: 'Mensual', price: 19900 },
  { code: 'crunchyroll', name: 'Crunchyroll', plan: 'Mega Fan', price: 18900 },
  { code: 'applemusic', name: 'Apple Music', plan: 'Individual', price: 16900 },
  { code: 'deezer', name: 'Deezer', plan: 'Premium', price: 16900 },
  { code: 'icloud', name: 'iCloud+', plan: '50 GB', price: 3900 },
  { code: 'chatgpt', name: 'ChatGPT Plus', plan: 'Mensual', price: 85000 },
  { code: 'duolingo', name: 'Duolingo Super', plan: 'Mensual', price: 29900 },
  { code: 'xbox', name: 'Xbox Game Pass', plan: 'Ultimate', price: 44900 },
  { code: 'playstation', name: 'PlayStation Plus', plan: 'Essential', price: 39900 },
];

/**
 * Comercios para "Simular compra con la tarjeta". También tienen su cuenta de
 * comercio real (la compra se cobra de verdad en el ledger); se guardan en la
 * misma tabla merchants, pero no aparecen en el catálogo de suscripciones.
 */
export interface PurchaseStore {
  code: string;
  name: string;
  channels: ('online' | 'in_store')[];
}

export const PURCHASE_STORES: PurchaseStore[] = [
  { code: 'tienda-exito', name: 'Éxito', channels: ['in_store', 'online'] },
  { code: 'tienda-falabella', name: 'Falabella', channels: ['in_store', 'online'] },
  { code: 'tienda-juanvaldez', name: 'Juan Valdez Café', channels: ['in_store'] },
  { code: 'tienda-mercadolibre', name: 'Mercado Libre', channels: ['online'] },
  { code: 'tienda-rappi', name: 'Rappi', channels: ['online'] },
];

const SUBSCRIPTION_CODES = new Set(SUBSCRIPTION_CATALOG.map((item) => item.code));

export function isSubscriptionMerchant(code: string): boolean {
  return SUBSCRIPTION_CODES.has(code);
}
