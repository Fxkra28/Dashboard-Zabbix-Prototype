import { BadRequestError } from '../validate.js';

/**
 * Calendar months in a named time zone, as Unix seconds.
 *
 * HCML's reports cut months at midnight Asia/Jakarta, not UTC: an event at
 * 23:30 WIB on the 31st belongs to that month, while its UTC clock already
 * reads the 1st. Done with Intl rather than a fixed +7 offset so the zone stays
 * configurable and a zone with daylight saving time is still correct.
 */

/** UTC offset of `tz` at the given instant, in seconds (east positive). */
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

/** Midnight on day 1 of `month` (1–12) of `year` in `tz`, as Unix seconds. */
export function zonedMonthStart(year: number, month: number, tz: string): number {
  const guess = Date.UTC(year, month - 1, 1) / 1000;
  const first = guess - offsetSeconds(guess, tz);
  // Re-check at the corrected instant: across a DST change the offset differs.
  const second = guess - offsetSeconds(first, tz);
  return second;
}

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** `YYYY-MM`, validated. */
export function parseMonth(raw: unknown): string {
  if (typeof raw !== 'string' || !MONTH_RE.test(raw)) {
    throw new BadRequestError('month must be YYYY-MM, e.g. 2026-08.');
  }
  return raw;
}

export function monthBounds(month: string, tz: string): { from: number; to: number } {
  const [, y, m] = MONTH_RE.exec(parseMonth(month))!;
  const year = Number(y);
  const mon = Number(m);
  const next = mon === 12 ? { year: year + 1, mon: 1 } : { year, mon: mon + 1 };
  return { from: zonedMonthStart(year, mon, tz), to: zonedMonthStart(next.year, next.mon, tz) };
}

/** The month containing `atSeconds` (default now) in `tz`, as `YYYY-MM`. */
export function monthOf(atSeconds: number, tz: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit' })
      .formatToParts(new Date(atSeconds * 1000))
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}`;
}

export function currentMonth(tz: string): string {
  return monthOf(Math.floor(Date.now() / 1000), tz);
}

/** The month before `month`. */
export function previousMonth(month: string): string {
  const [, y, m] = MONTH_RE.exec(parseMonth(month))!;
  const year = Number(y);
  const mon = Number(m);
  return mon === 1 ? `${year - 1}-12` : `${year}-${String(mon - 1).padStart(2, '0')}`;
}

export const hourFloor = (t: number): number => Math.floor(t / 3600) * 3600;
