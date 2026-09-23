import type { FastifyInstance } from 'fastify';
import { zbx } from '../zabbix.js';
import { cached } from '../cache.js';
import { BadRequestError, intParam } from '../validate.js';
import { config, type SliProfile } from '../config.js';
import { getProblems } from '../queries.js';
import { chunk, fetchEventsSliced, fetchTrendsSliced, mapLimit } from '../sli/events.js';
import { computeSli, type DataStatus, type SliGroup, type SliReport } from '../sli/engine.js';
import { monthBounds, parseMonth } from '../sli/time.js';
import type { SiteRef } from '../naming.js';
import { getMonthlySli, parseProfile } from './sli.js';

/**
 * Automated reporting (plan_1.2 Phase 6, HCML Goal 6): *"hard to see SLA,
 * capacity trends, and recurring issues."*
 *
 * Three reports live here. "Recurring issues" is already covered by the
 * existing Top 100 triggers report.
 *   • availability, how much of the window each host spent in a problem state
 *   • aging:       how long problems sit unacknowledged
 *   • capacity:    CPU / memory / filesystem trends per host
 */


export interface HostAvailability {
  hostid: string;
  host: string;
  /** Percent of the measured time with no qualifying problem open; null = no data. */
  availability: number | null;
  /** Seconds spent in a problem state (overlaps merged, not double-counted). */
  downtime: number;
  incidents: number;
  longest: number;
  /** Share of the window in which data was actually collected (availability basis). */
  coverage?: number;
  dataStatus?: DataStatus;
  category?: string;
  site?: SiteRef | null;
}

/**
 * `availability` (the default) measures what availability means: a device
 * unreachable or losing pings: through the SLA engine, and leaves out hours in
 * which nothing was collected. `all-problems` is the original report: any open
 * problem at or above the severity floor counts as downtime.
 */
export type AvailabilityBasis = 'availability' | 'all-problems';

export interface AvailabilityReport {
  from: number;
  to: number;
  windowSeconds: number;
  minSeverity: number;
  hosts: HostAvailability[];
  /** Always false now: events are fetched in slices and never silently cut. */
  truncated: boolean;
  basis: AvailabilityBasis;
  profile?: SliProfile;
  month?: string | null;
  target?: number;
  overall?: SliGroup;
  categories?: SliGroup[];
  sites?: SliGroup[];
  gaps?: SliReport['gaps'];
}

// Interval merging moved to sli/intervals.ts, shared with the SLA engine.
import { mergedSeconds } from '../sli/intervals.js';
export { mergedSeconds };

/**
 * Cap on the raw-history fallback in the capacity report. Deliberately far
 * below the old 50,000: this path only runs on an instance too young to have
 * trends, where there is little history to read in the first place.
 */
const HISTORY_FALLBACK_LIMIT = 10_000;

/**
 * Zabbix severity levels at or above `min`, for `event.get`'s `severities`.
 * Zabbix has no ">= severity" filter, only an explicit list.
 */
export function severitiesAtLeast(min: number): number[] {
  const floor = Math.min(Math.max(Math.trunc(min), 0), 5);
  return [0, 1, 2, 3, 4, 5].filter((s) => s >= floor);
}

/**
 * One resolved problem occurrence. Shared by the availability and alert-noise
 * reports: they ask different questions of the same history, so the fetch and
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

/** A report window in Unix seconds. */
export interface ReportWindow {
  from: number;
  to: number;
}

/** The last `days` days, up to now. */
function lastDays(days: number): ReportWindow {
  const to = Math.floor(Date.now() / 1000);
  return { from: to - days * 86400, to };
}

/**
 * A calendar month, cut in the SLA time zone (Asia/Jakarta) like every monthly
 * figure in the portal, and clipped to now: the current month is measured as
 * far as it has happened. Mirrors the engine's limits (computeSli).
 */
export function monthWindow(month: string): ReportWindow {
  const now = Math.floor(Date.now() / 1000);
  const { from, to } = monthBounds(month, config.sla.timezone);
  if (from >= now) throw new BadRequestError('That period has not started yet.');
  if (from < now - 400 * 86400) {
    throw new BadRequestError('Zabbix keeps events for about a year; pick a later period.');
  }
  return { from, to: Math.min(to, now) };
}

