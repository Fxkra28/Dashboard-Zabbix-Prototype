import { useMemo, useState } from 'react';
import { api } from '../api';
import { useAsync } from '../hooks/useAsync';
import type { DimensionKey, ScorecardResponse } from '../types';
import { Async, Empty } from '../components/states';

/**
 * Inventory & ownership scorecard (plan_1.2 Phase 4, HCML Goal 1).
 *
 * HCML's gap: *"host naming, site mapping, owner, criticality and dependency
 * are not standardised → alarms are hard to route to the right PIC."*
 *
 * The portal is read-only and cannot enforce a standard. What it can do is
 * measure one, so the gap stops being invisible and starts being a number the
 * team can move.
 */

const LABELS: Record<DimensionKey, string> = {
  naming: 'Naming',
  site: 'Site',
  owner: 'Owner',
  criticality: 'Criticality',
};

/** Red below a third, amber below three quarters, green above. */
function barColor(pct: number): string {
  if (pct >= 75) return 'var(--good)';
  if (pct >= 33) return 'var(--warn)';
  return 'var(--danger)';
}

function Bar({ pct }: { pct: number }) {
  return (
    <div className="score-bar">
      <span style={{ width: `${pct}%`, background: barColor(pct) }} />
    </div>
  );
}

/** Build a CSV of the gap list so the work can be handed to whoever owns it. */
function gapsCsv(data: ScorecardResponse): string {
  const rows = [
    ['host', 'site', 'host groups', 'missing'],
    ...data.gaps.map((g) => [g.name, g.site, g.groups.join(' | '), g.missing.join(' | ')]),
  ];
  return rows
    // A cell starting with = + - or @ is run as a formula when the file is opened
    // in Excel or Sheets, quotes or not. Prefixing ' makes it plain text; host
    // names and group labels come from Zabbix, which anyone with config access can set.
    .map((r) => r.map((c) => `"${String(c).replace(/^([=+\-@])/, "'$1").replace(/"/g, '""')}"`).join(','))
    .join('\n');
}

export default function Inventory() {
  const q = useAsync<ScorecardResponse>(() => api.inventory(), [], 120_000);
  const [filter, setFilter] = useState<DimensionKey | 'all'>('all');

  const download = (data: ScorecardResponse) => {
    const blob = new Blob([gapsCsv(data)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `hcml-inventory-gaps-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const gaps = useMemo(() => {
    const list = q.data?.gaps ?? [];
    return filter === 'all' ? list : list.filter((g) => g.missing.includes(filter));
  }, [q.data, filter]);

  return (
    <Async
      loading={q.loading}
      error={q.error}
      data={q.data}
      updatedAt={q.updatedAt}
      loadingLabel="Scoring the estate…"
    >
      {(data) => (
        <>
          <div className="score-hero">
            <div className="score-hero-num" style={{ color: barColor(data.overall.pct) }}>
              {data.overall.pct}%
            </div>
            <div>
              <strong>
                {data.overall.complete} of {data.overall.hosts} hosts
              </strong>{' '}
              carry every attribute needed to route an alarm to the right person.
              <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                The portal is read-only, so it can’t enforce a standard — it measures one. As hosts
                get tagged in Zabbix, this number goes up.
              </div>
            </div>
          </div>

          <div className="grid two-col">
            <div className="panel">
              <h2>By attribute</h2>
              {data.dimensions.map((d) => (
                <div key={d.key} className="score-dim">
                  <div className="score-dim-head">
                    <span>{d.label}</span>
                    {d.scored ? (
                      <span className="muted">
                        {d.present}/{d.total} · <strong>{d.pct}%</strong>
                      </span>
                    ) : (
                      <span className="pill">Not scored</span>
                    )}
                  </div>
                  {d.scored && <Bar pct={d.pct} />}
                  <div className="muted score-hint">{d.hint}</div>
                </div>
              ))}
            </div>

            <div className="panel">
              <h2>By host group</h2>
              {data.groups.length ? (
                <div className="table-wrap">
                  <table className="data">
                    <thead>
                      <tr>
                        <th>Group</th>
                        <th>Complete</th>
                        <th style={{ width: 120 }}>Score</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.groups.map((g) => (
                        <tr key={g.name}>
                          <td>{g.name}</td>
                          <td className="muted">
                            {g.complete}/{g.hosts}
                          </td>
                          <td>
                            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              <Bar pct={g.pct} />
                              <span className="muted" style={{ fontSize: 12 }}>
                                {g.pct}%
                              </span>
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <Empty>No host groups.</Empty>
              )}
            </div>
          </div>

          <div className="panel" style={{ marginTop: 18 }}>
            <div className="panel-head">
              <h2>Gap list — {gaps.length} hosts</h2>
              <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
                <select
                  value={filter}
                  onChange={(e) => setFilter(e.target.value as DimensionKey | 'all')}
                  style={{ minWidth: 150 }}
                >
                  <option value="all">All gaps</option>
                  {data.dimensions
                    .filter((d) => d.scored)
                    .map((d) => (
                      <option key={d.key} value={d.key}>
                        Missing {d.label.toLowerCase()}
                      </option>
                    ))}
                </select>
                <button
                  className="btn ghost sm"
                  onClick={() => download(data)}
                  disabled={!data.gaps.length}
                >
                  Download CSV
                </button>
              </span>
            </div>

            {gaps.length ? (
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>Host</th>
                      <th>Site</th>
                      <th>Host groups</th>
                      <th>Missing</th>
                    </tr>
                  </thead>
                  <tbody>
                    {gaps.map((g) => (
                      <tr key={g.hostid}>
                        <td style={{ fontWeight: 500 }}>{g.name}</td>
                        <td className="muted">{g.site}</td>
                        <td className="muted">{g.groups.join(', ') || '—'}</td>
                        <td>
                          <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
                            {g.missing.map((m) => (
                              <span key={m} className="tag miss">
                                {LABELS[m]}
                              </span>
                            ))}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty>Nothing missing.</Empty>
            )}
          </div>
        </>
      )}
    </Async>
  );
}
