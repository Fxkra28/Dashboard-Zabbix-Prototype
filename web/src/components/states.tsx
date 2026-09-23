import type { ReactNode } from 'react';

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="state">
      <span className="spinner" />
      <div style={{ marginTop: 10 }}>{label}</div>
    </div>
  );
}

/**
 * What to check, when the message says. A Zabbix failure reaches the page as
 * the BFF's sentence ("Zabbix rejected the API token…", "Could not reach
 * Zabbix…"); a JSON-RPC error names a bad request, not the connection. A fetch
 * that never reached the BFF, or a proxy with nothing behind it, means the BFF
 * itself.
 */
function hintFor(message: string): string | null {
  const zabbix =
    (/zabbix/i.test(message) && !/"code":\s*-?\d/.test(message)) ||
    // Zabbix's web server itself failing: "problem.get: HTTP 502 Bad Gateway"
    /^[a-z]+\.[a-z]+: HTTP \d{3}/i.test(message);
  if (zabbix) return 'Check that ZBX_URL and ZABBIX_API_TOKEN are set on the BFF and that Zabbix is reachable.';
  // No JSON body at all: the request never reached a working BFF.
  if (/failed to fetch|networkerror|load failed|: HTTP 5\d\d$/i.test(message)) {
    return 'Check that the BFF is running.';
  }
  return null;
}

export function ErrorState({ message }: { message: string }) {
  const hint = hintFor(message);
  return (
    <div className="state error">
      <div style={{ fontWeight: 600 }}>Couldn’t load data</div>
      <div className="mono" style={{ marginTop: 8 }}>
        {message}
      </div>
      {hint && (
        <div className="muted" style={{ marginTop: 10, fontSize: 12 }}>
          {hint}
        </div>
      )}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="state">{children}</div>;
}

const clockTime = (ms: number) =>
  new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/** A refresh failed; the last good data stays on screen, and says how old it is. */
export function RefreshFailed({ error, updatedAt }: { error: string; updatedAt?: number | null }) {
  return (
    <div className="refresh-failed" role="status" title={error}>
      Refresh failed — showing data from {updatedAt ? clockTime(updatedAt) : 'earlier'}
    </div>
  );
}

/**
 * Loaded content. Dimmed (and not clickable) while it still belongs to the
 * previous selection and the new one loads; topped with a note when a refresh
 * failed. Always the same wrapper, so toggling either keeps the content mounted.
 */
export function Loaded({
  stale = false,
  error,
  updatedAt,
  children,
}: {
  stale?: boolean;
  error?: string | null;
  updatedAt?: number | null;
  children: ReactNode;
}) {
  return (
    <div className={stale ? 'stale' : undefined} aria-busy={stale || undefined}>
      {error && !stale && <RefreshFailed error={error} updatedAt={updatedAt} />}
      {children}
    </div>
  );
}

/**
 * Renders loading / error / empty around loaded data.
 *
 * An error replaces the content only when there is nothing of this selection's
 * to show: a failed poll keeps the last good data (with a note), while a failed
 * load for a new selection does not leave the old one standing in for it.
 */
export function Async<T>({
  loading,
  error,
  data,
  stale = false,
  updatedAt,
  children,
  loadingLabel,
}: {
  loading: boolean;
  error: string | null;
  data: T | null;
  /** `data` is the previous selection's (useAsync's `stale`): dim it. */
  stale?: boolean;
  /** When `data` arrived (useAsync's `updatedAt`), for the refresh-failed note. */
  updatedAt?: number | null;
  loadingLabel?: string;
  children: (data: T) => ReactNode;
}) {
  if (error && (data == null || stale)) return <ErrorState message={error} />;
  if (loading && data == null) return <Loading label={loadingLabel} />;
  if (data == null) return <Empty>No data.</Empty>;
  return (
    <Loaded stale={stale} error={error} updatedAt={updatedAt}>
      {children(data)}
    </Loaded>
  );
}