/**
 * Replay event history into incidents, clipped to the window.
 *
 * Zabbix stores PROBLEM and recovery as separate events linked by `r_eventid`,
 * so the recoveries are fetched in ONE batch rather than per problem.
 */
async function fetchIncidents(
  { from, to }: ReportWindow,
  minSeverity: number,
): Promise<{ incidents: Incident[]; from: number; to: number; truncated: boolean }> {
  // Every PROBLEM event in the window, in slices, never a silently cut page.
  // A single "newest 10,000" request used to drop the OLDEST events at HCML's
  // volume, and the report then computed impossible figures.
  const problems = await fetchEventsSliced<{
    eventid: string;
    objectid: string;
    clock: string;
    severity: string;
    acknowledged?: string;
    r_eventid?: string;
    name?: string;
    hosts?: { hostid: string; name: string }[];
  }>(
    {
      source: 0,
      object: 0,
      value: 1, // PROBLEM events only
      // Filter in Zabbix, not here: a flood of low-severity events must not
      // decide how much of the window is fetched.
      severities: severitiesAtLeast(minSeverity),
      output: ['eventid', 'objectid', 'clock', 'severity', 'r_eventid', 'acknowledged', 'name'],
      selectHosts: ['hostid', 'name'],
    },
    from,
    to,
  );

  // Belt and braces: Zabbix has already applied the floor above.
  const qualifying = problems.filter((p) => Number(p.severity) >= minSeverity);

  const recoveryIds = qualifying
    .map((p) => p.r_eventid)
    .filter((id): id is string => Boolean(id) && id !== '0');
  const recoveryClock: Record<string, number> = {};
  // Batched, but in chunks: one request naming ten thousand event ids is its
  // own failure mode.
  await mapLimit(chunk(recoveryIds, 2_000), config.sla.maxParallel, async (ids) => {
    const recoveries = await zbx<{ eventid: string; clock: string }[]>('event.get', {
      eventids: ids,
      output: ['eventid', 'clock'],
    });
    for (const r of recoveries) recoveryClock[r.eventid] = Number(r.clock);
  });

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

  return { incidents, from, to, truncated: false };
}

/**
 * Availability through the SLA engine: a device counts as down while its ICMP
 * availability triggers are in problem, and hours with no collected data are
 * left out of the measurement. Either a calendar month or a rolling window.
 */
export async function getDerivedAvailability(opts: {
  days: number;
  month?: string;
  profile: SliProfile;
  minSeverity: number;
}): Promise<AvailabilityReport> {
  const now = Math.floor(Date.now() / 1000);
  const report = opts.month
    ? await getMonthlySli(opts.month, opts.profile)
    : await computeSli({ profile: opts.profile, from: now - opts.days * 86400, to: now });

  return {
    from: report.from,
    to: report.end,
    windowSeconds: report.to - report.from,
    minSeverity: opts.minSeverity,
    hosts: report.hosts.map((h) => ({
      hostid: h.hostid,
      host: h.name,
      availability: h.sli,
      downtime: h.downtime,
      incidents: h.incidents,
      longest: h.longest,
      coverage: h.coverage,
      dataStatus: h.dataStatus,
      category: h.category,
      site: h.site,
    })),
    truncated: false,
    basis: 'availability',
    profile: report.profile,
    month: report.month,
    target: report.target,
    overall: report.overall,
    categories: report.categories,
    sites: report.sites,
    gaps: report.gaps,
  };
}

/**
 * The original report: any open problem at or above the floor counts as
 * downtime. Over the last `days` days, or over `month` when one is given.
 */
export async function getAvailability(
  days: number,
  minSeverity: number,
  month?: string,
): Promise<AvailabilityReport> {
  const window = month ? monthWindow(month) : lastDays(days);
  const { incidents, from, to, truncated } = await fetchIncidents(window, minSeverity);

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

  return { from, to, windowSeconds, minSeverity, hosts, truncated, basis: 'all-problems', month: month ?? null };
}


