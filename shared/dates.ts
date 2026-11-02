// Calendar-day arithmetic on 'YYYY-MM-DD' strings. Everything runs on UTC day
// numbers so that no local time zone can move a date.

const DAY = 86_400_000;

export function toDay(iso: string): number {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / DAY);
}

export function fromDay(day: number): string {
  return new Date(day * DAY).toISOString().slice(0, 10);
}

export function addDays(iso: string, n: number): string {
  return fromDay(toDay(iso) + n);
}

/** Whole days from a to b (b - a). */
export function diffDays(a: string, b: string): number {
  return toDay(b) - toDay(a);
}

/** Inclusive span: a task from the 1st to the 1st lasts one day. */
export function spanDays(start: string, end: string): number {
  return diffDays(start, end) + 1;
}

/** Day of week, 0 = Sunday. */
export function weekday(iso: string): number {
  return ((toDay(iso) % 7) + 4 + 7) % 7; // 1970-01-01 was a Thursday
}

/** The Kuwait work week starts on Sunday; weekly updates are keyed by it. */
export function weekStart(iso: string): string {
  return addDays(iso, -weekday(iso));
}

/** Today in Kuwait, where the PMO works - not in the server's zone. */
export function todayIso(timeZone = 'Asia/Kuwait'): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  return parts;
}

export function minIso(a: string, b: string): string {
  return a < b ? a : b;
}

export function maxIso(a: string, b: string): string {
  return a > b ? a : b;
}

export function isIsoDate(v: unknown): v is string {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(toDay(v));
}

export function quarterRange(year: number, q: number): { startsOn: string; endsOn: string } {
  const startMonth = (q - 1) * 3;
  const start = new Date(Date.UTC(year, startMonth, 1));
  const end = new Date(Date.UTC(year, startMonth + 3, 0));
  return { startsOn: start.toISOString().slice(0, 10), endsOn: end.toISOString().slice(0, 10) };
}
