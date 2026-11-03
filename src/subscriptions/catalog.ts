/**
 * Catálogo de comercios con los que se puede inscribir una suscripción.
 * Los nombres son ficticios: Banklite es un proyecto académico y no usa
 * marcas reales, y ninguno corresponde a una empresa real de Colombia. Los códigos (netflix, tienda-exito, ...) no cambian: los
 * usan las suscripciones, las compras guardadas y las cuentas de comercio.
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
  { code: 'netflix', name: 'Cineluz', plan: 'Plan Estándar', price: 38900 },
  { code: 'spotify', name: 'Ritmia', plan: 'Individual', price: 18900 },
  { code: 'youtube', name: 'Pantalla Viva', plan: 'Individual', price: 26900 },
  { code: 'prime', name: 'Estreno Plus', plan: 'Mensual', price: 18900 },
  { code: 'max', name: 'Serial+', plan: 'Estándar', price: 32900 },
  { code: 'paramount', name: 'Cumbre Play', plan: 'Mensual', price: 19900 },
  { code: 'crunchyroll', name: 'AnimeCielo', plan: 'Fan', price: 18900 },
  { code: 'applemusic', name: 'Melodía Plus', plan: 'Individual', price: 16900 },
  { code: 'deezer', name: 'Eco Música', plan: 'Premium', price: 16900 },
  { code: 'icloud', name: 'Nubia Drive', plan: '50 GB', price: 3900 },
  { code: 'chatgpt', name: 'Asistente Sabio', plan: 'Mensual', price: 85000 },
  { code: 'duolingo', name: 'LinguaLoro', plan: 'Mensual', price: 29900 },
  { code: 'xbox', name: 'Arcadia Pass', plan: 'Completo', price: 44900 },
  { code: 'playstation', name: 'Consola Total', plan: 'Básico', price: 39900 },
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
  { code: 'tienda-exito', name: 'Supermercado Doña Canasta', channels: ['in_store', 'online'] },
  { code: 'tienda-falabella', name: 'Almacenes Mirador', channels: ['in_store', 'online'] },
  { code: 'tienda-juanvaldez', name: 'Café Cerro Alto', channels: ['in_store'] },
  { code: 'tienda-mercadolibre', name: 'Tienda Vitrina', channels: ['online'] },
  { code: 'tienda-rappi', name: 'Mandaditos Ya', channels: ['online'] },
];

const SUBSCRIPTION_CODES = new Set(SUBSCRIPTION_CATALOG.map((item) => item.code));

export function isSubscriptionMerchant(code: string): boolean {
  return SUBSCRIPTION_CODES.has(code);
}

const CURRENT_NAMES = new Map<string, string>(
  [...SUBSCRIPTION_CATALOG, ...PURCHASE_STORES].map((item) => [item.code, item.name]),
);

/**
 * Nombre vigente de un comercio. Las compras viejas guardaron el nombre de
 * entonces (marca real) en card_authorizations.merchant_name: al mostrarlas se
 * usa el nombre actual del catálogo según el código. La base no se reescribe.
 */
export function currentMerchantName(code: string, stored: string): string {
  return CURRENT_NAMES.get(code) ?? stored;
}