/**
 * HCML Goal 4: *"the main issue is not the number of alarms, but the quality
 * of information needed to act."*
 *
 * Top 100 triggers already answers *how often* a trigger fired. That alone
 * can't separate noise from signal: forty firings that self-clear in 90
 * seconds are noise; forty that take an hour each are a real recurring fault.
 * Duration and acknowledgement are what tell them apart, so this report adds
 * both, and flags the triggers worth retuning.
 */

export type NoiseFlag = 'flapping' | 'unactioned' | 'chronic';

export interface NoisyTrigger {
  objectid: string;
  name: string;
  host: string;
  hostid: string;
  severity: string;
  count: number;
  /** Median, not mean: one long outlier must not hide forty short firings. */
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
  /** Triggers in the report before `?top=` cut the list; the figures above cover all of them. */
  total: number;
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
  const { incidents, from, to, truncated } = await fetchIncidents(lastDays(days), minSeverity);
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
    // Not noise: one condition nobody has cleared.
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
    total: triggers.length,
    triggers,
  };
}

/** The loudest `top` triggers of a full report, in its order; every other figure still covers all of them. */
export function topNoise(report: NoiseReport, top: number): NoiseReport {
  return report.triggers.length <= top ? report : { ...report, triggers: report.triggers.slice(0, top) };
}


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


/**
 * Key matchers. The Linux-agent forms (`system.cpu.util`, `vm.memory.util`)
 * are what the report was first written against; HCML's estate is almost
 * entirely SNMP devices, whose templates put an OID in the key:
 *
 *   Cisco IOS by SNMP   system.cpu.util[cpmCPUTotal5minRev.19]   vm.memory.util[vm.memory.util.1]
 *   FortiGate by SNMP   system.cpu.util[fgSysCpuUsage.0]         vm.memory.util[memoryUsedPercentage.0]
 *
 * `system.cpu.util[,idle]` must NOT match: it is the idle share, the opposite
 * of what a capacity report wants, and an OID parameter never starts with a
 * comma, so the SNMP pattern cannot catch it.
 */
const SNMP_PARAM = /^\[[A-Za-z][\w.]*\.\d+\]$/;

const METRICS: {
  key: string;
  label: string;
  search: string;
  match: (k: string) => boolean;
  /** Turn a stored value into the percentage the report shows. */
  transform?: (v: number) => number;
}[] = [
  {
    key: 'cpu',
    label: 'CPU utilisation',
    search: 'system.cpu.util',
    match: (k) =>
      k === 'system.cpu.util' || k === 'system.cpu.util[]' || SNMP_PARAM.test(k.slice('system.cpu.util'.length)),
  },
  {
    key: 'memory',
    label: 'Memory utilisation',
    search: 'vm.memory.util',
    match: (k) =>
      k === 'vm.memory.util' ||
      k === 'vm.memory.utilization' ||
      SNMP_PARAM.test(k.slice('vm.memory.util'.length)),
  },
  {
    key: 'disk',
    label: 'Filesystem used',
    search: 'vfs.fs',
    match: (k) => /,\s*pused\]$/.test(k),
  },
  {
    // FortiGate reports free space only; used = 100 − free.
    key: 'disk',
    label: 'Filesystem used',
    search: 'vfs.fs.pfree',
    match: (k) => k === 'vfs.fs.pfree',
    transform: (v) => 100 - v,
  },
];

/** Exported for tests: which keys each capacity metric picks up. */
export function capacityMetricFor(key: string): string | undefined {
  return METRICS.find((m) => key.startsWith(m.search) && m.match(key))?.key;
}

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

/** Running avg/max per item, folded row by row so a year of trends is never held at once. */
type Aggregates = Map<string, { sum: number; n: number; max: number }>;

function addSample(agg: Aggregates, itemid: string, avg: number, max: number): void {
  const a = agg.get(itemid) ?? { sum: 0, n: 0, max: -Infinity };
  a.sum += avg;
  a.n++;
  a.max = Math.max(a.max, max);
  agg.set(itemid, a);
}

