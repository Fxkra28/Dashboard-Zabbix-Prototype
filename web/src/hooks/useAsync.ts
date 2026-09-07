import { useCallback, useEffect, useState } from 'react';

/**
 * Fetch helper with loading/error state and optional polling.
 * `deps` re-runs the fetch; `intervalMs` re-polls on a timer.
 */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[] = [], intervalMs?: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(() => {
    fn()
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e) => setError(String(e?.message ?? e)))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    setLoading(true);
    run();
    if (!intervalMs) return;
    const iv = setInterval(run, intervalMs);
    return () => clearInterval(iv);
  }, [run, intervalMs]);

  return { data, error, loading, reload: run };
}
