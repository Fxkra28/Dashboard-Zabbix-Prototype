import { useMemo, useState } from 'react';
import { api } from '../api';
import { useAsync } from '../hooks/useAsync';
import { useCapabilities } from '../hooks/useAi';
import { useAuth, roleAllows } from '../hooks/useAuth';
import type { Problem } from '../types';
import { SEVERITIES } from '../theme';
import { SeverityBadge } from '../components/StatusBadge';
import { Async } from '../components/states';
import { ProblemExplainPanel } from '../components/ExplainPanel';
import AckDialog from '../components/AckDialog';
import { fmtTime, duration } from '../lib/severity';

export default function Problems() {
  const q = useAsync<Problem[]>(() => api.problems(), [], 5_000);
  const [minSev, setMinSev] = useState(0);
  const [search, setSearch] = useState('');
  const [ackFilter, setAckFilter] = useState('all');
  const caps = useCapabilities();
  const { role } = useAuth();
  const [explaining, setExplaining] = useState<Problem | null>(null);
  const [acking, setAcking] = useState<Problem | null>(null);

  // Both must hold: a write token on the BFF, and operator role or above.
  // The BFF enforces this too — the UI just doesn't offer what would 403.
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
          <label>Search</label>
          <input
            type="text"
            placeholder="problem or host…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="field">
          <label>Min severity</label>
          <select value={minSev} onChange={(e) => setMinSev(Number(e.target.value))}>
            {SEVERITIES.map((s) => (
              <option key={s.level} value={s.level}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Acknowledged</label>
          <select value={ackFilter} onChange={(e) => setAckFilter(e.target.value)}>
            <option value="all">All</option>
            <option value="unack">Unacknowledged</option>
            <option value="ack">Acknowledged</option>
          </select>
        </div>
        <div className="field">
          <label>&nbsp;</label>
          <span className="pill">{filtered.length} shown</span>
        </div>
      </div>

      <div className="panel">
        <Async loading={q.loading} error={q.error} data={q.data}>
          {() =>
            filtered.length ? (
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
                    {filtered.map((p) => (
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
