import { useMemo, useState } from 'react';
import { api } from '../api';
import { useAsync } from '../hooks/useAsync';
import type { Link, LinkState, LinksResponse } from '../types';
import { Async, Empty } from '../components/states';
import KpiCard from '../components/KpiCard';
import { fmtTime } from '../lib/severity';

/**
 * Link & WAN health (plan_1.2 Phase 5, HCML Goal 3).
 *
 * HCML runs 12 main + 10 redundant SD-WAN links, 10 P2P radio links, 18
 * internet accesses and Starlink offshore. Their own topology slide flags
 * *"SD-WAN (to_mda_via_sapudi)(internal4): High packet loss"* — this is the
 * view where that lives, instead of being a row buried in Latest data.
 */

const STATE_LABEL: Record<LinkState, string> = {
  up: 'Up',
  degraded: 'Degraded',
  down: 'Down',
  unknown: 'No data',
};

const STATE_COLOR: Record<LinkState, string> = {
  up: 'var(--good)',
  degraded: '#e8a33d',
  down: 'var(--danger)',
  unknown: 'var(--muted)',
};

function StatePill({ state }: { state: LinkState }) {
  return (
    <span className="link-state" style={{ ['--s' as string]: STATE_COLOR[state] }}>
      <span className="dot" /> {STATE_LABEL[state]}
    </span>
  );
}

const n = (v: number | undefined, digits: number, suffix: string) =>
  v === undefined ? '—' : `${v.toFixed(digits)}${suffix}`;

function LinkRow({ link, thresholds }: { link: Link; thresholds: LinksResponse['thresholds'] }) {
  const lossBad = link.loss !== undefined && link.loss >= thresholds.lossWarn;
  return (
    <tr>
      <td>
        <StatePill state={link.state} />
      </td>
      <td style={{ fontWeight: 500 }}>{link.label}</td>
      <td className="muted">{link.host}</td>
      <td className="muted mono">{link.target || '—'}</td>
      <td className={lossBad ? 'link-bad' : 'muted'}>{n(link.loss, 1, '%')}</td>
      <td className="muted">{n(link.latency, 2, ' ms')}</td>
      <td className="muted">{n(link.jitter, 2, ' ms')}</td>
      <td>
        {link.role ? (
          <span className={`tag ${link.role === 'main' ? 'main' : ''}`}>{link.role}</span>
        ) : (
          <span className="muted">—</span>
        )}
      </td>
      <td className="muted" style={{ whiteSpace: 'nowrap' }}>
        {fmtTime(link.lastclock)}
      </td>
    </tr>
  );
}

export default function Links() {
  const q = useAsync<LinksResponse>(() => api.links(), [], 30_000);
  const [problemsOnly, setProblemsOnly] = useState(false);
  const [search, setSearch] = useState('');

  const filtered = useMemo(() => {
    const list = q.data?.links ?? [];
    const needle = search.trim().toLowerCase();
    return list.filter((l) => {
      if (problemsOnly && l.state === 'up') return false;
      if (needle && !`${l.label} ${l.host} ${l.target}`.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [q.data, search, problemsOnly]);

  return (
    <Async loading={q.loading} error={q.error} data={q.data} loadingLabel="Reading link health…">
      {(data) => {
        if (!data.links.length) {
          return (
            <div className="panel">
              <Empty>
                No ICMP-monitored links found.
                <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>
                  This page reads <code>icmpping</code> / <code>icmppingloss</code> /{' '}
                  <code>icmppingsec</code> items from monitored hosts. Add ICMP checks in Zabbix and
                  they appear here automatically.
                </div>
              </Empty>
            </div>
          );
        }

        return (
          <>
            <div className="grid kpis">
              {(['down', 'degraded', 'up', 'unknown'] as LinkState[]).map((s) => (
                <KpiCard
                  key={s}
                  label={STATE_LABEL[s]}
                  value={data.summary[s]}
                  sub={`of ${data.summary.total} links`}
                  accent={STATE_COLOR[s]}
                />
              ))}
            </div>

            {data.paths.length > 0 && (
              <div className="panel" style={{ marginBottom: 18 }}>
                <h2>Redundant paths</h2>
                <div className="muted" style={{ fontSize: 12, marginBottom: 12 }}>
                  A paired path is only truly down when <strong>every</strong> leg is — that
                  distinction is the whole point of paying for redundancy. Pairing comes from the
                  item tag <code>link_group</code>.
                </div>
                <div className="path-grid">
                  {data.paths.map((p) => (
                    <div key={p.name} className="path-card" style={{ ['--s' as string]: STATE_COLOR[p.state] }}>
                      <div className="path-head">
                        <strong>{p.name}</strong>
                        <StatePill state={p.state} />
                      </div>
                      {p.links.map((l) => (
                        <div key={l.id} className="path-leg">
                          <span className="dot" style={{ background: STATE_COLOR[l.state] }} />
                          <span className="muted">{l.role ?? 'leg'}</span>
                          <span className="path-leg-name">{l.label}</span>
                          <span className="muted">{n(l.loss, 1, '% loss')}</span>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="controls">
              <div className="field">
                <label>Search link</label>
                <input
                  type="text"
                  placeholder="link, host or target…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              <div className="field">
                <label>Filter</label>
                <label
                  style={{ display: 'flex', alignItems: 'center', gap: 8, height: 38, cursor: 'pointer' }}
                >
                  <input
                    type="checkbox"
                    checked={problemsOnly}
                    onChange={(e) => setProblemsOnly(e.target.checked)}
                    style={{ minWidth: 'auto', width: 16, height: 16 }}
                  />
                  Not healthy only
                </label>
              </div>
              <div className="field">
                <label>&nbsp;</label>
                <span className="pill">
                  loss warn ≥ {data.thresholds.lossWarn}% · down ≥ {data.thresholds.lossCrit}%
                </span>
              </div>
            </div>

            <div className="panel">
              {filtered.length ? (
                <div className="table-wrap">
                  <table className="data">
                    <thead>
                      <tr>
                        <th>State</th>
                        <th>Link</th>
                        <th>Host</th>
                        <th>Target</th>
                        <th>Loss</th>
                        <th>Latency</th>
                        <th>Jitter</th>
                        <th>Role</th>
                        <th>Last check</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filtered.map((l) => (
                        <LinkRow key={l.id} link={l} thresholds={data.thresholds} />
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <Empty>No links match the filter.</Empty>
              )}
            </div>
          </>
        );
      }}
    </Async>
  );
}
