/**
 * Calendar months in HCML's reporting zone (Asia/Jakarta), as Unix seconds.
 * Web copy of server/src/sli/time.ts, Intl, not a fixed +7, so it stays right
 * for any zone.
 */

export const REPORT_TZ = 'Asia/Jakarta';

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

export function zonedMonthStart(year: number, month: number, tz = REPORT_TZ): number {
  const guess = Date.UTC(year, month - 1, 1) / 1000;
  const first = guess - offsetSeconds(guess, tz);
  return guess - offsetSeconds(first, tz);
}

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

export const isMonth = (s: string | null | undefined): s is string => !!s && MONTH_RE.test(s);

export function monthBounds(month: string, tz = REPORT_TZ): { from: number; to: number } {
  const m = MONTH_RE.exec(month);
  if (!m) throw new Error(`Bad month: ${month}`);
  const year = Number(m[1]);
  const mon = Number(m[2]);
  const next = mon === 12 ? { year: year + 1, mon: 1 } : { year, mon: mon + 1 };
  return { from: zonedMonthStart(year, mon, tz), to: zonedMonthStart(next.year, next.mon, tz) };
}

export function monthOf(atSeconds: number, tz = REPORT_TZ): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit' })
      .formatToParts(new Date(atSeconds * 1000))
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}`;
}

/** The current month and the 11 before it, newest first. */
export function recentMonths(count = 12, tz = REPORT_TZ): string[] {
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
