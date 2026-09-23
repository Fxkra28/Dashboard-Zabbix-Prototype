import { useMemo, useState } from 'react';
import { api } from '../api';
import { useAsync } from '../hooks/useAsync';
import { useCapabilities } from '../hooks/useAi';
import { useAuth, roleAllows } from '../hooks/useAuth';
import { useUrlState } from '../hooks/useUrlState';
import type { Problem } from '../types';
import { SEVERITIES } from '../theme';
import { SeverityBadge } from '../components/StatusBadge';
import { Async } from '../components/states';
import { ProblemExplainPanel } from '../components/ExplainPanel';
import AckDialog from '../components/AckDialog';
import { fmtTime, duration } from '../lib/severity';

/** Rows rendered at first, and added per "Show more": the list can run to thousands. */
const ROWS = 100;

const ACK_FILTERS = ['all', 'unack', 'ack'] as const;

export default function Problems() {
  // Every 30 s: the Dashboard's live stream is the fast path; this page is a working list.
  const q = useAsync<Problem[]>(() => api.problems(), [], 30_000);
  const [minSev, setMinSev] = useUrlState<number>('severity', 0, { options: [0, 1, 2, 3, 4, 5] });
  const [search, setSearch] = useUrlState<string>('q', '', { debounceMs: 400 });
  const [ackFilter, setAckFilter] = useUrlState<(typeof ACK_FILTERS)[number]>('ack', 'all', {
    options: ACK_FILTERS,
  });
  // How many rows to render, for the filters it was raised under; new filters start over.
  const filterKey = `${minSev}|${search}|${ackFilter}`;
  const [shown, setShown] = useState({ filterKey, rows: ROWS });
  const rows = shown.filterKey === filterKey ? shown.rows : ROWS;
  const caps = useCapabilities();
  const { role } = useAuth();
  const [explaining, setExplaining] = useState<Problem | null>(null);
  const [acking, setAcking] = useState<Problem | null>(null);

  // Both must hold: a write token on the BFF, and operator role or above.
  // The BFF enforces this too: the UI just doesn't offer what would 403.
  const canAck = caps.writeBack && roleAllows(role, 'operator');

  const filtered = useMemo(() => {
    const list = q.data ?? [];
    const needle = search.trim().toLowerCase();
    return list.filter((p) => {
      if (Number(p.severity) < minSev) return false;
      if (ackFilter === 'ack' && p.acknowledged !== '1') return false;
      if (ackFilter === 'unack' && p.acknowledged === '1') return false;
      if (needle && !`${p.name} ${p.host ?? ''}`.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [q.data, minSev, search, ackFilter]);

  const resolved = (p: Problem) => p.r_eventid && p.r_eventid !== '0';

  return (
    <>
      <div className="controls">
        <div className="field">
          <label htmlFor="problems-search">Search</label>
          <input
            id="problems-search"
            type="text"
            placeholder="problem or host…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="problems-severity">Min severity</label>
          <select id="problems-severity" value={minSev} onChange={(e) => setMinSev(Number(e.target.value))}>
            {SEVERITIES.map((s) => (
              <option key={s.level} value={s.level}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="problems-ack">Acknowledged</label>
          <select
            id="problems-ack"
            value={ackFilter}
            onChange={(e) => setAckFilter(e.target.value as (typeof ACK_FILTERS)[number])}
          >
            <option value="all">All</option>
            <option value="unack">Unacknowledged</option>
            <option value="ack">Acknowledged</option>
          </select>
        </div>
        <div className="field">
          <label>&nbsp;</label>
          <span className="pill">{filtered.length} matching</span>
        </div>
      </div>

      <div className="panel">
        <Async loading={q.loading} error={q.error} data={q.data} updatedAt={q.updatedAt}>
          {() =>
            filtered.length ? (
              <>
                <div className="table-wrap">
                  <table className="data">
                    <thead>
                      <tr>
                        <th>Time</th>
                        <th>Severity</th>
                        <th>Status</th>
                        <th>Host</th>
                        <th>Problem</th>
                        <th>Duration</th>
                        <th>Ack</th>
                        <th>Tags</th>
                        {(caps.ai || canAck) && <th />}
                      </tr>
                    </thead>
                    <tbody>
                      {filtered.slice(0, rows).map((p) => (
                        <tr key={p.eventid}>
                          <td className="muted" style={{ whiteSpace: 'nowrap' }}>
                            {fmtTime(p.clock)}
                          </td>
                          <td>
                            <SeverityBadge level={p.severity} />
                          </td>
                          <td>
                            {resolved(p) ? (
                              <span className="pill up">Resolved</span>
                            ) : (
                              <span className="pill down">Problem</span>
                            )}
                          </td>
                          <td className="muted">{p.host || '—'}</td>
                          <td>{p.name}</td>
                          <td className="muted" style={{ whiteSpace: 'nowrap' }}>
                            {duration(p.clock, p.r_clock)}
                          </td>
                          <td>
                            {p.acknowledged === '1' ? (
                              <span className="pill up">Yes</span>
                            ) : (
                              <span className="pill">No</span>
                            )}
                          </td>
                          <td>
                            <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 4 }}>
                              {(p.tags ?? []).slice(0, 4).map((t, i) => (
                                <span key={i} className="tag">
                                  {t.tag}
                                  {t.value ? `: ${t.value}` : ''}
                                </span>
                              ))}
                            </span>
                          </td>
                          {(caps.ai || canAck) && (
                            <td>
                              <span style={{ display: 'inline-flex', gap: 6 }}>
                                {caps.ai && (
                                  <button
                                    className="btn ghost sm"
                                    onClick={() => setExplaining(p)}
                                    title="Translate this alert and its tags into plain language"
                                  >
                                    Explain
                                  </button>
                                )}
                                {canAck && !resolved(p) && (
                                  <button
                                    className="btn ghost sm"
                                    onClick={() => setAcking(p)}
                                    title="Acknowledge or close this problem in Zabbix"
                                  >
                                    Ack
                                  </button>
                                )}
                              </span>
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {filtered.length > rows && (
                  <div className="show-more">
                    <span className="muted">
                      Showing {rows} of {filtered.length}
                    </span>
                    <button
                      type="button"
                      className="btn ghost sm"
                      onClick={() => setShown({ filterKey, rows: rows + ROWS })}
                    >
                      Show {Math.min(ROWS, filtered.length - rows)} more
                    </button>
                  </div>
                )}
              </>
            ) : (
              <div className="state">No problems match the filter. 🎉</div>
            )
          }
        </Async>
      </div>

      {explaining && (
        <ProblemExplainPanel problem={explaining} onClose={() => setExplaining(null)} />
      )}

      {acking && (
        <AckDialog
          problem={acking}
          onClose={() => setAcking(null)}
          onDone={q.reload}
        />
      )}
    </>
  );
}
