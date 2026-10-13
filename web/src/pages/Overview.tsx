import { useEffect, useMemo, useRef } from 'react';
import { Link, useOutletContext } from 'react-router-dom';
import { api, streamUrl } from '../api';
import { useAsync } from '../hooks/useAsync';
import { useNow } from '../hooks/useNow';
import { useSSE } from '../hooks/useSSE';
import { useChangeHighlight, useReducedMotion } from '../hooks/useChangeHighlight';
import type { Problem, Stats, Freshness, GroupProblems } from '../types';
import { SEVERITIES } from '../theme';
import KpiCard from '../components/KpiCard';
import ProblemsTable from '../components/ProblemsTable';
import BrandMark from '../components/BrandMark';
import { SeverityCounts } from '../components/StatusBadge';
import { Async, RefreshFailed } from '../components/states';
import type { LayoutContext } from '../components/Layout';
import { LIVE_ROWS, liveRows, topRows } from '../lib/liveList';
import { ageWords, momentWords } from '../lib/freshness';
import { problemListGuard } from '../lib/guards';

/**
 * The problem list also holds problems Zabbix resolved a moment ago and ones
 * inside a planned maintenance window (the Problems page marks both). The
 * Dashboard counts and lists the rest, as every server-side count does.
 */
const isOpen = (p: Problem) => (!p.r_eventid || p.r_eventid === '0') && p.suppressed !== '1';

/** The BFF writes at least every 15 s, a `ping` when nothing else (stream.ts); three missed means the line is dead. */
const STREAM_SILENT_MS = 45_000;
/** Past this the numbers on screen are old enough that a wall screen must say so. */
const DATA_LATE_MS = 90_000;

const clockTime = (ms: number) =>
  new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });

/** The wall's clock. Its own component, so only it re-renders every second. */
function WallClock() {
  const now = useNow(1_000);
  const at = new Date(now);
  return (
    <div className="wall-stamp">
      <span className="wall-label">
        {at.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}
      </span>
      <time className="wall-time" dateTime={at.toISOString()}>
        {clockTime(now)}
      </time>
    </div>
  );
}

/** The wall screen's header: the page, the time now, and how old the data is (DESIGN.md section 9). */
function WallBar({
  shownAt,
  lateMinutes,
  idleFor,
  onExit,
}: {
  shownAt: number | null;
  lateMinutes: number | null;
  /** How long Zabbix has collected nothing, in words, or null while it is collecting. */
  idleFor: string | null;
  onExit: () => void;
}) {
  return (
    <header className="wall-bar">
      <div className="wall-title">
        <BrandMark variant="icon" alt="HCML" />
        <h1>Dashboard</h1>
      </div>
      <WallClock />
      <div className={`wall-stamp${lateMinutes !== null || idleFor !== null ? ' late' : ''}`}>
        <span className="wall-label">Data as of</span>
        <span className="wall-time">{shownAt !== null ? clockTime(shownAt) : '…'}</span>
        {lateMinutes !== null && <span className="wall-label">No new data for {lateMinutes} min</span>}
        {idleFor !== null && <span className="wall-label">Zabbix collected nothing for {idleFor}</span>}
      </div>
      <button type="button" className="btn ghost sm" onClick={onExit}>
        Exit wall mode
      </button>
    </header>
  );
}

