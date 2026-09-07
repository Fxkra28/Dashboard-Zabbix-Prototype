import { severity } from '../lib/severity';
import { SEVERITIES } from '../theme';

export function SeverityBadge({ level }: { level: string | number }) {
  const s = severity(level);
  return (
    <span className="badge" style={{ background: s.color }}>
      {s.name}
    </span>
  );
}

export function UpDown({ up }: { up: boolean | undefined }) {
  if (up === undefined)
    return (
      <span className="pill">
        <span className="dot" style={{ background: 'var(--muted)' }} /> Unknown
      </span>
    );
  return up ? (
    <span className="pill up">
      <span className="dot" style={{ background: 'var(--good)' }} /> Up
    </span>
  ) : (
    <span className="pill down">
      <span className="dot" style={{ background: 'var(--danger)' }} /> Down
    </span>
  );
}

export function AvailabilityPill({ kind, label }: { kind: 'up' | 'down' | 'unknown'; label: string }) {
  const cls = kind === 'up' ? 'up' : kind === 'down' ? 'down' : '';
  const dot = kind === 'up' ? 'var(--good)' : kind === 'down' ? 'var(--danger)' : 'var(--muted)';
  return (
    <span className={`pill ${cls}`}>
      <span className="dot" style={{ background: dot }} /> {label}
    </span>
  );
}

/** Zabbix-style severity count strip: one colored chip per non-zero severity. */
export function SeverityCounts({ bySeverity }: { bySeverity: Record<string, number> }) {
  const chips = SEVERITIES.slice()
    .reverse()
    .filter((s) => (bySeverity[s.level] ?? 0) > 0);
  if (!chips.length) return <span className="muted">—</span>;
  return (
    <span style={{ display: 'inline-flex', gap: 6 }}>
      {chips.map((s) => (
        <span
          key={s.level}
          className="sev-count"
          style={{ background: s.color }}
          title={s.name}
        >
          {bySeverity[s.level]}
        </span>
      ))}
    </span>
  );
}
