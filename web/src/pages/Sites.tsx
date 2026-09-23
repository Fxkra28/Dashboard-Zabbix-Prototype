import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useAsync } from '../hooks/useAsync';
import { useUrlState } from '../hooks/useUrlState';
import type { Site, SiteSource, SitesResponse } from '../types';
import { SEVERITIES } from '../theme';
import { HostStatePill, SeverityCounts } from '../components/StatusBadge';
import { Async, Empty } from '../components/states';
import { ifaceType } from '../lib/severity';

/**
 * Site view (plan_1.2 Phase 1, HCML Goal 5). HCML's estate is organised by
 * site, but the dashboard only ever showed one flat host list. This is the
 * board management actually reads: worst site first.
 */

/** Hosts down: by ping-first state when the BFF sends it, else by interface flags. */
const downCount = (site: Site) => site.down ?? site.unavailable;

/** A site is only "healthy" when nothing is firing and nothing is unreachable. */
function siteColor(site: Site): string {
  if (site.worst >= 0) return SEVERITIES[site.worst]?.color ?? 'var(--danger)';
  if (downCount(site) > 0) return 'var(--danger)';
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
  const down = downCount(site);
  const clear = site.worst < 0 && down === 0;
  const hasStates = site.down !== undefined;
  const noData = hasStates ? (site.nodata ?? 0) : site.unknown;

  return (
    <button
      className={`site-card${selected ? ' sel' : ''}`}
      onClick={onSelect}
      aria-pressed={selected}
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
          {down > 0 && <span className="down">{down} down</span>}
          {(site.degraded ?? 0) > 0 && (
            <span className="degraded" title="Answer ping, but SNMP polling or the Zabbix agent is silent">
              {site.degraded} degraded
            </span>
          )}
          {noData > 0 && (
            <span className="muted">
              {noData} {hasStates ? 'no data' : 'unknown'}
            </span>
          )}
          {site.maintenance > 0 && <span className="muted">{site.maintenance} maint.</span>}
        </span>
      </div>
    </button>
  );
}

/** Where a host's site came from, strongest first. */
const SOURCE_LABEL: Record<SiteSource, string> = {
  tag: 'site tag',
  name: 'from host name',
  inventory: 'inventory',
  group: 'host group (guess)',
};

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
              <th>Site from</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {site.hosts.map((h) => {
              const iface = h.interfaces?.[0];
              return (
                <tr key={h.hostid}>
                  <td style={{ fontWeight: 500 }}>{h.name}</td>
                  <td className="muted mono">
                    {iface ? `${iface.ip} · ${ifaceType(iface.type)}` : '—'}
                  </td>
                  <td>
                    <HostStatePill host={h} />
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
                    <span className={`site-src ${h.siteSource}`}>{SOURCE_LABEL[h.siteSource] ?? h.siteSource}</span>
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
 * mapping as unstandardised: this turns that into a number they can move.
 */
function Coverage({ coverage }: { coverage: SitesResponse['coverage'] }) {
  const byName = coverage.name ?? 0;
  const explicit = coverage.tag + byName + coverage.inventory;
  if (!coverage.hosts) return null;
  const pct = Math.round((explicit / coverage.hosts) * 100);

  return (
    <div className="site-coverage">
      <strong>{pct}%</strong> of hosts ({explicit} of {coverage.hosts}) have a known site — a{' '}
      <code>site</code> tag ({coverage.tag}), the site code in the host name ({byName}) or an
      inventory location ({coverage.inventory}). The remaining {coverage.group} are grouped by host
      group, which is a guess.
    </div>
  );
}

export default function Sites() {
  const q = useAsync<SitesResponse>(() => api.sites(), [], 30_000);
  // Search, filter and the open site live in the URL, so Back from a graph reopens the same site.
  const [search, setSearch] = useUrlState<string>('q', '', { debounceMs: 400 });
  const [problemsOnly, setProblemsOnly] = useUrlState<boolean>('attention', false);
  const [selected, setSelected] = useUrlState<string>('site', '');

  const filtered = useMemo(() => {
    const list = q.data?.sites ?? [];
    const needle = search.trim().toLowerCase();
    return list.filter((s) => {
      if (problemsOnly && s.problems === 0 && downCount(s) === 0) return false;
      if (needle && !s.name.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [q.data, search, problemsOnly]);

  return (
    <>
      <div className="controls">
        <div className="field">
          <label htmlFor="sites-search">Search site</label>
          <input
            id="sites-search"
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

      <Async
        loading={q.loading}
        error={q.error}
        data={q.data}
        updatedAt={q.updatedAt}
        loadingLabel="Rolling hosts up to sites…"
      >
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
                    onSelect={() => setSelected(s.name === current?.name ? '' : s.name)}
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