export default function Overview() {
  const { wall, exitWall } = useOutletContext<LayoutContext>();
  const reduceMotion = useReducedMotion();
  const now = useNow(5_000);
  const statsQ = useAsync<Stats>(() => api.stats(), [], 30_000);
  const groupsQ = useAsync<GroupProblems[]>(() => api.problemsByGroup(), [], 15_000);
  const freshQ = useAsync<Freshness>(() => api.freshness(), [], 60_000);

  // Live problems over SSE. The poll is a safety net for a dropped stream, not a second source of
  // truth: at 10 s it would duplicate every SSE tick, so it runs slowly and only while the stream
  // has given us nothing. A stream that stays open but goes silent counts as dropped (useSSE's
  // watchdog).
  const live = useSSE<Problem[]>(streamUrl(), 'problems', STREAM_SILENT_MS, problemListGuard);
  // Trust the stream only while it is connected. Keying on `live.data` alone
  // stopped the poll for good after the first frame, so a stream that later
  // failed left a frozen list on screen with nothing refreshing it.
  const streaming = Boolean(live.data) && live.connected;
  // Toggling the interval never fetches by itself (useAsync), so the stream
  // connecting no longer costs a second full problem list.
  const pollQ = useAsync<Problem[]>(() => api.problems(), [], streaming ? undefined : 60_000);
  // Falling off the stream fetches at once rather than a full interval later.
  const wasStreaming = useRef(streaming);
  const { reload } = pollQ;
  useEffect(() => {
    if (wasStreaming.current && !streaming) reload();
    wasStreaming.current = streaming;
  }, [streaming, reload]);
  // Off the stream, show whichever source is newer: the poll's list from page
  // load must not replace the stream's last frame.
  const fromStream = streaming || (live.updatedAt ?? 0) > (pollQ.updatedAt ?? 0);
  const current = fromStream ? live.data : pollQ.data;
  const open = useMemo(() => (current ? current.filter(isOpen) : null), [current]);
  // Inside a maintenance window: not counted, and not "cleared" when it goes in.
  const held = useMemo(
    () => new Set((current ?? []).filter((p) => p.suppressed === '1' && (!p.r_eventid || p.r_eventid === '0')).map((p) => p.eventid)),
    [current],
  );
  const problems = open ?? [];
  // How old the numbers on screen are, whichever source they came from.
  const shownAt = fromStream ? live.updatedAt : pollQ.updatedAt;
  const late = shownAt !== null && now - shownAt > DATA_LATE_MS;
  const lateMinutes = late && shownAt !== null ? Math.floor((now - shownAt) / 60_000) || 1 : null;
  // Zabbix itself stopped collecting: the stream stays up and keeps sending, all of it old.
  // The age counts on from the last poll's value, so the words stay right between polls.
  const collectedAt = freshQ.data?.stale ? freshQ.data.lastCollectedAt : null;
  const idleFor = collectedAt !== null ? ageWords(now / 1000 - collectedAt) : null;

  // The wall's highlight, off for anyone who has asked for less motion.
  const { marks, cleared } = useChangeHighlight(open, held, wall && !reduceMotion, topRows);
  const rows = useMemo(() => (open ? liveRows(open, cleared) : []), [open, cleared]);

  const stats = statsQ.data;
  const bySev = (lvl: number) => problems.filter((p) => Number(p.severity) === lvl).length;
  const high = problems.filter((p) => Number(p.severity) >= 4).length;
  /** A count once the list is in, a placeholder before, never a zero that only means "not loaded". */
  const count = (n: number) => (current ? n : '…');

  return (
    <>
      {wall && <WallBar shownAt={shownAt} lateMinutes={lateMinutes} idleFor={idleFor} onExit={exitWall} />}
      {/* System information (Zabbix "System information" report) */}
      {statsQ.error &&
        (statsQ.data ? (
          <RefreshFailed error={statsQ.error} updatedAt={statsQ.updatedAt} />
        ) : (
          <div className="refresh-failed" role="status" title={statsQ.error}>
            Couldn’t load the counts: {statsQ.error}
          </div>
        ))}
      {/* Stable wording: it is announced on a change, and a running count would be read out every minute. */}
      {collectedAt !== null && (
        <div className="refresh-failed" role="status">
          Zabbix has collected nothing since {momentWords(collectedAt * 1000, now)}. What you see on this page
          is from then, not from now.
        </div>
      )}
      <div className="grid kpis">
        <KpiCard label="Hosts" value={stats?.hosts ?? '…'} sub="monitored" />
        <KpiCard label="Items" value={stats?.items ?? '…'} sub="collecting" />
        <KpiCard label="Triggers" value={stats?.triggers ?? '…'} />
        <KpiCard label="Host groups" value={stats?.groups ?? '…'} />
      </div>

      {/* Problem KPIs */}
      <div className="grid kpis">
        <KpiCard label="Open problems" value={count(problems.length)} />
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
          value={count(problems.filter((p) => p.acknowledged !== '1').length)}
          accent={SEVERITIES[4].color}
        />
      </div>

      <div className="grid two-col">
        <div className="panel">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h2 style={{ margin: 0 }}>Live problems</h2>
            <span className="live-status">
              {shownAt !== null && <span className="live-age">Updated {clockTime(shownAt)}</span>}
              {/* Announced on a change of state only; the visible label's minute count would be read out every minute. */}
              <span className="sr-only" aria-live="polite">
                {late && shownAt !== null
                  ? `No new data since ${clockTime(shownAt)}`
                  : collectedAt !== null
                    ? `Zabbix has collected nothing since ${momentWords(collectedAt * 1000, now)}`
                    : streaming
                      ? 'Live'
                      : live.error
                        ? 'Polling: live stream error'
                        : 'Polling'}
              </span>
              <span
                className={`live${late || idleFor !== null ? ' late' : streaming ? '' : ' off'}`}
                title={live.error ?? pollQ.error ?? undefined}
                aria-hidden="true"
              >
                <span className="dot" />
                {lateMinutes !== null
                  ? `No new data for ${lateMinutes} min`
                  : idleFor !== null
                    ? `Zabbix has collected nothing for ${idleFor}`
                    : streaming
                      ? 'Live'
                      : live.error
                        ? 'Polling: live stream error'
                        : 'Polling'}
              </span>
            </span>
          </div>
          <div style={{ marginTop: 14 }}>
            <Async
              loading={pollQ.loading && !live.data}
              error={streaming ? null : pollQ.error}
              data={current}
              updatedAt={shownAt}
            >
              {() => (
                <>
                  <ProblemsTable problems={rows} marks={marks} />
                  {problems.length > 0 && (
                    <p className="panel-foot">
                      {Math.min(LIVE_ROWS, problems.length)} of {problems.length} open problems, worst first.
                      {/* A wall has no one to click it. */}
                      {!wall && (
                        <>
                          {' '}
                          <Link to="/problems">View all problems</Link>
                        </>
                      )}
                    </p>
                  )}
                </>
              )}
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
                <div className="table-wrap">
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
                </div>
              ) : (
                <div className="state">No problems across any host group.</div>
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
                  <span style={{ fontSize: 'var(--t-base)' }}>{s.name}</span>
                  <strong>{count(bySev(s.level))}</strong>
                </div>
              ))}
          </div>
        </div>
      </div>
    </>
  );
}
