/**
 * Catálogo de comercios con los que se puede inscribir una suscripción.
 * Los nombres son inventados ("Demo"): Banklite es un proyecto académico y no
 * usa marcas reales. Los códigos (netflix, tienda-exito, ...) no cambian: los
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
  { code: 'netflix', name: 'Cine Demo Estelar', plan: 'Plan Estándar', price: 38900 },
  { code: 'spotify', name: 'Música Demo Sonar', plan: 'Individual', price: 18900 },
  { code: 'youtube', name: 'Video Demo Arcoíris', plan: 'Individual', price: 26900 },
  { code: 'prime', name: 'Cine Demo Prisma', plan: 'Mensual', price: 18900 },
  { code: 'max', name: 'Series Demo Aurora', plan: 'Estándar', price: 32900 },
  { code: 'paramount', name: 'Cine Demo Cumbre', plan: 'Mensual', price: 19900 },
  { code: 'crunchyroll', name: 'Anime Demo Sakura', plan: 'Fan', price: 18900 },
  { code: 'applemusic', name: 'Música Demo Ritmo', plan: 'Individual', price: 16900 },
  { code: 'deezer', name: 'Música Demo Eco', plan: 'Premium', price: 16900 },
  { code: 'icloud', name: 'Nube Demo Cirro', plan: '50 GB', price: 3900 },
  { code: 'chatgpt', name: 'Asistente Demo IA', plan: 'Mensual', price: 85000 },
  { code: 'duolingo', name: 'Idiomas Demo Loro', plan: 'Mensual', price: 29900 },
  { code: 'xbox', name: 'Juegos Demo Arcade', plan: 'Completo', price: 44900 },
  { code: 'playstation', name: 'Juegos Demo Consola', plan: 'Básico', price: 39900 },
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
  { code: 'tienda-exito', name: 'Supermercado Demo La Canasta', channels: ['in_store', 'online'] },
  { code: 'tienda-falabella', name: 'Almacén Demo Plaza', channels: ['in_store', 'online'] },
  { code: 'tienda-juanvaldez', name: 'Café Demo Montaña', channels: ['in_store'] },
  { code: 'tienda-mercadolibre', name: 'Tienda en línea Demo Mercadito', channels: ['online'] },
  { code: 'tienda-rappi', name: 'Domicilios Demo Rápido', channels: ['online'] },
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
