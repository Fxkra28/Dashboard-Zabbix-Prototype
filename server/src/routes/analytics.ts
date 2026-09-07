import type { FastifyInstance } from 'fastify';
import { zbx } from '../zabbix.js';
import { cached } from '../cache.js';
import { config } from '../config.js';
import { getProblems } from '../queries.js';

/**
 * Automated reporting (plan_1.2 Phase 6, HCML Goal 6) — *"hard to see SLA,
 * capacity trends, and recurring issues."*
 *
 * Three reports live here. "Recurring issues" is already covered by the
 * existing Top 100 triggers report.
 *   • availability — how much of the window each host spent in a problem state
 *   • aging        — how long problems sit unacknowledged
 *   • capacity     — CPU / memory / filesystem trends per host
 */

/* ------------------------------------------------------------------ */
/* Availability                                                        */
/* ------------------------------------------------------------------ */

export interface HostAvailability {
  hostid: string;
  host: string;
  /** Percent of the window with no qualifying problem open. */
  availability: number;
  /** Seconds spent in a problem state (overlaps merged, not double-counted). */
  downtime: number;
  incidents: number;
  longest: number;
}

export interface AvailabilityReport {
  from: number;
  to: number;
  windowSeconds: number;
  minSeverity: number;
  hosts: HostAvailability[];
  /** True when Zabbix returned as many events as we asked for — figures are a floor. */
  truncated: boolean;
}

/** Merge overlapping intervals so two simultaneous problems aren't counted twice. */
function mergedSeconds(intervals: [number, number][]): { total: number; longest: number } {
  if (!intervals.length) return { total: 0, longest: 0 };
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  let total = 0;
  let longest = 0;
  let [start, end] = sorted[0];

  for (const [s, e] of sorted.slice(1)) {
    if (s <= end) {
      end = Math.max(end, e);
    } else {
      total += end - start;
      longest = Math.max(longest, end - start);
      [start, end] = [s, e];
    }
  }
  total += end - start;
  longest = Math.max(longest, end - start);
  return { total, longest };
}

const EVENT_LIMIT = 10_000;

/**
 * One resolved problem occurrence. Shared by the availability and alert-noise
 * reports — they ask different questions of the same history, so the fetch and
 * the problem→recovery pairing live here once rather than in each report.
 */
export interface Incident {
  eventid: string;
  /** The trigger that fired. Zabbix calls it objectid on an event. */
  objectid: string;
  host: string;
  hostid: string;
  name: string;
  severity: string;
  start: number;
  /** Recovery time, or *now* when the problem is still open. */
  end: number;
  resolved: boolean;
  acknowledged: boolean;
}

/**
 * Replay event history into incidents, clipped to the window.
 *
 * Zabbix stores PROBLEM and recovery as separate events linked by `r_eventid`,
 * so the recoveries are fetched in ONE batch rather than per problem.
 */
async function fetchIncidents(
  days: number,
  minSeverity: number,
): Promise<{ incidents: Incident[]; from: number; to: number; truncated: boolean }> {
  const to = Math.floor(Date.now() / 1000);
  const from = to - days * 86400;

  const problems = await zbx<
    {
      eventid: string;
      objectid: string;
      clock: string;
      severity: string;
      acknowledged?: string;
      r_eventid?: string;
      name?: string;
      hosts?: { hostid: string; name: string }[];
    }[]
  >('event.get', {
    source: 0,
    object: 0,
    value: 1, // PROBLEM events only
    time_from: from,
    output: ['eventid', 'objectid', 'clock', 'severity', 'r_eventid', 'acknowledged', 'name'],
    selectHosts: ['hostid', 'name'],
    sortfield: ['clock'],
    sortorder: 'DESC',
    limit: EVENT_LIMIT,
  });

  const qualifying = problems.filter((p) => Number(p.severity) >= minSeverity);

  const recoveryIds = qualifying
    .map((p) => p.r_eventid)
    .filter((id): id is string => Boolean(id) && id !== '0');
  const recoveryClock: Record<string, number> = {};
  if (recoveryIds.length) {
    const recoveries = await zbx<{ eventid: string; clock: string }[]>('event.get', {
      eventids: recoveryIds,
      output: ['eventid', 'clock'],
    });
    for (const r of recoveries) recoveryClock[r.eventid] = Number(r.clock);
  }

  const incidents: Incident[] = [];
  for (const p of qualifying) {
    const h = p.hosts?.[0];
    if (!h) continue;
    const start = Math.max(Number(p.clock), from);
    const resolved = Boolean(p.r_eventid && p.r_eventid !== '0');
    const rec = resolved ? recoveryClock[p.r_eventid as string] : undefined;
    const end = Math.min(rec ?? to, to); // still open ⇒ counts up to now
    if (end <= start) continue;

    incidents.push({
      eventid: p.eventid,
      objectid: p.objectid,
      host: h.name,
      hostid: h.hostid,
      name: p.name ?? '',
      severity: p.severity,
      start,
      end,
      resolved,
      acknowledged: p.acknowledged === '1',
    });
  }

  return { incidents, from, to, truncated: problems.length >= EVENT_LIMIT };
}

