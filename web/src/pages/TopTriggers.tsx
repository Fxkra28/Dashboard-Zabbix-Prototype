import { useState } from 'react';
import { api } from '../api';
import { useAsync } from '../hooks/useAsync';
import type { TopTriggersReport } from '../types';
import { SeverityBadge } from '../components/StatusBadge';
import { Async } from '../components/states';

const RANGES = [
  { days: 1, label: 'Last day' },
  { days: 7, label: 'Last 7 days' },
  { days: 30, label: 'Last 30 days' },
  { days: 90, label: 'Last 90 days' },
];

// Reports → Top 100 triggers: which triggers fired most in the window.
export default function TopTriggers() {
  const [days, setDays] = useState(7);
  const q = useAsync<TopTriggersReport>(() => api.topTriggers(days), [days]);

  return (
    <>
      <div className="controls">
        <div className="field">
          <label>Time range</label>
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {RANGES.map((r) => (
              <option key={r.days} value={r.days}>
                {r.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="panel">
        <h2>Top 100 triggers by number of problems</h2>
        <Async loading={q.loading} error={q.error} data={q.data} loadingLabel="Aggregating events…">
          {(data) =>
            data.triggers.length ? (
              <>
                {data.truncated && (
                  <div className="notice warn">
                    This window filled a full page of events, so these counts are a{' '}
                    <strong>floor</strong>. Choose a shorter period for exact figures.
                  </div>
                )}
                <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th style={{ width: 40 }}>#</th>
                      <th>Severity</th>
                      <th>Host</th>
                      <th>Trigger</th>
                      <th style={{ textAlign: 'right' }}>Problems</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.triggers.map((t, i) => (
                      <tr key={t.objectid}>
                        <td className="muted">{i + 1}</td>
                        <td>
                          <SeverityBadge level={t.severity} />
                        </td>
                        <td className="muted">{t.host || '—'}</td>
                        <td>{t.name}</td>
                        <td style={{ textAlign: 'right', fontWeight: 600 }}>{t.count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </div>
              </>
            ) : (
              <div className="state">No problem events in this window.</div>
            )
          }
        </Async>
      </div>
    </>
  );
}
