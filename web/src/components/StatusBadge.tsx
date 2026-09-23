import { hostStatus, severity, type HostStatusKind } from '../lib/severity';
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

const PILL_CLASS: Record<HostStatusKind, string> = {
  up: 'up',
  down: 'down',
  degraded: 'degraded',
  nodata: 'nodata',
  disabled: '',
  unknown: '',
};

const DOT_COLOR: Record<HostStatusKind, string> = {
  up: 'var(--good)',
  down: 'var(--danger)',
  degraded: '#e8a33d',
  nodata: 'var(--muted)',
  disabled: 'var(--muted)',
  unknown: 'var(--muted)',
};

export function AvailabilityPill({ kind, label, title }: { kind: HostStatusKind; label: string; title?: string }) {
  return (
    <span className={`pill ${PILL_CLASS[kind]}`} title={title}>
      <span className="dot" style={{ background: DOT_COLOR[kind] }} /> {label}
    </span>
  );
}

/** A host's state pill: the BFF's ping-first `state` (reason as the tooltip), else interface availability. */
export function HostStatePill({ host }: { host: Parameters<typeof hostStatus>[0] }) {
  const s = hostStatus(host);
  return <AvailabilityPill kind={s.kind} label={s.label} title={s.title} />;
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
