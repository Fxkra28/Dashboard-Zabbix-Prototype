/**
 * How old the numbers on a page are, when the BFF says so.
 * Two separate things:
 *
 *   - An answer that is an old copy kept because Zabbix failed arrives with
 *     `X-Data-Stale: true` and `X-Data-Age-Seconds` (server/src/staleness.ts).
 *     The body is unchanged, so what the page learns is remembered against the
 *     parsed body object itself: whoever renders that object can ask.
 *   - `GET /api/freshness` says when Zabbix last collected a value.
 */

/** Parsed body -> when the copy it came from was made (ms since epoch), or null when that is not known. */
const copies = new WeakMap<object, number | null>();

/** Called by the API layer for every JSON reply. Does nothing unless the reply says it is an old copy. */
export function noteStaleCopy(body: unknown, headers: Headers, receivedAt = Date.now()): void {
  if (typeof body !== 'object' || body === null || headers.get('X-Data-Stale') !== 'true') return;
  const raw = headers.get('X-Data-Age-Seconds');
  const age = raw === null || raw.trim() === '' ? NaN : Number(raw);
  copies.set(body, Number.isFinite(age) && age >= 0 ? receivedAt - age * 1000 : null);
}

/**
 * Whether `body` is an old copy: `{ asOf }` with the time the copy was made
 * (ms since epoch, null when the BFF did not say), or null for a live answer.
 */
export function staleCopyOf(body: unknown): { asOf: number | null } | null {
  if (typeof body !== 'object' || body === null || !copies.has(body)) return null;
  return { asOf: copies.get(body) ?? null };
}

/** A span of time in a few words: "12 min", "3 h 5 min", "20 days". */
export function ageWords(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return 'under a minute';
  const minutes = Math.floor(s / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
  return `${Math.floor(hours / 24)} days`;
}

/** A moment as the clock time on its own for today, with the date in front of it for another day. */
export function momentWords(ms: number, now = Date.now()): string {
  const at = new Date(ms);
  const time = at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  if (at.toDateString() === new Date(now).toDateString()) return time;
  return `${at.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${time}`;
}

/** When an old copy was made, as the notice words it: "from 08:48 (1 h 12 min ago)", or '' when that is not known. */
export function staleWhen(asOf: number | null, now = Date.now()): string {
  return asOf === null ? '' : `from ${momentWords(asOf, now)} (${ageWords((now - asOf) / 1000)} ago)`;
}
