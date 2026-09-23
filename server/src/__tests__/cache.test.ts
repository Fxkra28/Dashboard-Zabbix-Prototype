import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HOLD_TTL_MS, MAX_ENTRIES, cached, invalidate, setCacheLogger } from '../cache.js';

// The cache is module-level state shared by every test in this file.
beforeEach(() => {
  invalidate('');
});

afterEach(() => {
  vi.useRealTimers();
});

/** A fetch the test settles by hand. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let settled promises run their continuations (the cache stores in one). */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

/**
 * Only `Date` is faked: the cache reads the clock, and the real setImmediate
 * is still needed to give Node its chance to report an unhandled rejection.
 */
function useClock(): (ms: number) => void {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-17T08:00:00Z'));
  return (ms) => vi.setSystemTime(Date.now() + ms);
}

describe('cached', () => {
  it('calls the upstream once and serves the rest from memory', async () => {
    const fn = vi.fn().mockResolvedValue('value');
    expect(await cached('k', 10_000, fn)).toBe('value');
    expect(await cached('k', 10_000, fn)).toBe('value');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('re-fetches once the TTL has passed', async () => {
    const fn = vi.fn().mockResolvedValue('v');
    await cached('ttl', 1, fn);
    await new Promise((r) => setTimeout(r, 5));
    await cached('ttl', 1, fn);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent callers into one upstream call', async () => {
    // This is what stops ten NOC screens becoming ten times the Zabbix load.
    let release: (v: string) => void = () => {};
    const fn = vi.fn(() => new Promise<string>((res) => (release = res)));

    const all = Promise.all([
      cached('busy', 10_000, fn),
      cached('busy', 10_000, fn),
      cached('busy', 10_000, fn),
    ]);
    release('shared');

    expect(await all).toEqual(['shared', 'shared', 'shared']);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does not cache a rejection', async () => {
    // A failing upstream must be retried, not remembered for the whole TTL.
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('zabbix down'))
      .mockResolvedValueOnce('recovered');

    await expect(cached('flaky', 10_000, fn)).rejects.toThrow('zabbix down');
    expect(await cached('flaky', 10_000, fn)).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('keeps separate keys separate', async () => {
    await cached('a', 10_000, async () => 1);
    await cached('b', 10_000, async () => 2);
    expect(await cached('a', 10_000, async () => 99)).toBe(1);
    expect(await cached('b', 10_000, async () => 99)).toBe(2);
  });

  it('recovers from an upstream that throws before returning a promise', async () => {
    const boom = () => {
      throw new Error('sync failure');
    };
    await expect(cached('sync', 10_000, boom as () => Promise<string>)).rejects.toThrow('sync failure');
    // Not left registered as in flight: the next caller fetches again.
    expect(await cached('sync', 10_000, async () => 'ok')).toBe('ok');
  });
});

describe('invalidate', () => {
  it('drops only keys matching the prefix, and reports how many', async () => {
    await cached('problems:1', 10_000, async () => 'p1');
    await cached('problems:2', 10_000, async () => 'p2');
    await cached('hosts:1', 10_000, async () => 'h1');

    expect(invalidate('problems')).toBe(2);

    // Dropped keys re-fetch; the untouched one still serves the cached value.
    expect(await cached('problems:1', 10_000, async () => 'fresh')).toBe('fresh');
    expect(await cached('hosts:1', 10_000, async () => 'fresh')).toBe('h1');
  });

  it('returns 0 when nothing matches', () => {
    expect(invalidate('nothing-here')).toBe(0);
  });

  it('does not store a fetch that was in flight when the write happened', async () => {
    const before = deferred<string>();
    const reading = cached('problems', 10_000, () => before.promise);

    invalidate('problems');

    // A caller arriving after the write starts its own fetch instead of
    // joining the one that may have read the old state.
    const after = vi.fn().mockResolvedValue('after');
    expect(await cached('problems', 10_000, after)).toBe('after');
    expect(after).toHaveBeenCalledTimes(1);

    // The old read lands late: its caller still gets an answer…
    before.resolve('before');
    expect(await reading).toBe('before');
    // …but it does not overwrite the post-write value.
    expect(await cached('problems', 10_000, async () => 'refetched')).toBe('after');
  });

  it("does not let a cancelled fetch's cleanup unregister the newer one", async () => {
    const old = deferred<string>();
    const newer = deferred<string>();
    const fn = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(newer.promise);

    const a = cached('k', 10_000, fn);
    invalidate('k');
    const b = cached('k', 10_000, fn);

    old.resolve('old');
    expect(await a).toBe('old');

    // Still coalesces onto the newer fetch rather than starting a third.
    const c = cached('k', 10_000, fn);
    newer.resolve('new');
    expect(await b).toBe('new');
    expect(await c).toBe('new');
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe('stale serving', () => {
  it('answers at once with the stale value and refreshes exactly once per window', async () => {
    const advance = useClock();
    const refresh = deferred<string>();
    const fn = vi.fn().mockResolvedValueOnce('v1').mockReturnValueOnce(refresh.promise);
    const opts = { staleMs: 10_000 };

    expect(await cached('sli', 1_000, fn, opts)).toBe('v1');
    advance(1_500);

    // Every reader inside the window is answered while the refresh is still running.
    const readers = [cached('sli', 1_000, fn, opts), cached('sli', 1_000, fn, opts), cached('sli', 1_000, fn, opts)];
    expect(await Promise.all(readers)).toEqual(['v1', 'v1', 'v1']);
    expect(fn).toHaveBeenCalledTimes(2);

    refresh.resolve('v2');
    await flush();
    expect(await cached('sli', 1_000, fn, opts)).toBe('v2');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('keeps the stale value when the background refresh fails, with no unhandled rejection', async () => {
    const advance = useClock();
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const fn = vi
        .fn()
        .mockResolvedValueOnce('v1')
        .mockRejectedValueOnce(new Error('zabbix down'))
        .mockResolvedValueOnce('v2');
      const opts = { staleMs: 10_000 };

      await cached('avail', 1_000, fn, opts);
      advance(1_500);
      expect(await cached('avail', 1_000, fn, opts)).toBe('v1');
      await new Promise((r) => setImmediate(r));

      // Still answered from the old value, and not retried inside this window.
      advance(1_000);
      expect(await cached('avail', 1_000, fn, opts)).toBe('v1');
      expect(fn).toHaveBeenCalledTimes(2);

      // Once the window has passed, the next reader fetches in the foreground.
      advance(10_000);
      expect(await cached('avail', 1_000, fn, opts)).toBe('v2');
      expect(fn).toHaveBeenCalledTimes(3);

      await new Promise((r) => setImmediate(r));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('never serves a value past ttl + staleMs', async () => {
    const advance = useClock();
    await cached('old', 1_000, async () => 'v1', { staleMs: 5_000 });
    advance(6_001);
    expect(await cached('old', 1_000, async () => 'v2', { staleMs: 5_000 })).toBe('v2');
  });

  it('staleIfError answers a failed foreground fetch with the last value, however old, and logs it', async () => {
    const advance = useClock();
    const warn = vi.fn();
    setCacheLogger({ warn });
    try {
      const opts = { staleMs: 5_000, staleIfError: true };
      const down = () => Promise.reject(new Error('zabbix down'));
      await cached('avail:7', 1_000, async () => 'v1', opts);
      await cached('noise:7', 1_000, async () => 'n1');

      // An hour on, far past ttl + staleMs: fetched in the foreground, which fails.
      advance(3_600_000);
      expect(await cached('avail:7', 1_000, down, opts)).toBe('v1');
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ key: 'avail:7', ageMs: 3_600_000, reason: 'zabbix down' }),
        expect.any(String),
      );

      // Still the old value, and a recovered Zabbix replaces it.
      expect(await cached('avail:7', 1_000, down, opts)).toBe('v1');
      expect(await cached('avail:7', 1_000, async () => 'v2', opts)).toBe('v2');

      // Without the option the failure is the caller's.
      await expect(cached('noise:7', 1_000, down)).rejects.toThrow('zabbix down');
      // Nothing held: nothing to fall back on.
      await expect(cached('capacity:7', 1_000, down, opts)).rejects.toThrow('zabbix down');
    } finally {
      setCacheLogger(undefined);
    }
  });

  it('staleIfError never brings back a value that invalidate() dropped, nor answers inside a hold', async () => {
    const advance = useClock();
    const opts = { staleIfError: true };
    const down = () => Promise.reject(new Error('zabbix down'));

    await cached('sites', 1_000, async () => 'before the write', opts);
    invalidate('sites');
    advance(5_000);
    await expect(cached('sites', 1_000, down, opts)).rejects.toThrow('zabbix down');

    // Refilled after a write but still inside its hold: a failed refetch is an error.
    invalidate('stats', { holdMs: 15_000 });
    await cached('stats', 15_000, async () => 'after the write', opts);
    advance(HOLD_TTL_MS + 1);
    await expect(cached('stats', 15_000, down, opts)).rejects.toThrow('zabbix down');
  });
});

describe('LRU bound', () => {
  it(`holds at most ${MAX_ENTRIES} keys and evicts the least recently used`, async () => {
    for (let i = 0; i < MAX_ENTRIES; i++) await cached(`graph:${i}`, 60_000, async () => i);

    // Reading key 0 makes it recent, so key 1 is now the oldest.
    expect(await cached('graph:0', 60_000, async () => -1)).toBe(0);
    await cached('graph:new', 60_000, async () => MAX_ENTRIES);

    expect(await cached('graph:0', 60_000, async () => -1)).toBe(0);
    expect(await cached(`graph:${MAX_ENTRIES - 1}`, 60_000, async () => -1)).toBe(MAX_ENTRIES - 1);
    // Key 1 was evicted, so it refetches (which in turn evicts key 2).
    expect(await cached('graph:1', 60_000, async () => -1)).toBe(-1);
    expect(invalidate('graph:')).toBe(MAX_ENTRIES);
  });
});

describe('write holds', () => {
  it('keeps invalidated keys on a short TTL, without stale answers, until the hold ends', async () => {
    const advance = useClock();
    await cached('problems', 5_000, async () => 'before');
    await cached('hosts:overview', 15_000, async () => 'before');
    await cached('sla', 60_000, async () => 'untouched');

    invalidate('problems', { holdMs: 15_000 });
    invalidate('hosts:overview', { holdMs: 15_000 });

    const fn = vi.fn().mockResolvedValueOnce('t0').mockResolvedValueOnce('t1').mockResolvedValueOnce('t2');
    expect(await cached('problems', 5_000, fn)).toBe('t0');

    // Inside the hold the 5 s TTL is capped at HOLD_TTL_MS…
    advance(HOLD_TTL_MS - 1);
    expect(await cached('problems', 5_000, fn)).toBe('t0');
    advance(2);
    expect(await cached('problems', 5_000, fn)).toBe('t1');

    // …and staleMs is ignored: the caller waits for the refetch.
    const late = vi.fn().mockResolvedValueOnce('o0').mockResolvedValueOnce('o1');
    expect(await cached('hosts:overview', 15_000, late, { staleMs: 60_000 })).toBe('o0');
    advance(HOLD_TTL_MS + 1);
    expect(await cached('hosts:overview', 15_000, late, { staleMs: 60_000 })).toBe('o1');

    // Keys outside the prefix keep their own TTL.
    expect(await cached('sla', 60_000, async () => 'refetched')).toBe('untouched');

    // After the hold, the normal TTL applies again.
    advance(15_000);
    expect(await cached('problems', 5_000, fn)).toBe('t2');
    advance(4_000);
    expect(await cached('problems', 5_000, fn)).toBe('t2');
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