export async function getAvailability(days: number, minSeverity: number): Promise<AvailabilityReport> {
  const { incidents, from, to, truncated } = await fetchIncidents(days, minSeverity);

  const byHost = new Map<string, { host: string; intervals: [number, number][] }>();
  for (const i of incidents) {
    const row = byHost.get(i.hostid) ?? { host: i.host, intervals: [] };
    row.intervals.push([i.start, i.end]);
    byHost.set(i.hostid, row);
  }

  const windowSeconds = to - from;
  const hosts: HostAvailability[] = [...byHost.entries()]
    .map(([hostid, row]) => {
      const { total, longest } = mergedSeconds(row.intervals);
      return {
        hostid,
        host: row.host,
        availability: Math.max(0, 100 * (1 - total / windowSeconds)),
        downtime: total,
        incidents: row.intervals.length,
        longest,
      };
    })
    .sort((a, b) => a.availability - b.availability || b.downtime - a.downtime);

  return { from, to, windowSeconds, minSeverity, hosts, truncated };
}

/* ------------------------------------------------------------------ */
/* Alert noise / flapping                                              */
/* ------------------------------------------------------------------ */

/**
 * HCML Goal 4: *"the main issue is not the number of alarms, but the quality
 * of information needed to act."*
 *
 * Top 100 triggers already answers *how often* a trigger fired. That alone
 * can't separate noise from signal: forty firings that self-clear in 90
 * seconds are noise; forty that take an hour each are a real recurring fault.
 * Duration and acknowledgement are what tell them apart, so this report adds
 * both — and flags the triggers worth retuning.
 */

export type NoiseFlag = 'flapping' | 'unactioned' | 'chronic';

export interface NoisyTrigger {
  objectid: string;
  name: string;
  host: string;
  hostid: string;
  severity: string;
  count: number;
  /** Median, not mean — one long outlier must not hide forty short firings. */
  medianDuration: number;
  /** Incidents that cleared before anyone could realistically act. */
  shortLived: number;
  /** 0..1. Zero across many firings = the team has learned to ignore it. */
  ackRate: number;
  totalDuration: number;
  longest: number;
  stillOpen: boolean;
  flags: NoiseFlag[];
}

