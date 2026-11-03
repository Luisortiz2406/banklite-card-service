import { currentMerchantName, PURCHASE_STORES, SUBSCRIPTION_CATALOG } from './catalog';

describe('catálogo de comercios', () => {
  const all = [...SUBSCRIPTION_CATALOG, ...PURCHASE_STORES];

  it('no usa marcas reales', () => {
    const brands =
      /netflix|spotify|youtube|prime|\bmax\b|paramount|crunchyroll|apple|deezer|icloud|chatgpt|duolingo|xbox|playstation|éxito|exito|falabella|juan valdez|mercado libre|rappi/i;
    expect(all.filter((item) => brands.test(item.name)).map((item) => item.name)).toEqual([]);
  });

  it('los códigos no cambian (los usan las suscripciones y las cuentas de comercio)', () => {
    const codes = all.map((item) => item.code);
    expect(codes).toEqual(expect.arrayContaining(['netflix', 'spotify', 'tienda-exito', 'tienda-rappi']));
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('una compra vieja se muestra con el nombre vigente según su código', () => {
    expect(currentMerchantName('tienda-exito', 'Éxito')).toBe('Supermercado Demo La Canasta');
    expect(currentMerchantName('netflix', 'Netflix')).toBe('Cine Demo Estelar');
    // Un código que ya no está en el catálogo conserva lo guardado.
    expect(currentMerchantName('tienda-cerrada', 'Tienda vieja')).toBe('Tienda vieja');
  });
});
