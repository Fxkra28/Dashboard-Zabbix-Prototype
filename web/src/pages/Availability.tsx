import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useAsync } from '../hooks/useAsync';
import { useCapabilities } from '../hooks/useAi';
import { useUrlState } from '../hooks/useUrlState';
import type {
  AgingReport,
  AvailabilityBasis,
  AvailabilityReport,
  HostAvailability,
  SliProfile,
} from '../types';
import { SEVERITIES } from '../theme';
import { SeverityBadge } from '../components/StatusBadge';
import { Async, Empty } from '../components/states';
import KpiCard from '../components/KpiCard';
import {
  CoverageText,
  GapsNote,
  METHOD_LABEL,
  METHOD_NOTE,
  MethodToggle,
  NoDataPill,
  SliPill,
  fmtPct,
} from '../components/Sli';
import { monthLabel, recentMonths } from '../lib/time';
import { dur } from '../lib/units';

/**
 * Availability & response report (plan_1.2 Phase 6, HCML Goal 6):
 * *"hard to see SLA, capacity trends, and recurring issues."*
 *
 * Two questions on one page: how much of the window was each host in trouble,
 * and how long is trouble sitting unacknowledged.
 *
 * The default basis measures availability the way the SLA does (ICMP
 * unreachable or ping loss, hours with no collected data left out, via the
 * server's SLI engine). "All problems (legacy)" is the original report: any
 * open problem at or above a severity counts as downtime.
 */

/** Zabbix-style: 99.9%+ is fine, 99%+ is watch, below that is a problem. */
const availColor = (pct: number) =>
  pct >= 99.9 ? 'var(--good)' : pct >= 99 ? '#e8a33d' : 'var(--danger)';