export interface NoiseReport {
  from: number;
  to: number;
  windowSeconds: number;
  minSeverity: number;
  truncated: boolean;
  totalEvents: number;
  distinctTriggers: number;
  /** The Pareto line: "N triggers produced X% of all alerts." */
  concentration: { topN: number; percentOfEvents: number };
  counts: Record<NoiseFlag, number>;
  thresholds: { shortSeconds: number; minCount: number };
  triggers: NoisyTrigger[];
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

/** A single stuck condition is a different problem from a chatty one. */
const CHRONIC_SECONDS = 86_400;

export async function getNoise(days: number, minSeverity: number): Promise<NoiseReport> {
  const { incidents, from, to, truncated } = await fetchIncidents(days, minSeverity);
  const { shortSeconds, minCount } = config.noise;

  const byTrigger = new Map<string, Incident[]>();
  for (const i of incidents) {
    byTrigger.set(i.objectid, [...(byTrigger.get(i.objectid) ?? []), i]);
  }

  const triggers: NoisyTrigger[] = [...byTrigger.entries()].map(([objectid, list]) => {
    const durations = list.map((i) => i.end - i.start);
    const acked = list.filter((i) => i.acknowledged).length;
    const med = median(durations);
    const longest = Math.max(...durations);
    const stillOpen = list.some((i) => !i.resolved);
    const ackRate = acked / list.length;

    const flags: NoiseFlag[] = [];
    // Fires often and clears itself before anyone could act.
    if (list.length >= minCount && med < shortSeconds) flags.push('flapping');
    // Fires often and nobody has ever acknowledged it.
    if (list.length >= minCount && acked === 0) flags.push('unactioned');
    // Not noise — one condition nobody has cleared.
    if (stillOpen && longest > CHRONIC_SECONDS) flags.push('chronic');

    // The newest incident carries the most current name/severity.
    const latest = list.reduce((a, b) => (b.start > a.start ? b : a));

    return {
      objectid,
      name: latest.name,
      host: latest.host,
      hostid: latest.hostid,
      severity: latest.severity,
      count: list.length,
      medianDuration: med,
      shortLived: durations.filter((d) => d < shortSeconds).length,
      ackRate,
      totalDuration: durations.reduce((a, b) => a + b, 0),
      longest,
      stillOpen,
      flags,
    };
  });

  triggers.sort((a, b) => b.count - a.count || b.totalDuration - a.totalDuration);

  // Pareto: how much of the total alert volume comes from the loudest few?
  const topN = Math.min(5, triggers.length);
  const topEvents = triggers.slice(0, topN).reduce((s, t) => s + t.count, 0);

  const counts: Record<NoiseFlag, number> = { flapping: 0, unactioned: 0, chronic: 0 };
  for (const t of triggers) for (const f of t.flags) counts[f]++;

  return {
    from,
    to,
    windowSeconds: to - from,
    minSeverity,
    truncated,
    totalEvents: incidents.length,
    distinctTriggers: triggers.length,
    concentration: {
      topN,
      percentOfEvents: incidents.length ? Math.round((topEvents / incidents.length) * 100) : 0,
    },
    counts,
    thresholds: { shortSeconds, minCount },
    triggers,
  };
}

/* ------------------------------------------------------------------ */
/* Action aging                                                        */
/* ------------------------------------------------------------------ */

export interface AgingReport {
  buckets: { label: string; count: number }[];
  unacknowledged: number;
  total: number;
  /** The problems that have gone unacknowledged longest. */
  oldest: {
    eventid: string;
    name: string;
    host: string;
    severity: string;
    clock: string;
    ageSeconds: number;
  }[];
}

const BUCKETS: { label: string; maxSeconds: number }[] = [
  { label: 'Under 1h', maxSeconds: 3600 },
  { label: '1–4h', maxSeconds: 4 * 3600 },
  { label: '4–24h', maxSeconds: 86400 },
  { label: 'Over 24h', maxSeconds: Infinity },
];

export async function getAging(): Promise<AgingReport> {
  const problems = await cached('problems', 5_000, getProblems);
  const now = Math.floor(Date.now() / 1000);
  const unacked = problems.filter((p) => p.acknowledged !== '1');

  const buckets = BUCKETS.map((b) => ({ label: b.label, count: 0 }));
  for (const p of unacked) {
    const age = now - Number(p.clock);
    const i = BUCKETS.findIndex((b) => age < b.maxSeconds);
    buckets[i < 0 ? BUCKETS.length - 1 : i].count++;
  }

  return {
    buckets,
    unacknowledged: unacked.length,
    total: problems.length,
    oldest: unacked
      .map((p) => ({
        eventid: p.eventid,
        name: p.name,
        host: p.host ?? '',
        severity: p.severity,
        clock: p.clock,
        ageSeconds: now - Number(p.clock),
      }))
      .sort((a, b) => b.ageSeconds - a.ageSeconds)
      .slice(0, 20),
  };
}

/* ------------------------------------------------------------------ */
/* Capacity                                                            */
/* ------------------------------------------------------------------ */

/**
 * Key matchers, verified against a real Zabbix 7.0 Linux template. Note
 * `system.cpu.util` must match EXACTLY — `system.cpu.util[,idle]` is the idle
 * share, the opposite of what a capacity report wants.
 */
const METRICS: { key: string; label: string; search: string; match: (k: string) => boolean }[] = [
  {
    key: 'cpu',
    label: 'CPU utilisation',
    search: 'system.cpu.util',
    match: (k) => k === 'system.cpu.util' || k === 'system.cpu.util[]',
  },
  {
    key: 'memory',
    label: 'Memory utilisation',
    search: 'vm.memory.util',
    match: (k) => k === 'vm.memory.util' || k === 'vm.memory.utilization',
  },
  {
    key: 'disk',
    label: 'Filesystem used',
    search: 'vfs.fs',
    match: (k) => /,\s*pused\]$/.test(k),
  },
];