export async function getCapacity(days: number, top: number): Promise<CapacityReport> {
  const to = Math.floor(Date.now() / 1000);
  const from = to - days * 86400;

  const matched = await Promise.all(
    METRICS.map(async (m) =>
      (
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
          // Every METRICS key is a prefix; a substring search scans all items.
          startSearch: true,
          monitored: true, // exclude template items
          selectHosts: ['hostid', 'name'],
        })
      ).filter((i) => m.match(i.key_)),
    ),
  );

  // Every metric's trends in one sliced read, so a long window stays within
  // what Zabbix's PHP can answer (a year in one request was an HTTP 500) and
  // at most `maxParallel` requests run at once, whatever the metric count.
  const trendAgg: Aggregates = new Map();
  await fetchTrendsSliced<{ itemid: string; value_avg: string; value_max: string }>(
    [...new Set(matched.flat().map((i) => i.itemid))],
    from,
    to,
    ['itemid', 'value_avg', 'value_max'],
    {
      parallel: config.sla.maxParallel,
      onRows: (rows) => {
        for (const r of rows) addSample(trendAgg, r.itemid, Number(r.value_avg), Number(r.value_max));
      },
    },
  );

  const perMatcher = await Promise.all(
    METRICS.map(async (m, k) => {
      const items = matched[k];
      if (!items.length) return { key: m.key, label: m.label, rows: [] };

      // Trends are hourly and only exist once an hour has passed; a young
      // instance has history but no trends, so fall back rather than show
      // an empty report.
      let agg = trendAgg;
      let source: CapacityRow['source'] = items.some((i) => trendAgg.has(i.itemid)) ? 'trend' : 'history';

      if (source === 'history') {
        // Only the most recent day, not the whole requested window. No trends
        // means the instance is young, so that is where its history actually
        // is, and pulling 50k raw rows into the BFF to compute an average
        // Zabbix could have aggregated is exactly what setup.md §18 warns
        // against. Raw history is the degraded path; keep it cheap.
        const histFrom = Math.max(from, to - 86_400);
        const hist = await zbx<{ itemid: string; value: string }[]>('history.get', {
          itemids: items.map((i) => i.itemid),
          history: Number(items[0].value_type) === 3 ? 3 : 0,
          time_from: histFrom,
          time_till: to,
          output: 'extend',
          limit: HISTORY_FALLBACK_LIMIT,
        });
        if (!hist.length) source = 'none';
        agg = new Map();
        for (const h of hist) addSample(agg, h.itemid, Number(h.value), Number(h.value));
      }

      const t = m.transform ?? ((v: number) => v);
      const rows: CapacityRow[] = items
        .filter((i) => agg.has(i.itemid))
        .map((i) => {
          const a = agg.get(i.itemid)!;
          const host = i.hosts?.[0];
          const avg = a.n ? t(a.sum / a.n) : 0;
          const max = Number.isFinite(a.max) ? t(a.max) : 0;
          return {
            metric: m.key,
            label: m.label,
            itemid: i.itemid,
            hostid: host?.hostid ?? '',
            host: host?.name ?? '',
            name: i.name,
            units: i.units || '%',
            // For free→used the aggregate max of free is the minimum of used.
            avg,
            max: m.transform ? Math.max(avg, max) : max,
            source,
          };
        });

      return { key: m.key, label: m.label, rows };
    }),
  );

  // One row per host per metric: a switch with two CPU modules or a
  // "reserve Processor" memory pool is one device, shown by its busiest item.
  const byMetric = new Map<string, { label: string; rows: CapacityRow[] }>();
  for (const { key, label, rows } of perMatcher) {
    const entry = byMetric.get(key) ?? { label, rows: [] };
    entry.rows.push(...rows);
    byMetric.set(key, entry);
  }
  const metrics = [...byMetric.entries()].map(([key, { label, rows }]) => {
    const best = new Map<string, CapacityRow>();
    for (const r of rows) {
      const prev = best.get(r.hostid || r.itemid);
      if (!prev || r.avg > prev.avg) best.set(r.hostid || r.itemid, r);
    }
    return {
      key,
      label,
      rows: [...best.values()].sort((a, b) => b.avg - a.avg).slice(0, top),
    };
  });

  metrics.push(await interfaceUtilisation(from, to, top));
  return { days, metrics };
}

