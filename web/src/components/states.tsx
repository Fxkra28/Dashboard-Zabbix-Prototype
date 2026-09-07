import type { ReactNode } from 'react';

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="state">
      <span className="spinner" />
      <div style={{ marginTop: 10 }}>{label}</div>
    </div>
  );
}

export function ErrorState({ message }: { message: string }) {
  return (
    <div className="state error">
      <div style={{ fontWeight: 600 }}>Couldn’t load data</div>
      <div className="mono" style={{ marginTop: 8 }}>
        {message}
      </div>
      <div className="muted" style={{ marginTop: 10, fontSize: 12 }}>
        Check that the BFF is running and ZBX_URL / ZBX_TOKEN are set.
      </div>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="state">{children}</div>;
}

/** Renders loading / error / empty around loaded data. */
export function Async<T>({
  loading,
  error,
  data,
  children,
  loadingLabel,
}: {
  loading: boolean;
  error: string | null;
  data: T | null;
  loadingLabel?: string;
  children: (data: T) => ReactNode;
}) {
  if (error) return <ErrorState message={error} />;
  if (loading && data == null) return <Loading label={loadingLabel} />;
  if (data == null) return <Empty>No data.</Empty>;
  return <>{children(data)}</>;
}