export interface CapacityRow {
  metric: string;
  label: string;
  itemid: string;
  hostid: string;
  host: string;
  name: string;
  units: string;
  avg: number;
  max: number;
  /** 'trend' = hourly aggregates, 'history' = raw points (young instances). */
  source: 'trend' | 'history' | 'none';
}

export interface CapacityReport {
  days: number;
  metrics: { key: string; label: string; rows: CapacityRow[] }[];
}

export async function getCapacity(days: number, top: number): Promise<CapacityReport> {
  const to = Math.floor(Date.now() / 1000);
  const from = to - days * 86400;

  const metrics = await Promise.all(
    METRICS.map(async (m) => {
      const items = (
        await zbx<
          {
            itemid: string;
            name: string;
            key_: string;
            units?: string;
            value_type: string;
            hosts?: { hostid: string; name: string }[];
          }[]
        >('item.get', {
          output: ['itemid', 'name', 'key_', 'units', 'value_type'],
          search: { key_: m.search },
          monitored: true, // exclude template items
          selectHosts: ['hostid', 'name'],
        })
      ).filter((i) => m.match(i.key_));

      if (!items.length) return { key: m.key, label: m.label, rows: [] };

      const itemids = items.map((i) => i.itemid);

      // Trends are hourly and only exist once an hour has passed; a young
      // instance has history but no trends, so fall back rather than show
      // an empty report.
      let stats = await zbx<{ itemid: string; value_avg: string; value_max: string }[]>('trend.get', {
        itemids,
        time_from: from,
        time_till: to,
        output: ['itemid', 'value_avg', 'value_max'],
      });
      let source: CapacityRow['source'] = stats.length ? 'trend' : 'history';

      if (!stats.length) {
        const hist = await zbx<{ itemid: string; value: string }[]>('history.get', {
          itemids,
          history: Number(items[0].value_type) === 3 ? 3 : 0,
          time_from: from,
          time_till: to,
          output: 'extend',
          limit: 50_000,
        });
        if (!hist.length) source = 'none';
        stats = hist.map((h) => ({ itemid: h.itemid, value_avg: h.value, value_max: h.value }));
      }

      const agg = new Map<string, { sum: number; n: number; max: number }>();
      for (const s of stats) {
        const a = agg.get(s.itemid) ?? { sum: 0, n: 0, max: -Infinity };
        a.sum += Number(s.value_avg);
        a.n++;
        a.max = Math.max(a.max, Number(s.value_max));
        agg.set(s.itemid, a);
      }

      const rows: CapacityRow[] = items
        .map((i) => {
          const a = agg.get(i.itemid);
          const host = i.hosts?.[0];
          return {
            metric: m.key,
            label: m.label,
            itemid: i.itemid,
            hostid: host?.hostid ?? '',
            host: host?.name ?? '',
            name: i.name,
            units: i.units ?? '%',
            avg: a && a.n ? a.sum / a.n : 0,
            max: a && Number.isFinite(a.max) ? a.max : 0,
            source,
          };
        })
        .sort((a, b) => b.avg - a.avg)
        .slice(0, top);

      return { key: m.key, label: m.label, rows };
    }),
  );

  return { days, metrics };
}

/* ------------------------------------------------------------------ */

export async function analyticsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/reports/availability', (req) => {
    const q = req.query as { days?: string; severity?: string };
    const days = Math.min(Math.max(Number(q.days ?? 7), 1), 365);
    const minSeverity = Math.min(Math.max(Number(q.severity ?? 3), 0), 5);
    return cached(`avail:${days}:${minSeverity}`, 120_000, () => getAvailability(days, minSeverity));
  });

  app.get('/api/reports/noise', (req) => {
    const q = req.query as { days?: string; severity?: string };
    const days = Math.min(Math.max(Number(q.days ?? 7), 1), 365);
    const minSeverity = Math.min(Math.max(Number(q.severity ?? 0), 0), 5);
    return cached(`noise:${days}:${minSeverity}`, 120_000, () => getNoise(days, minSeverity));
  });

  app.get('/api/reports/aging', () => cached('aging', 15_000, getAging));

  app.get('/api/reports/capacity', (req) => {
    const q = req.query as { days?: string; top?: string };
    const days = Math.min(Math.max(Number(q.days ?? 7), 1), 365);
    const top = Math.min(Math.max(Number(q.top ?? 10), 1), 50);
    return cached(`capacity:${days}:${top}`, 300_000, () => getCapacity(days, top));
  });
}
