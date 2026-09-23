import { api, streamUrl } from '../api';
import { useAsync } from '../hooks/useAsync';
import { useSSE } from '../hooks/useSSE';
import type { Problem, Stats, GroupProblems } from '../types';
import { SEVERITIES } from '../theme';
import KpiCard from '../components/KpiCard';
import ProblemsTable from '../components/ProblemsTable';
import { SeverityCounts } from '../components/StatusBadge';
import { Async } from '../components/states';

export default function Overview() {
  const statsQ = useAsync<Stats>(() => api.stats(), [], 30_000);
  const groupsQ = useAsync<GroupProblems[]>(() => api.problemsByGroup(), [], 15_000);

  // Live problems over SSE. The poll is a safety net for a dropped stream, not
  // a second source of truth, at 10s it duplicated every SSE tick, so it runs
  // slowly and only while the stream has given us nothing (plan_1.2 defect #3).
  const live = useSSE<Problem[]>(streamUrl(), 'problems');
  // Trust the stream only while it is connected. Keying on `live.data` alone
  // stopped the poll for good after the first frame, so a stream that later
  // failed left a frozen list on screen with nothing refreshing it.
  const streaming = Boolean(live.data) && live.connected;
  // Toggling the interval never fetches by itself (useAsync), so the stream
  // connecting no longer costs a second full problem list.
  const pollQ = useAsync<Problem[]>(() => api.problems(), [], streaming ? undefined : 60_000);
  // Off the stream, show whichever source is newer: the poll's list from page
  // load must not replace the stream's last frame.
  const fromStream = streaming || (live.updatedAt ?? 0) > (pollQ.updatedAt ?? 0);
  const current = fromStream ? live.data : pollQ.data;
  const problems = current ?? [];

  const stats = statsQ.data;
  const bySev = (lvl: number) => problems.filter((p) => Number(p.severity) === lvl).length;
  const high = problems.filter((p) => Number(p.severity) >= 4).length;
  /** A count once the list is in, a placeholder before, never a zero that only means "not loaded". */
  const count = (n: number) => (current ? n : '…');

  return (
    <>
      {/* System information (Zabbix "System information" report) */}
      <div className="grid kpis">
        <KpiCard label="Hosts" value={stats?.hosts ?? '…'} sub="monitored" />
        <KpiCard label="Items" value={stats?.items ?? '…'} sub="collecting" accent="#3B8FCB" />
        <KpiCard label="Triggers" value={stats?.triggers ?? '…'} accent="#7C4DFF" />
        <KpiCard label="Host groups" value={stats?.groups ?? '…'} accent="#2E9E5B" />
      </div>

      {/* Problem KPIs */}
      <div className="grid kpis">
        <KpiCard label="Open problems" value={count(problems.length)} accent="#0067B1" />
        <KpiCard
          label="High / Disaster"
          value={count(high)}
          accent={SEVERITIES[5].color}
          sub="severity ≥ High"
        />
        <KpiCard
          label="Warnings"
          value={count(bySev(2) + bySev(3))}
          accent={SEVERITIES[3].color}
          sub="Warning + Average"
        />
        <KpiCard
          label="Unacknowledged"
          value={stats?.unacknowledged ?? '…'}
          accent={SEVERITIES[4].color}
        />
      </div>

      <div className="grid two-col">
        <div className="panel">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h2 style={{ margin: 0 }}>Live problems</h2>
            <span className={`live${streaming ? '' : ' off'}`} title={live.error ?? undefined}>
              <span className="dot" />
              {streaming ? 'Live (SSE)' : live.error ? 'Polling — live stream error' : 'Polling'}
            </span>
          </div>
          <div style={{ marginTop: 14 }}>
            <Async
              loading={pollQ.loading && !live.data}
              error={fromStream ? null : pollQ.error}
              data={current}
              updatedAt={pollQ.updatedAt}
            >
              {(p) => <ProblemsTable problems={p.slice(0, 12)} />}
            </Async>
          </div>
        </div>

        <div className="panel">
          <h2>Problems by host group</h2>
          <Async
            loading={groupsQ.loading}
            error={groupsQ.error}
            data={groupsQ.data}
            updatedAt={groupsQ.updatedAt}
          >
            {(groups) =>
              groups.length ? (
                <table className="data">
                  <thead>
                    <tr>
                      <th>Host group</th>
                      <th>Severities</th>
                      <th style={{ textAlign: 'right' }}>Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {groups.map((g) => (
                      <tr key={g.groupid}>
                        <td>{g.name}</td>
                        <td>
                          <SeverityCounts bySeverity={g.bySeverity} />
                        </td>
                        <td style={{ textAlign: 'right', fontWeight: 600 }}>{g.total}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <div className="state">No problems across any host group. 🎉</div>
              )
            }
          </Async>

          <h2 style={{ marginTop: 22 }}>Problems by severity</h2>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
            {SEVERITIES.slice()
              .reverse()
              .map((s) => (
                <div key={s.level} className="sev-tile">
                  <span className="dot" style={{ background: s.color }} />
                  <span style={{ fontSize: 13 }}>{s.name}</span>
                  <strong>{bySev(s.level)}</strong>
                </div>
              ))}
          </div>
        </div>
      </div>
    </>
  );
}
