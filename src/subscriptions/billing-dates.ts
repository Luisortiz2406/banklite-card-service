import { createHash } from 'crypto';

/**
 * Fechas de cobro en hora de Colombia. Railway corre en UTC, así que "hoy"
 * siempre se calcula con la zona America/Bogota explícita. Las fechas se
 * manejan como texto 'YYYY-MM-DD' y los periodos como 'YYYY-MM'.
 */
export const BILLING_TIME_ZONE = 'America/Bogota';

export function bogotaToday(now = new Date()): string {
  // en-CA formatea como YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: BILLING_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

export function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function periodOf(date: string): string {
  return date.slice(0, 7);
}

export function nextPeriod(period: string): string {
  const [year, month] = period.split('-').map(Number);
  return month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, '0')}`;
}

/** Fecha de cobro de un periodo: el día de cobro, o el último día si el mes es más corto. */
export function dueDate(period: string, billingDay: number): string {
  const [year, month] = period.split('-').map(Number);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${period}-${String(Math.min(billingDay, daysInMonth)).padStart(2, '0')}`;
}

/** Primer periodo cuya fecha de cobro es hoy o después (para reanudar sin cobrar meses en pausa). */
export function firstPeriodOnOrAfter(today: string, billingDay: number): string {
  const current = periodOf(today);
  return dueDate(current, billingDay) >= today ? current : nextPeriod(current);
}

// Espacio de nombres propio de BankLite para las claves de idempotencia (UUID v5).
const NAMESPACE = Buffer.from('6f1c2a4e8b3d4f5aa1c27d9e0b4f3c21', 'hex');

/**
 * UUID v5 determinista: el mismo nombre (suscripción + periodo) siempre da la
 * misma clave, así el ledger nunca registra dos veces el cobro de un periodo.
 */
export function uuidV5(name: string): string {
  const hash = createHash('sha1').update(NAMESPACE).update(name).digest();
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function chargeKey(subscriptionId: string, period: string): string {
  return uuidV5(`subscription:${subscriptionId}:${period}`);
}
