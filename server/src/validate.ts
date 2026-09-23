/**
 * Query-string parsing for route handlers.
 *
 * Everything in `req.query` arrives as a string or not at all, and both ways
 * that went wrong here were silent:
 *
 *   - a missing id reached Zabbix as `[undefined]` and came back as an opaque
 *     500 ("Database error occurred") instead of telling the caller what was
 *     missing;
 *   - a non-numeric window (`?hours=abc`) became NaN, which Zabbix reads as
 *     "no time limit": one request returned an item's entire history
 *     (20,218 points, 1.4 MB). `Math.min(Math.max(NaN, 1), 365)` is still NaN,
 *     so the existing clamps did not catch it.
 */

/** A malformed request. Mapped to 400 `{ error: 'bad_request', message }` in errors.ts. */
export class BadRequestError extends Error {
  readonly code = 'bad_request';
}

/** A Zabbix object id: required, digits only. */
export function requireId(value: unknown, name: string): string {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new BadRequestError(`${name} is required and must be a numeric Zabbix id.`);
  }
  return value;
}

/** An optional Zabbix object id: absent is fine, present must be digits. */
export function optionalId(value: unknown, name: string): string | undefined {
  return value === undefined || value === '' ? undefined : requireId(value, name);
}

/**
 * An integer query parameter. Absent or non-numeric falls back to `fallback`;
 * out of range is clamped, matching how the report endpoints already treated
 * `days=9999`. NaN never escapes.
 */
export function intParam(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'string' && value.trim() !== '' ? Math.trunc(Number(value)) : NaN;
  const n = Number.isFinite(parsed) ? parsed : fallback;
  return Math.min(Math.max(n, min), max);
}
