// Time in the generator = whole minutes of LOCAL wall-clock time (Europe/Kyiv) since START 00:00.
// Rows carry 'YYYY-MM-DD HH:MM' without an offset and the COPY session runs with TimeZone = 'Europe/Kyiv', so
// PostgreSQL applies DST. No generated boundary falls into 03:00–04:00, the only ambiguous / missing local hour.

export const START_DATE = '2025-11-01'; // one year of data: [START, END)
export const DAYS = 365;
export const DAY = 1440;
export const HOUR = 60;
export const END_MIN = DAYS * DAY;

const startUtc = Date.parse(`${START_DATE}T00:00:00Z`);
const dateCache = new Map<number, string>();

/** Calendar date of day d (d may be negative). */
export function dateOf(d: number): string {
  let s = dateCache.get(d);
  if (!s) {
    s = new Date(startUtc + d * 86_400_000).toISOString().slice(0, 10);
    dateCache.set(d, s);
  }
  return s;
}

/** ISO weekday 1 = Monday … 7 = Sunday of day d. */
export function isoDow(d: number): number {
  const w = new Date(startUtc + d * 86_400_000).getUTCDay();
  return w === 0 ? 7 : w;
}

const pad = (n: number) => (n < 10 ? `0${n}` : String(n));

/** minutes since START → 'YYYY-MM-DD HH:MM' (local wall clock). */
export function ts(m: number): string {
  const d = Math.floor(m / DAY);
  const r = m - d * DAY;
  return `${dateOf(d)} ${pad(Math.floor(r / HOUR))}:${pad(r % HOUR)}`;
}

/** Move a moment into the daytime window [08:00, 22:00) of the same or the next day (admissions / discharges). */
export function daytime(m: number): number {
  const d = Math.floor(m / DAY);
  const r = m - d * DAY;
  if (r < 8 * HOUR) return d * DAY + 8 * HOUR;
  if (r >= 22 * HOUR) return (d + 1) * DAY + 8 * HOUR;
  return m;
}
