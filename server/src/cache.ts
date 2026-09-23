/**
 * In-memory TTL cache. Every Zabbix call hits its server + DB, so we cache
 * aggressively with short TTLs. Swap for Redis when scaling (setup.md §9).
 *
 * Coalesces concurrent misses: while one fetch is in flight for a key, other
 * callers await the same promise instead of stampeding Zabbix.
 *
 * Bounded to MAX_ENTRIES keys, least recently used evicted first. Keys that
 * carry parameters (`graph:<items>:<from>:<to>`, `explain:problem:<id>`) used
 * to accumulate for as long as the process ran.
 *
 * Two opt-in ways to answer with an expired value, for slow reports whose
 * figures move slowly (the derived SLA, availability, capacity). Never for
 * anything that shows problem or acknowledgement state: an operator who has
 * just acknowledged must not be shown the list from before.
 *
 *   staleMs       for this long after the TTL, answer at once with the old
 *                 value and refresh it in the background: one refresh per
 *                 stale window. A refresh that fails leaves the old value in
 *                 place; the first request after the window fetches in the
 *                 foreground again.
 *   staleIfError  when that foreground fetch fails, answer with the last
 *                 value this cache still holds, however old, and log it. A
 *                 report from an hour ago beats an error page while Zabbix is
 *                 struggling. Values dropped by invalidate() are gone for
 *                 good, so a write is never undone this way.
 */
type Entry = {
  t: number;
  v: unknown;
  /** Set once this value's background refresh has started: one per stale window. */
  refreshing?: boolean;
};

/**
 * One fetch. invalidate() sets `cancelled`: whoever is already waiting still
 * gets the result, but it is not stored: it was read before the write that
 * made it out of date.
 */
type Flight = { promise: Promise<unknown>; cancelled: boolean };

export interface CacheOptions {
  /** Serve the expired value for this long past the TTL while one background refresh runs. */
  staleMs?: number;
  /** On a failed fetch, answer with the last value held, of any age, rather than the error. */
  staleIfError?: boolean;
}

/** The part of Fastify's logger the cache uses. */
export interface CacheLogger {
  warn(obj: object, msg: string): void;
}

export interface InvalidateOptions {
  /**
   * Keep the matching keys on a short leash for this long afterwards: TTL at
   * most HOLD_TTL_MS and no stale answers. Zabbix applies a close a few
   * seconds after `event.acknowledge` returns, so a single refetch straight
   * after the write can still read the old state.
   */
  holdMs?: number;
}

export const MAX_ENTRIES = 500;
export const HOLD_TTL_MS = 2_000;

const store = new Map<string, Entry>();
const inflight = new Map<string, Flight>();
/** Invalidated prefix → when its hold ends (epoch ms). */
const holds = new Map<string, number>();
let log: CacheLogger | undefined;

/** Where stale answers and failed background refreshes are reported (index.ts passes app.log). */
export function setCacheLogger(logger: CacheLogger | undefined): void {
  log = logger;
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function cached<T>(
  key: string,
  ttlMs: number,
  fn: () => Promise<T>,
  opts: CacheOptions = {},
): Promise<T> {
  const now = Date.now();
  const held = isHeld(key, now);
  const ttl = held ? Math.min(ttlMs, HOLD_TTL_MS) : ttlMs;
  const staleMs = held ? 0 : Math.max(0, opts.staleMs ?? 0);

  const hit = store.get(key);
  if (hit) {
    const age = now - hit.t;
    if (age < ttl) {
      remember(key, hit);
      return hit.v as T;
    }
    if (age < ttl + staleMs) {
      remember(key, hit);
      if (!hit.refreshing && !inflight.has(key)) {
        hit.refreshing = true;
        // Nobody awaits this promise. Left unhandled, a rejection would take
        // the whole process down; caught, the stale value simply stays.
        begin(key, fn).promise.catch((err: unknown) => {
          log?.warn({ key, reason: reason(err) }, 'cache: background refresh failed; keeping the stale value');
        });
      }
      return hit.v as T;
    }
  }

  const flight = inflight.get(key) ?? begin(key, fn);
  try {
    return (await flight.promise) as T;
  } catch (err) {
    // Never inside a write hold: that is exactly when an old value is wrong.
    const last = opts.staleIfError && !held ? store.get(key) : undefined;
    if (!last) throw err;
    remember(key, last);
    log?.warn(
      { key, ageMs: Date.now() - last.t, reason: reason(err) },
      'cache: fetch failed; answering with the last cached value',
    );
    return last.v as T;
  }
}

/**
 * Start a fetch and register it as the key's in-flight one. Registered before
 * `fn` runs, so that a synchronous throw inside `fn` still gets cleaned up.
 */
function begin(key: string, fn: () => Promise<unknown>): Flight {
  const flight: Flight = { promise: Promise.resolve(), cancelled: false };
  inflight.set(key, flight);
  flight.promise = (async () => {
    try {
      const v = await fn();
      if (!flight.cancelled) remember(key, { t: Date.now(), v });
      return v;
    } finally {
      // Only our own record: after an invalidate a newer fetch may own the key.
      if (inflight.get(key) === flight) inflight.delete(key);
    }
  })();
  return flight;
}

/** Store (or re-store) as most recently used; evict the least recently used past the cap. */
function remember(key: string, entry: Entry): void {
  store.delete(key);
  store.set(key, entry);
  while (store.size > MAX_ENTRIES) {
    const oldest = store.keys().next();
    if (oldest.done) break;
    store.delete(oldest.value);
  }
}

function isHeld(key: string, now: number): boolean {
  let held = false;
  for (const [prefix, until] of holds) {
    if (until <= now) holds.delete(prefix);
    else if (key.startsWith(prefix)) held = true;
  }
  return held;
}

/**
 * Drop cached entries so the next read refetches. Used after a write-back
 * (§20): without this an acknowledgement wouldn't show for up to the TTL, and
 * the UI would look like it silently failed.
 *
 * Fetches already in flight for a matching key are cancelled too: their
 * callers still get an answer, but it is not stored. Before, a read that
 * started just ahead of an acknowledge could land afterwards and put the
 * pre-acknowledge list back in the cache for a full TTL.
 *
 * `prefix` matches by string prefix, so `invalidate('avail:')` clears every
 * parameterised availability report at once. `invalidate('')` clears
 * everything, holds included, how the tests start from a clean cache.
 *
 * Returns how many stored entries were dropped.
 */
export function invalidate(prefix: string, opts: InvalidateOptions = {}): number {
  let dropped = 0;
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) {
      store.delete(key);
      dropped++;
    }
  }
  for (const [key, flight] of inflight) {
    if (key.startsWith(prefix)) {
      flight.cancelled = true;
      inflight.delete(key);
    }
  }
  if (prefix === '') holds.clear();
  if (opts.holdMs && opts.holdMs > 0) {
    holds.set(prefix, Math.max(holds.get(prefix) ?? 0, Date.now() + opts.holdMs));
  }
  return dropped;
}