/**
 * Busiest network interfaces, as a share of their link speed. The estate has
 * thousands of interfaces, so they are preselected on their latest rate and
 * only the top candidates' trends are read.
 */
async function interfaceUtilisation(
  from: number,
  to: number,
  top: number,
): Promise<{ key: string; label: string; rows: CapacityRow[] }> {
  const label = 'Interface utilisation (busiest direction)';
  type ZIf = { itemid: string; key_: string; name: string; lastvalue: string; units?: string; hosts?: { hostid: string; name: string }[] };
  const read = (prefix: string) =>
    zbx<ZIf[]>('item.get', {
      output: ['itemid', 'key_', 'name', 'lastvalue', 'units'],
      search: { key_: prefix },
      startSearch: true,
      monitored: true,
      selectHosts: ['hostid', 'name'],
    });
  const [ins, outs, speeds] = await Promise.all([read('net.if.in['), read('net.if.out['), read('net.if.speed[')]);

  const index = (k: string) => /\.(\d+)\]$/.exec(k)?.[1];
  const hostOf = (i: ZIf) => i.hosts?.[0]?.hostid ?? '';
  const speedOf = new Map(speeds.map((s) => [`${hostOf(s)}:${index(s.key_)}`, Number(s.lastvalue)]));
  const outOf = new Map(outs.map((o) => [`${hostOf(o)}:${index(o.key_)}`, o]));

  // Errors and discards share the prefix; only octet counters are traffic.
  const traffic = ins.filter((i) => /octets/i.test(i.key_) && index(i.key_));
  const candidates = traffic
    .map((i) => {
      const id = `${hostOf(i)}:${index(i.key_)}`;
      const speed = speedOf.get(id) ?? 0;
      const out = outOf.get(id);
      const latest = Math.max(Number(i.lastvalue) || 0, Number(out?.lastvalue) || 0);
      return { in: i, out, speed, latest: speed > 0 ? latest / speed : 0 };
    })
    .filter((c) => c.speed > 0 && c.latest > 0)
    .sort((a, b) => b.latest - a.latest)
    .slice(0, Math.max(top * 4, 40));
  if (!candidates.length) return { key: 'ifutil', label, rows: [] };

  const itemids = candidates.flatMap((c) => [c.in.itemid, ...(c.out ? [c.out.itemid] : [])]);
  // Up to 400 items: sliced, and folded as the rows arrive.
  const agg: Aggregates = new Map();
  let trendRows = 0;
  await fetchTrendsSliced<{ itemid: string; value_avg: string; value_max: string }>(
    itemids,
    from,
    to,
    ['itemid', 'value_avg', 'value_max'],
    {
      parallel: config.sla.maxParallel,
      onRows: (rows) => {
        trendRows += rows.length;
        for (const r of rows) {
          const a = agg.get(r.itemid) ?? { sum: 0, n: 0, max: 0 };
          a.sum += Number(r.value_avg);
          a.n++;
          a.max = Math.max(a.max, Number(r.value_max));
          agg.set(r.itemid, a);
        }
      },
    },
  );
  const pct = (itemid: string | undefined, speed: number, pick: 'avg' | 'max') => {
    const a = itemid ? agg.get(itemid) : undefined;
    if (!a || !a.n) return 0;
    return ((pick === 'avg' ? a.sum / a.n : a.max) / speed) * 100;
  };

  const rows: CapacityRow[] = candidates
    .map((c) => {
      const host = c.in.hosts?.[0];
      const port = /^Interface\s+([^(:]+)/.exec(c.in.name)?.[1]?.trim() ?? c.in.name;
      return {
        metric: 'ifutil',
        label,
        itemid: c.in.itemid,
        hostid: host?.hostid ?? '',
        host: host?.name ?? '',
        name: port,
        units: '%',
        avg: Math.max(pct(c.in.itemid, c.speed, 'avg'), pct(c.out?.itemid, c.speed, 'avg')),
        max: Math.min(100, Math.max(pct(c.in.itemid, c.speed, 'max'), pct(c.out?.itemid, c.speed, 'max'))),
        source: trendRows ? ('trend' as const) : ('none' as const),
      };
    })
    .filter((r) => r.source === 'trend')
    .sort((a, b) => b.avg - a.avg)
    .slice(0, top);
  return { key: 'ifutil', label, rows };
}


