import { useState } from 'react';
import { api } from '../api';
import { useAsync } from '../hooks/useAsync';
import type { AgingReport, AvailabilityReport } from '../types';
import { SEVERITIES } from '../theme';
import { SeverityBadge } from '../components/StatusBadge';
import { Async, Empty } from '../components/states';
import KpiCard from '../components/KpiCard';

/**
 * Availability & response report (plan_1.2 Phase 6, HCML Goal 6) —
 * *"hard to see SLA, capacity trends, and recurring issues."*
 *
 * Two questions on one page: how much of the window was each host in trouble,
 * and how long is trouble sitting unacknowledged.
 */

function dur(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${(s / 3600).toFixed(1)}h`;
  return `${(s / 86400).toFixed(1)}d`;
}

/** Zabbix-style: 99.9%+ is fine, 99%+ is watch, below that is a problem. */
const availColor = (pct: number) =>
  pct >= 99.9 ? 'var(--good)' : pct >= 99 ? '#e8a33d' : 'var(--danger)';

function Aging() {
  const q = useAsync<AgingReport>(() => api.aging(), [], 30_000);

  return (
    <div className="panel">
      <h2>Unacknowledged, by age</h2>
      <Async loading={q.loading} error={q.error} data={q.data}>
        {(a) => (
          <>
            <div className="muted" style={{ fontSize: 12, marginBottom: 12 }}>
              {a.unacknowledged} of {a.total} active problems have not been acknowledged.
            </div>

            <div className="aging-bars">
              {a.buckets.map((b, i) => {
                const max = Math.max(1, ...a.buckets.map((x) => x.count));
                return (
                  <div key={b.label} className="aging-row">
                    <span className="aging-label">{b.label}</span>
                    <span className="aging-track">
                      <span
                        style={{
                          width: `${(b.count / max) * 100}%`,
                          // Older = worse: the last bucket is the one that hurts.
                          background: i === a.buckets.length - 1 ? 'var(--danger)' : 'var(--primary-light)',
                        }}
                      />
                    </span>
                    <span className="aging-count">{b.count}</span>
                  </div>
                );
              })}
            </div>

            {a.oldest.length > 0 && (
              <>
                <h2 style={{ marginTop: 20 }}>Waiting longest</h2>
                <div className="table-wrap">
                  <table className="data">
                    <thead>
                      <tr>
                        <th>Age</th>
                        <th>Severity</th>
                        <th>Host</th>
                        <th>Problem</th>
                      </tr>
                    </thead>
                    <tbody>
                      {a.oldest.slice(0, 10).map((p) => (
                        <tr key={p.eventid}>
                          <td style={{ whiteSpace: 'nowrap', fontWeight: 600 }}>
                            {dur(p.ageSeconds)}
                          </td>
                          <td>
                            <SeverityBadge level={p.severity} />
                          </td>
                          <td className="muted">{p.host || '—'}</td>
                          <td>{p.name}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </>
        )}
      </Async>
    </div>
  );
}

export default function Availability() {
  const [days, setDays] = useState(7);
  const [severity, setSeverity] = useState(3);
  const q = useAsync<AvailabilityReport>(() => api.availability(days, severity), [days, severity]);

  return (
    <>
      <div className="controls">
        <div className="field">
          <label>Period</label>
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
            <option value={1}>Last 24 hours</option>
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
          </select>
        </div>
        <div className="field">
          <label>Counts problems of at least</label>
          <select value={severity} onChange={(e) => setSeverity(Number(e.target.value))}>
            {SEVERITIES.map((s) => (
              <option key={s.level} value={s.level}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <Async loading={q.loading} error={q.error} data={q.data} loadingLabel="Replaying event history…">
        {(data) => {
          const worst = data.hosts[0];
          const avg = data.hosts.length
            ? data.hosts.reduce((s, h) => s + h.availability, 0) / data.hosts.length
            : 100;

          return (
            <>
              <div className="grid kpis">
                <KpiCard
                  label="Hosts with downtime"
                  value={data.hosts.length}
                  sub={`over ${dur(data.windowSeconds)}`}
                />
                <KpiCard
                  label="Mean availability"
                  value={`${avg.toFixed(3)}%`}
                  sub="of affected hosts only"
                  accent={availColor(avg)}
                />
                <KpiCard
                  label="Worst host"
                  value={worst ? `${worst.availability.toFixed(2)}%` : '—'}
                  sub={worst?.host ?? 'nothing recorded'}
                  accent={worst ? availColor(worst.availability) : undefined}
                />
              </div>

              {data.truncated && (
                <div className="notice warn">
                  Zabbix returned a full page of events for this window, so these figures are a{' '}
                  <strong>floor</strong> — real downtime may be higher. Narrow the period for exact
                  numbers.
                </div>
              )}

              <div className="grid two-col">
                <div className="panel">
                  <h2>Availability by host</h2>
                  <div className="muted" style={{ fontSize: 12, marginBottom: 12 }}>
                    Share of the period with no open problem at or above the chosen severity.
                    Overlapping problems are merged, so simultaneous alerts aren’t double-counted.
                  </div>
                  {data.hosts.length ? (
                    <div className="table-wrap">
                      <table className="data">
                        <thead>
                          <tr>
                            <th>Host</th>
                            <th>Availability</th>
                            <th>Downtime</th>
                            <th>Incidents</th>
                            <th>Longest</th>
                          </tr>
                        </thead>
                        <tbody>
                          {data.hosts.map((h) => (
                            <tr key={h.hostid}>
                              <td style={{ fontWeight: 500 }}>{h.host}</td>
                              <td>
                                <strong style={{ color: availColor(h.availability) }}>
                                  {h.availability.toFixed(3)}%
                                </strong>
                              </td>
                              <td className="muted">{dur(h.downtime)}</td>
                              <td className="muted">{h.incidents}</td>
                              <td className="muted">{dur(h.longest)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <Empty>No problems at this severity in the period. 🎉</Empty>
                  )}
                </div>

                <Aging />
              </div>
            </>
          );
        }}
      </Async>
    </>
  );
}
