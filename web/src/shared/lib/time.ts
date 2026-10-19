/**
 * Calendar months in HCML's reporting zone, as Unix seconds. Web copy of server/src/sli/time.ts, Intl, not a fixed +7.
 * The zone is the server's SLA_TIMEZONE from /api/health (features/assistant/useAi.ts), Asia/Jakarta until it is known.
 */

export const DEFAULT_REPORT_TZ = 'Asia/Jakarta';

let reportTz = DEFAULT_REPORT_TZ;
const listeners = new Set<() => void>();

const knownZone = (tz: unknown): tz is string => {
  if (typeof tz !== 'string' || !tz) return false;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

/** The zone the reports are cut in. */
export const reportTimeZone = (): string => reportTz;

/** Take the zone the server named; anything else (missing, not a zone) means the default. */
export function setReportTimeZone(tz: unknown): void {
  const next = knownZone(tz) ? tz : DEFAULT_REPORT_TZ;
  if (next === reportTz) return;
  reportTz = next;
  for (const fn of listeners) fn();
}

/** For useSyncExternalStore: told when the zone changes. */
export function subscribeReportTimeZone(fn: () => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

const labelFormats = new Map<string, Intl.DateTimeFormat>();

/** "WIB" for Asia/Jakarta (the Indonesian locale names its three zones); elsewhere Intl's short name, such as "GMT+1". */
export function zoneLabel(atMs: number, tz = reportTz): string {
  let fmt = labelFormats.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-ID', { timeZone: tz, timeZoneName: 'short' });
    labelFormats.set(tz, fmt);
  }
  return fmt.formatToParts(new Date(atMs)).find((p) => p.type === 'timeZoneName')?.value ?? tz;
}

const dateTimeFormats = new Map<string, Intl.DateTimeFormat>();

/** A moment as the browser's locale writes it, but in the report zone and ending in its label, so nobody reads it as their own clock. */
export function formatDateTime(atMs: number, tz = reportTz): string {
  let fmt = dateTimeFormats.get(tz);
  if (!fmt) {
    // The fields Date.toLocaleString() shows by default, so the text reads as it always did.
    fmt = new Intl.DateTimeFormat(undefined, {
      timeZone: tz,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    dateTimeFormats.set(tz, fmt);
  }
  return `${fmt.format(new Date(atMs))} ${zoneLabel(atMs, tz)}`;
}

function offsetSeconds(utcSeconds: number, tz: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(new Date(utcSeconds * 1000))
      .map((p) => [p.type, p.value]),
  );
  const asUtc =
    Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second) / 1000;
  return asUtc - utcSeconds;
}

export function zonedMonthStart(year: number, month: number, tz = reportTz): number {
  const guess = Date.UTC(year, month - 1, 1) / 1000;
  const first = guess - offsetSeconds(guess, tz);
  return guess - offsetSeconds(first, tz);
}

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

export const isMonth = (s: string | null | undefined): s is string => !!s && MONTH_RE.test(s);

export function monthBounds(month: string, tz = reportTz): { from: number; to: number } {
  const m = MONTH_RE.exec(month);
  if (!m) throw new Error(`Bad month: ${month}`);
  const year = Number(m[1]);
  const mon = Number(m[2]);
  const next = mon === 12 ? { year: year + 1, mon: 1 } : { year, mon: mon + 1 };
  return { from: zonedMonthStart(year, mon, tz), to: zonedMonthStart(next.year, next.mon, tz) };
}

export function monthOf(atSeconds: number, tz = reportTz): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit' })
      .formatToParts(new Date(atSeconds * 1000))
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}`;
}

/** The current month and the 11 before it, newest first. */
export function recentMonths(count = 12, tz = reportTz): string[] {
  const out: string[] = [];
  let [y, m] = monthOf(Math.floor(Date.now() / 1000), tz).split('-').map(Number);
  for (let i = 0; i < count; i++) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m -= 1;
    if (m === 0) {
      m = 12;
      y -= 1;
    }
  }
  return out;
}

export function monthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 15)).toLocaleString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}