/** Cache lifetimes of the slow reports below. */
const REPORT_TTL = 120_000;
const CAPACITY_TTL = 300_000;
/**
 * Past its TTL a slow report is answered at once from the previous run for as
 * long again while one refresh runs, and a failed refresh answers with that
 * run too (cache.ts). Only for reports over days of history, never for
 * `aging` or anything else showing live problem state.
 */
const staleReport = (ttlMs: number) => ({ staleMs: ttlMs, staleIfError: true });

export async function analyticsRoutes(app: FastifyInstance): Promise<void> {
  // intParam, not Math.min/Math.max around Number(): `days=abc` is NaN, NaN
  // survives both clamps, and a NaN `time_from` removes the time bound entirely.
  //   ?basis=availability (default) &profile=&month=YYYY-MM | &days=
  //   ?basis=all-problems &severity= &month=YYYY-MM | &days=   the original any-problem report
  app.get('/api/reports/availability', (req) => {
    const q = req.query as { days?: string; severity?: string; month?: string; profile?: string; basis?: string };
    const days = intParam(q.days, 7, 1, 365);
    const minSeverity = intParam(q.severity, config.reports.availabilityMinSeverity, 0, 5);
    if (q.basis && q.basis !== 'availability' && q.basis !== 'all-problems') {
      throw new BadRequestError('basis must be "availability" or "all-problems".');
    }
    // Before the basis branch: the any-problem report used to ignore `month`
    // and quietly answer for the last 7 days instead.
    const month = q.month ? parseMonth(q.month) : undefined;
    if (q.basis === 'all-problems') {
      if (!month) {
        return cached(
          `avail:all:${days}:${minSeverity}`,
          REPORT_TTL,
          () => getAvailability(days, minSeverity),
          staleReport(REPORT_TTL),
        );
      }
      monthWindow(month); // a month not started yet, or past event retention: 400 here, not inside the cache
      return cached(
        `avail:all:${month}:${minSeverity}`,
        REPORT_TTL,
        () => getAvailability(days, minSeverity, month),
        staleReport(REPORT_TTL),
      );
    }
    const profile = parseProfile(q.profile);
    // A month is cached by the engine itself; a rolling window moves with now.
    if (month) return getDerivedAvailability({ days, month, profile, minSeverity });
    return cached(
      `avail:${profile}:${days}`,
      REPORT_TTL,
      () => getDerivedAvailability({ days, profile, minSeverity }),
      staleReport(REPORT_TTL),
    );
  });

  //   ?days=&severity=&top=   top: triggers sent, loudest first (default 100, 1–1000)
  app.get('/api/reports/noise', async (req) => {
    const q = req.query as { days?: string; severity?: string; top?: string };
    const days = intParam(q.days, 7, 1, 365);
    const minSeverity = intParam(q.severity, 0, 0, 5);
    const top = intParam(q.top, 100, 1, 1000);
    // The full report is cached once; `top` only cuts what is sent.
    const report = await cached(
      `noise:${days}:${minSeverity}`,
      REPORT_TTL,
      () => getNoise(days, minSeverity),
      staleReport(REPORT_TTL),
    );
    return topNoise(report, top);
  });

  app.get('/api/reports/aging', () => cached('aging', 15_000, getAging));

  app.get('/api/reports/capacity', (req) => {
    const q = req.query as { days?: string; top?: string };
    const days = intParam(q.days, 7, 1, 365);
    const top = intParam(q.top, 10, 1, 50);
    return cached(`capacity:${days}:${top}`, CAPACITY_TTL, () => getCapacity(days, top), staleReport(CAPACITY_TTL));
  });
}