function Aging() {
  const q = useAsync<AgingReport>(() => api.aging(), [], 30_000);

  return (
    <div className="panel">
      <h2>Unacknowledged, by age</h2>
      <Async loading={q.loading} error={q.error} data={q.data} updatedAt={q.updatedAt}>
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

/** Period: rolling `d7`/`d30`, or `m:YYYY-MM` for a calendar month (Asia/Jakarta). */
type Period = string;

function periodQuery(period: Period): { days?: number; month?: string } {
  return period.startsWith('m:') ? { month: period.slice(2) } : { days: Number(period.slice(1)) };
}

/** Hosts with no figure go last; otherwise keep the server's worst-first order. */
function orderHosts(hosts: HostAvailability[]): HostAvailability[] {
  return hosts
    .map((h, i) => ({ h, i }))
    .sort((a, b) => (a.h.availability === null ? 1 : 0) - (b.h.availability === null ? 1 : 0) || a.i - b.i)
    .map((x) => x.h);
}

const BASES: AvailabilityBasis[] = ['availability', 'all-problems'];
const PROFILES: SliProfile[] = ['availability', 'hcml-report'];

export default function Availability() {
  const months = useMemo(() => recentMonths(12), []);
  const periods = useMemo(() => ['d7', 'd30', ...months.map((m) => `m:${m}`)], [months]);
  // Period, basis, method and severity live in the URL, so Back from a host graph keeps the report.
  const [period, setPeriod] = useUrlState<Period>('period', 'd7', { options: periods });
  const [basis, setBasis] = useUrlState<AvailabilityBasis>('basis', 'availability', { options: BASES });
  const [profile, setProfile] = useUrlState<SliProfile>('method', 'availability', { options: PROFILES });
  // -1 = "follow the server". Until the operator picks a floor themselves,
  // the page uses the server's configured default rather than a hardcoded one,
  // so an estate that alarms at Warning doesn't open to an empty report.
  const { availabilityMinSeverity } = useCapabilities();
  const [picked, setPicked] = useUrlState<number>('severity', -1, { options: [-1, 0, 1, 2, 3, 4, 5] });
  const severity = picked >= 0 ? picked : availabilityMinSeverity;
  const legacy = basis === 'all-problems';

  const q = useAsync<AvailabilityReport>(
    () =>
      api.availability({
        basis,
        profile: legacy ? undefined : profile,
        severity: legacy ? severity : undefined,
        ...periodQuery(period),
      }),
    [period, basis, profile, legacy ? severity : -1],
  );

  return (
    <>
      <div className="controls">
        <div className="field">
          <label htmlFor="avail-period">Period</label>
          <select id="avail-period" value={period} onChange={(e) => setPeriod(e.target.value)}>
            <optgroup label="Rolling">
              <option value="d7">Last 7 days</option>
              <option value="d30">Last 30 days</option>
            </optgroup>
            <optgroup label="Calendar month (Asia/Jakarta)">
              {months.map((m, i) => (
                <option key={m} value={`m:${m}`}>
                  {monthLabel(m)}
                  {i === 0 ? ' (so far)' : ''}
                </option>
              ))}
            </optgroup>
          </select>
        </div>
        <div className="field">
          <label htmlFor="avail-basis">Basis</label>
          <select
            id="avail-basis"
            value={basis}
            onChange={(e) => setBasis(e.target.value as AvailabilityBasis)}
          >
            <option value="availability">Availability (ICMP)</option>
            <option value="all-problems">All problems (legacy)</option>
          </select>
        </div>
        {legacy ? (
          <div className="field">
            <label htmlFor="avail-severity">Counts problems of at least</label>
            <select id="avail-severity" value={severity} onChange={(e) => setPicked(Number(e.target.value))}>
              {SEVERITIES.map((s) => (
                <option key={s.level} value={s.level}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
        ) : (
          <MethodToggle value={profile} onChange={setProfile} />
        )}
      </div>

      <Async
        loading={q.loading}
        error={q.error}
        data={q.data}
        stale={q.stale}
        updatedAt={q.updatedAt}
        loadingLabel="Replaying event history…"
      >
        {(data) => {
          const engine = data.basis !== 'all-problems' && data.overall !== undefined;
          // A BFF from before months reached the legacy report answers with its default window instead.
          const monthIgnored = !q.stale && period.startsWith('m:') && !engine && data.month !== period.slice(2);
          const target = data.target ?? 99;
          const hosts = orderHosts(data.hosts);
          const measured = data.hosts.filter((h) => h.availability !== null);
          const worst = measured.reduce<HostAvailability | undefined>(
            (w, h) => (w === undefined || (h.availability ?? 100) < (w.availability ?? 100) ? h : w),
            undefined,
          );
          const avg = measured.length
            ? measured.reduce((s, h) => s + (h.availability ?? 0), 0) / measured.length
            : 100;
          const below = (data.sites ?? []).filter((s) => s.meeting === false);
          const hasSite = data.hosts.some((h) => h.site !== undefined);
          const hasCategory = data.hosts.some((h) => h.category !== undefined);
          const hasCoverage = data.hosts.some((h) => h.coverage !== undefined);

          return (
            <>
              {engine && data.overall ? (
                <div className="grid kpis sli-kpis">
                  <KpiCard
                    label={`Overall · ${METHOD_LABEL[data.profile ?? profile]}`}
                    value={fmtPct(data.overall.sli)}
                    sub={
                      data.overall.sli === null
                        ? 'no data'
                        : `target ${target}% · ${data.overall.withData} of ${data.overall.hosts} devices measured`
                    }
                    accent={
                      data.overall.sli === null
                        ? 'var(--muted)'
                        : data.overall.meeting
                          ? 'var(--good)'
                          : 'var(--danger)'
                    }
                  />
                  {(data.categories ?? []).map((c) => (
                    <KpiCard
                      key={c.key}
                      label={c.name}
                      value={c.sli === null ? 'No data' : fmtPct(c.sli)}
                      sub={
                        c.sli === null
                          ? `${c.hosts} devices, none with data`
                          : `${c.withData} of ${c.hosts} measured · ${c.belowTarget} below ${target}%`
                      }
                      accent={c.sli === null ? 'var(--muted)' : c.meeting ? 'var(--good)' : 'var(--danger)'}
                    />
                  ))}
                  <KpiCard
                    label="Sites below target"
                    value={below.length}
                    sub={
                      below.length
                        ? below
                            .slice(0, 3)
                            .map((s) => s.name)
                            .join(', ') + (below.length > 3 ? ` +${below.length - 3}` : '')
                        : `all sites at or above ${target}%`
                    }
                    accent={below.length ? 'var(--danger)' : 'var(--good)'}
                  />
                </div>
              ) : (
                <div className="grid kpis sli-kpis">
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
                    value={worst?.availability != null ? `${worst.availability.toFixed(2)}%` : '—'}
                    sub={worst?.host ?? 'nothing recorded'}
                    accent={worst?.availability != null ? availColor(worst.availability) : undefined}
                  />
                </div>
              )}

              {engine && (
                <p className="sli-method-note">
                  <strong>{METHOD_LABEL[data.profile ?? profile]}.</strong> {METHOD_NOTE}
                </p>
              )}
              {engine && <GapsNote gaps={data.gaps} profile={data.profile ?? profile} />}

              {monthIgnored && (
                <div className="notice warn">
                  This BFF doesn’t support calendar months for the legacy basis yet — these figures
                  cover the last {Math.round(data.windowSeconds / 86400)} days instead.
                </div>
              )}

              {data.truncated && (
                <div className="notice warn">
                  Zabbix returned a full page of events for this window, so these figures are a{' '}
                  <strong>floor</strong> — real downtime may be higher. Narrow the period for exact
                  numbers.
                </div>
              )}

              <div className="grid sli-grid">
                <div className="panel">
                  <h2>Availability by host</h2>
                  <div className="muted" style={{ fontSize: 12, marginBottom: 12 }}>
                    {engine ? (
                      <>
                        Share of the measured time each device was reachable without high ping loss.
                        Devices with too little collected data show <NoDataPill /> and are left out
                        of every average.
                      </>
                    ) : (
                      <>
                        Share of the period with no open problem at or above the chosen severity.
                        Overlapping problems are merged, so simultaneous alerts aren’t double-counted.
                      </>
                    )}
                  </div>
                  {hosts.length ? (
                    <div className="table-wrap sli-scroll">
                      <table className="data compact">
                        <thead>
                          <tr>
                            <th>Host</th>
                            {hasSite && <th>Site</th>}
                            {hasCategory && <th>Category</th>}
                            <th>Availability</th>
                            <th>Downtime</th>
                            <th>Incidents</th>
                            <th>Longest</th>
                            {hasCoverage && <th>Coverage</th>}
                          </tr>
                        </thead>
                        <tbody>
                          {hosts.map((h) => (
                            <tr key={h.hostid}>
                              <td style={{ fontWeight: 500 }}>
                                <Link to={`/graphs?hostid=${h.hostid}`}>{h.host}</Link>
                              </td>
                              {hasSite && (
                                <td className="muted">{h.site ? `${h.site.code} · ${h.site.name}` : '—'}</td>
                              )}
                              {hasCategory && <td className="muted">{h.category ?? '—'}</td>}
                              <td>
                                {engine ? (
                                  <SliPill
                                    sli={h.availability}
                                    target={target}
                                    dataStatus={h.dataStatus}
                                    digits={3}
                                  />
                                ) : h.availability === null ? (
                                  <NoDataPill />
                                ) : (
                                  <strong style={{ color: availColor(h.availability) }}>
                                    {h.availability.toFixed(3)}%
                                  </strong>
                                )}
                              </td>
                              <td className="muted nowrap">{h.availability === null ? '—' : dur(h.downtime)}</td>
                              <td className="muted">{h.availability === null ? '—' : h.incidents}</td>
                              <td className="muted nowrap">{h.availability === null ? '—' : dur(h.longest)}</td>
                              {hasCoverage && (
                                <td>
                                  <CoverageText coverage={h.coverage} />
                                </td>
                              )}
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
