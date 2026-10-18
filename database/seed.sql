-- Datos de ejemplo de card_db (card-service). Escenario de demo compartido por todos
-- los microservicios (mismos UUID): Ana Pérez y Carlos Gómez, clientes de prueba,
-- y una cuenta de comercio. Datos inventados: no son personas ni documentos reales.
-- Cargar después del esquema:  psql "$DATABASE_URL" -f database/schema.sql -f database/seed.sql
-- (si la base ya tiene estas filas, ON CONFLICT DO NOTHING las deja como están)

BEGIN;
-- El número completo de la tarjeta se cifra con CARD_ENCRYPTION_KEY de cada entorno,
-- así que esta tarjeta de ejemplo no se puede revelar ('demo:no-revelable'): se ve en
-- listados y controles. Los comercios de suscripciones los crea el servicio al arrancar.
INSERT INTO public.cards (id, account_id, account_number, user_id, pan_encrypted, last_four, currency, expiry_month, expiry_year, status, type, online_enabled, daily_limit, created_at) VALUES
  ('41000000-0000-4000-8000-000000000001', '3a000000-0000-4000-8000-000000000001', '10000000001', '11111111-1111-4111-8111-111111111111', 'demo:no-revelable', '0001', 'COP', 10, 2030, 'active', 'virtual', true, 5000000, '2026-10-01 10:30:00-05')
ON CONFLICT DO NOTHING;

COMMIT;
