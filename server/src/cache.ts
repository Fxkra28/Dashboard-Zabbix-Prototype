/**
 * Trivial in-memory TTL cache. Every Zabbix call hits its server + DB, so we
 * cache aggressively with short TTLs. Swap for Redis when scaling (instruct §2).
 *
 * Coalesces concurrent misses: while one fetch is in flight for a key, other
 * callers await the same promise instead of stampeding Zabbix.
 */
type Entry = { t: number; v: unknown };

const store = new Map<string, Entry>();
const inflight = new Map<string, Promise<unknown>>();

export async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = store.get(key);
  if (hit && Date.now() - hit.t < ttlMs) return hit.v as T;

  const pending = inflight.get(key);
  if (pending) return pending as Promise<T>;

  const p = (async () => {
    try {
      const v = await fn();
      store.set(key, { t: Date.now(), v });
      return v;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, p);
  return p as Promise<T>;
}

/**
 * Drop cached entries so the next read refetches. Used after a write-back
 * (§20): without this an acknowledgement wouldn't show for up to the TTL, and
 * the UI would look like it silently failed.
 *
 * `prefix` matches by string prefix, so `invalidate('avail:')` clears every
 * parameterised availability report at once.
 */
export function invalidate(prefix: string): number {
  let dropped = 0;
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) {
      store.delete(key);
      dropped++;
    }
  }
  return dropped;
}
