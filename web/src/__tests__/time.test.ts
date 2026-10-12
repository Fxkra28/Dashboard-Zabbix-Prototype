import { afterEach, describe, expect, it, vi } from 'vitest';
import { isMonth, monthBounds, monthLabel, monthOf, recentMonths, zonedMonthStart } from '../lib/time';

const utc = (iso: string) => Date.parse(iso) / 1000;

afterEach(() => vi.useRealTimers());

describe('lib/time: reporting months in Asia/Jakarta', () => {
  it('bounds a month at local midnight, seven hours before UTC', () => {
    expect(monthBounds('2026-08')).toEqual({ from: utc('2026-07-31T17:00:00Z'), to: utc('2026-08-31T17:00:00Z') });
  });

  it('rolls December over into the next year', () => {
    expect(monthBounds('2026-12').to).toBe(utc('2026-12-31T17:00:00Z'));
  });

  it('follows the zone, not a fixed offset, across a clock change', () => {
    expect(zonedMonthStart(2026, 3, 'Europe/London')).toBe(utc('2026-03-01T00:00:00Z'));
    expect(zonedMonthStart(2026, 4, 'Europe/London')).toBe(utc('2026-03-31T23:00:00Z'));
  });

  it('puts an instant in the month Jakarta sees', () => {
    expect(monthOf(utc('2026-07-31T16:59:59Z'))).toBe('2026-07');
    expect(monthOf(utc('2026-07-31T17:00:00Z'))).toBe('2026-08');
  });

  it('accepts only a YYYY-MM month', () => {
    expect(isMonth('2026-08')).toBe(true);
    for (const bad of ['2026-13', '2026-00', '2026-8', '26-08', '', null, undefined]) expect(isMonth(bad), String(bad)).toBe(false);
    expect(() => monthBounds('2026-13')).toThrow('Bad month');
  });

  it('lists the current month and the ones before it, across a year end', () => {
    vi.useFakeTimers({ now: Date.parse('2026-01-10T00:00:00Z') });
    expect(recentMonths(3)).toEqual(['2026-01', '2025-12', '2025-11']);
  });

  it('labels a month the way the pickers show it', () => {
    expect(monthLabel('2026-08')).toBe('Aug 2026');
  });
});
