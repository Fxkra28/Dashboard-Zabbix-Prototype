import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useAsync } from '../hooks/useAsync';
import type { Site, SitesResponse } from '../types';
import { SEVERITIES } from '../theme';
import { AvailabilityPill, SeverityCounts } from '../components/StatusBadge';
import { Async, Empty } from '../components/states';
import { ifaceType } from '../lib/severity';

/**
 * Site view (plan_1.2 Phase 1, HCML Goal 5). HCML's estate is organised by
 * site, but the dashboard only ever showed one flat host list. This is the
 * board management actually reads: worst site first.
 */

/** A site is only "healthy" when nothing is firing and nothing is unreachable. */
function siteColor(site: Site): string {
  if (site.worst >= 0) return SEVERITIES[site.worst]?.color ?? 'var(--danger)';
  if (site.unavailable > 0) return 'var(--danger)';
  return 'var(--good)';
}

function SiteCard({
  site,
  selected,
  onSelect,
}: {
  site: Site;
  selected: boolean;
  onSelect: () => void;
}) {
  const color = siteColor(site);
  const clear = site.worst < 0 && site.unavailable === 0;

  return (
    <button
      className={`site-card${selected ? ' sel' : ''}`}
      onClick={onSelect}
      style={{ ['--site-color' as string]: color }}
    >
      <div className="site-card-head">
        <span className="site-name">{site.name}</span>
        <span className="site-hosts">{site.total} hosts</span>
      </div>

      <div className="site-stat">
        {clear ? (
          <span className="site-ok">All clear</span>
        ) : (
          <>
            <span className="site-big">{site.problems}</span>
            <span className="site-big-label">
              {site.problems === 1 ? 'problem' : 'problems'}
              {site.unacknowledged > 0 && (
                <em> · {site.unacknowledged} unack</em>
              )}
            </span>
          </>
        )}
      </div>

      <div className="site-foot">
        {site.problems > 0 ? (
          <SeverityCounts bySeverity={site.bySeverity} />
        ) : (
          <span className="muted" style={{ fontSize: 12 }}>
            No active problems
          </span>
        )}
        <span className="site-avail">
          {site.unavailable > 0 && <span className="down">{site.unavailable} down</span>}
          {site.unknown > 0 && <span className="muted">{site.unknown} unknown</span>}
          {site.maintenance > 0 && <span className="muted">{site.maintenance} maint.</span>}
        </span>
      </div>
    </button>
  );
}

function SiteHosts({ site }: { site: Site }) {
  return (
    <div className="panel">
      <h2>{site.name} — hosts</h2>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Host</th>
              <th>Interface</th>
              <th>Availability</th>
              <th>Status</th>
              <th>Problems</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {site.hosts.map((h) => {
              const iface = h.interfaces?.[0];
              const label =
                h.availability === 'available'
                  ? 'Available'
                  : h.availability === 'unavailable'
                    ? 'Unavailable'
                    : 'Unknown';
              return (
                <tr key={h.hostid}>
                  <td style={{ fontWeight: 500 }}>{h.name}</td>
                  <td className="muted mono">
                    {iface ? `${iface.ip} · ${ifaceType(iface.type)}` : '—'}
                  </td>
                  <td>
                    <AvailabilityPill
                      kind={h.availability === 'unavailable' ? 'down' : h.availability === 'available' ? 'up' : 'unknown'}
                      label={label}
                    />
                  </td>
                  <td>
                    {h.maintenance_status === '1' ? (
                      <span className="pill">Maintenance</span>
                    ) : h.status === '0' ? (
                      <span className="pill up">Monitored</span>
                    ) : (
                      <span className="pill">Disabled</span>
                    )}
                  </td>
                  <td>
                    {h.problems.total > 0 ? (
                      <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
                        <SeverityCounts bySeverity={h.problems.bySeverity} />
                        <span className="muted">({h.problems.total})</span>
                      </span>
                    ) : (
                      <span className="muted">None</span>
                    )}
                  </td>
                  <td>
                    <Link className="btn ghost sm" to={`/graphs?hostid=${h.hostid}`}>
                      Graphs
                    </Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * How many hosts carry a deliberate site marker. HCML's Goal 1 names site
 * mapping as unstandardised — this turns that into a number they can move.
 */
function Coverage({ coverage }: { coverage: SitesResponse['coverage'] }) {
  const explicit = coverage.tag + coverage.inventory;
  if (!coverage.hosts) return null;
  const pct = Math.round((explicit / coverage.hosts) * 100);

  return (
    <div className="site-coverage">
      <strong>{pct}%</strong> of hosts ({explicit} of {coverage.hosts}) carry an explicit site —
      a <code>site</code> tag or an inventory location. The remaining {coverage.group} are grouped by
      host group, which is a guess.
    </div>
  );
}

export default function Sites() {
  const q = useAsync<SitesResponse>(() => api.sites(), [], 30_000);
  const [search, setSearch] = useState('');
  const [problemsOnly, setProblemsOnly] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const list = q.data?.sites ?? [];
    const needle = search.trim().toLowerCase();
    return list.filter((s) => {
      if (problemsOnly && s.problems === 0 && s.unavailable === 0) return false;
      if (needle && !s.name.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [q.data, search, problemsOnly]);

  return (
    <>
      <div className="controls">
        <div className="field">
          <label>Search site</label>
          <input
            type="text"
            placeholder="site name…"
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
            Needing attention only
          </label>
        </div>
        <div className="field">
          <label>&nbsp;</label>
          <span className="pill">{filtered.length} sites</span>
        </div>
      </div>

      <Async loading={q.loading} error={q.error} data={q.data} loadingLabel="Rolling hosts up to sites…">
        {(data) => {
          if (!filtered.length) {
            return (
              <div className="panel">
                <Empty>No sites match the filter.</Empty>
              </div>
            );
          }

          const current = filtered.find((s) => s.name === selected) ?? null;

          return (
            <>
              <Coverage coverage={data.coverage} />

              <div className="site-grid">
                {filtered.map((s) => (
                  <SiteCard
                    key={s.name}
                    site={s}
                    selected={s.name === current?.name}
                    onSelect={() => setSelected(s.name === current?.name ? null : s.name)}
                  />
                ))}
              </div>

              {current ? (
                <SiteHosts site={current} />
              ) : (
                <div className="muted" style={{ textAlign: 'center', fontSize: 13, padding: 8 }}>
                  Select a site to see its hosts.
                </div>
              )}
            </>
          );
        }}
      </Async>
    </>
  );
}
