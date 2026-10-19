import type {
  AgingReport,
  AvailabilityReport,
  CapacityReport,
  CapacityRow,
  DerivedServiceNode,
  DerivedServicesResponse,
  Dimension,
  Freshness,
  GraphResponse,
  GraphSeries,
  GroupProblems,
  Device,
  DevicesResponse,
  Host,
  HostAvailability,
  HostGap,
  HostGroup,
  HostInterface,
  HostOverview,
  Item,
  LatestItem,
  LatestResponse,
  Link,
  LinksResponse,
  MapDetail,
  MapLink,
  MapSelement,
  Me,
  Meter,
  MeterOther,
  TopHostRow,
  TopHostsMetric,
  TopHostsResponse,
  WebFailure,
  WebMonitoringResponse,
  MeterZone,
  MetersResponse,
  NetDevice,
  NetInterface,
  NetInterfacesResponse,
  NoiseReport,
  NoisyTrigger,
  Problem,
  ScorecardResponse,
  ServiceNode,
  ServiceSla,
  ServicesResponse,
  Site,
  SiteHost,
  SiteRef,
  SitesResponse,
  Sla,
  SlaSli,
  SlaSource,
  SliGap,
  SliGroup,
  SliHost,
  SliPath,
  SliReport,
  SliWeb,
  Stats,
  TopTrigger,
  TopTriggersReport,
  ZMap,
} from './types';

/**
 * A hand-written check that an answer from the BFF has the shape a page relies on. The
 * shapes stay in types.ts, the one source: each shape below is typed `Shape<T>`, which makes the
 * compiler ask for every field of T, so a field added to or dropped from a type is a build error
 * here and not a blank page in the browser.
 *
 * What is checked is the type's own claim: a required field is there and has the right kind, an
 * optional one has the right kind when it is there, and an object may carry more than it names. The
 * values behind a union such as `HostState` are not checked, only that they are text, so a state
 * a newer BFF adds reads as no state instead of failing the page.
 */

/** Where an answer goes wrong, and how: `path` is empty at the value itself. */
interface Misfit {
  path: string;
  why: string;
}
type Check = (value: unknown) => Misfit | null;
type Shape<T> = { [K in keyof T]-?: Check };

const bad = (value: unknown, kind: string): Misfit => ({ path: '', why: value === undefined ? 'is missing' : `is not ${kind}` });
const join = (head: string, rest: string) => (rest === '' ? head : head === '' ? rest : rest.startsWith('[') ? head + rest : `${head}.${rest}`);
const under = (head: string, m: Misfit): Misfit => ({ path: join(head, m.path), why: m.why });
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const text: Check = (v) => (typeof v === 'string' ? null : bad(v, 'text'));
const num: Check = (v) => (typeof v === 'number' && Number.isFinite(v) ? null : bad(v, 'a number'));
const flag: Check = (v) => (typeof v === 'boolean' ? null : bad(v, 'true or false'));
/** A key that may be left out (JSON has no undefined, so left out is all it can be). */
const opt =
  (check: Check): Check =>
  (v) =>
    v === undefined ? null : check(v);
const orNull =
  (check: Check): Check =>
  (v) =>
    v === null ? null : check(v);

const listOf =
  (item: Check): Check =>
  (v) => {
    if (!Array.isArray(v)) return bad(v, 'a list');
    for (let i = 0; i < v.length; i++) {
      const m = item(v[i]);
      if (m) return under(`[${i}]`, m);
    }
    return null;
  };

/** An object whose every value passes `value`, under keys of any name ("severity" -> count). */
const recordOf =
  (value: Check): Check =>
  (v) => {
    if (!isObject(v)) return bad(v, 'an object');
    for (const [k, inner] of Object.entries(v)) {
      const m = value(inner);
      if (m) return under(k, m);
    }
    return null;
  };

const shape =
  <T>(fields: Shape<T>): Check =>
  (v) => {
    if (!isObject(v)) return bad(v, 'an object');
    for (const [key, check] of Object.entries<Check>(fields)) {
      const m = check(v[key]);
      if (m) return under(key, m);
    }
    return null;
  };

/** A checked kind of answer: what it is called to a person, and how to tell whether a value is one. */
export interface Guard<T> {
  /** For a sentence a person reads: "the problem list". */
  what: string;
  /** Null when `value` fits; otherwise the first thing wrong, for a log (never shown to a person). `T` is for the compiler only. */
  misfit: (value: unknown) => string | null;
  readonly _type?: T;
}

function guard<T>(what: string, check: Check): Guard<T> {
  return {
    what,
    misfit: (value) => {
      const m = check(value);
      return m ? `${m.path || 'the answer'} ${m.why}` : null;
    },
  };
}

const tag = shape<{ tag: string; value: string }>({ tag: text, value: text });

const problem = shape<Problem>({
  eventid: text,
  objectid: text,
  object: text,
  name: text,
  severity: text,
  clock: text,
  r_eventid: opt(text),
  r_clock: opt(text),
  acknowledged: text,
  suppressed: opt(text),
  opdata: opt(text),
  tags: opt(listOf(tag)),
  host: opt(text),
  hostid: opt(text),
  manualClose: opt(flag),
});

const hostInterface = shape<HostInterface>({ ip: text, type: opt(text), available: opt(text) });
const siteRef = shape<SiteRef>({ code: num, name: text });
const counts = recordOf(num);

/** The fields of `Host`, which HostOverview and NetDevice extend. */
const hostFields: Shape<Host> = {
  hostid: text,
  name: text,
  status: text,
  maintenance_status: opt(text),
  interfaces: opt(listOf(hostInterface)),
  site: opt(orNull(siteRef)),
};
const host = shape<Host>(hostFields);

const hostOverview = shape<HostOverview>({
  ...hostFields,
  problems: shape<HostOverview['problems']>({ total: num, bySeverity: counts }),
  state: opt(text),
  reason: opt(text),
});

const device = shape<Device>({
  ...hostFields,
  problems: shape<HostOverview['problems']>({ total: num, bySeverity: counts }),
  state: opt(text),
  reason: opt(text),
  site: orNull(siteRef),
  class: text,
  category: text,
});
const devices = shape<DevicesResponse>({
  classes: listOf(shape<DevicesResponse['classes'][number]>({ key: text, label: text })),
  devices: listOf(device),
});

const stats = shape<Stats>({
  hosts: num,
  items: num,
  triggers: num,
  groups: num,
  problems: num,
  unacknowledged: num,
  bySeverity: counts,
});

const freshness = shape<Freshness>({
  lastCollectedAt: orNull(num),
  ageSeconds: orNull(num),
  stale: flag,
  staleAfterSeconds: num,
});

const groupProblems = shape<GroupProblems>({ groupid: text, name: text, total: num, bySeverity: counts });

const me = shape<Me>({
  authEnabled: flag,
  user: orNull(shape<NonNullable<Me['user']>>({ name: text, role: text })),
  expiresIn: opt(orNull(num)),
  pages: opt(recordOf(text)),
});

const hostGroup = shape<HostGroup>({ groupid: text, name: text });

const itemFields: Shape<Item> = {
  itemid: text,
  name: text,
  key_: text,
  value_type: text,
  units: opt(text),
  lastvalue: opt(text),
  lastclock: opt(text),
  state: opt(text),
  status: opt(text),
  delay: opt(text),
  flags: opt(text),
  tags: opt(listOf(tag)),
  hosts: opt(listOf(shape<{ hostid: string; name: string }>({ hostid: text, name: text }))),
};
const item = shape<Item>(itemFields);
const latestItem = shape<LatestItem>({ ...itemFields, prevvalue: opt(text) });
const latest = shape<LatestResponse>({
  items: listOf(latestItem),
  truncated: flag,
  total: opt(num),
  page: opt(num),
  pageSize: opt(num),
});

/**
 * A graph series holds up to 3,000 points, so only the first and the last are looked at: that
 * tells a list of [time, avg, min, max] from anything else without walking every one.
 */
const points: Check = (v) => {
  if (!Array.isArray(v)) return bad(v, 'a list');
  for (const i of v.length === 0 ? [] : [0, v.length - 1]) {
    const p = v[i];
    if (!Array.isArray(p) || p.length !== 4 || typeof p[0] !== 'number') return under(`[${i}]`, { path: '', why: 'is not a [time, average, min, max] point' });
  }
  return null;
};
const graphSeries = shape<GraphSeries>({
  itemid: text,
  name: text,
  host: text,
  units: text,
  value_type: text,
  delaySeconds: num,
  step: flag,
  points,
  stats: orNull(shape<NonNullable<GraphSeries['stats']>>({ min: num, avg: num, max: num, last: num, lastClock: num })),
  coverage: shape<GraphSeries['coverage']>({ coveredSeconds: num, firstClock: orNull(num), lastClock: orNull(num) }),
});
const graph = shape<GraphResponse>({
  from: num,
  to: num,
  source: text,
  series: listOf(graphSeries),
  latestClock: orNull(num),
  downsampled: flag,
});

const netDevice = shape<NetDevice>({
  ...hostFields,
  icmp: orNull(shape<NonNullable<NetDevice['icmp']>>({ up: opt(flag), loss: opt(num), latency: opt(num), state: opt(text) })),
});
const netInterface = shape<NetInterface>({
  index: num,
  name: text,
  alias: text,
  operStatus: text,
  speed: orNull(num),
  inBps: orNull(num),
  outBps: orNull(num),
  utilisation: orNull(num),
  inErrors: orNull(num),
  outErrors: orNull(num),
  inDiscards: orNull(num),
  outDiscards: orNull(num),
  lastclock: orNull(num),
  itemids: recordOf(text),
});
const netInterfaces = shape<NetInterfacesResponse>({
  rows: listOf(netInterface),
  total: num,
  summary: shape<NetInterfacesResponse['summary']>({ up: num, down: num, other: num }),
  page: num,
  pageSize: num,
});

const topTrigger = shape<TopTrigger>({ objectid: text, name: text, severity: text, host: text, count: num });
const topTriggers = shape<TopTriggersReport>({ triggers: listOf(topTrigger), truncated: flag, days: num });

const zmapFields: Shape<ZMap> = { sysmapid: text, name: text, width: text, height: text };
const zmap = shape<ZMap>(zmapFields);
const mapSelement = shape<MapSelement>({
  selementid: text,
  label: text,
  x: text,
  y: text,
  elementtype: text,
  labelText: opt(text),
  hostid: opt(text),
  hostName: opt(text),
  problems: opt(num),
  maxSeverity: opt(num),
});
const mapLink = shape<MapLink>({ linkid: text, selementid1: text, selementid2: text, color: opt(text) });
const mapDetail = shape<MapDetail>({ ...zmapFields, selements: listOf(mapSelement), links: listOf(mapLink) });

const siteHost = shape<SiteHost>({
  hostid: text,
  name: text,
  status: text,
  maintenance_status: opt(text),
  interfaces: opt(listOf(hostInterface)),
  availability: text,
  state: opt(text),
  reason: opt(text),
  siteSource: text,
  problems: shape<SiteHost['problems']>({ total: num, bySeverity: counts }),
});
const site = shape<Site>({
  name: text,
  total: num,
  available: num,
  unavailable: num,
  unknown: num,
  up: opt(num),
  down: opt(num),
  degraded: opt(num),
  nodata: opt(num),
  maintenance: num,
  disabled: num,
  problems: num,
  unacknowledged: num,
  bySeverity: counts,
  worst: num,
  hosts: listOf(siteHost),
});
const sites = shape<SitesResponse>({
  sites: listOf(site),
  coverage: shape<SitesResponse['coverage']>({ hosts: num, tag: num, name: opt(num), inventory: num, group: num }),
});

const dimension = shape<Dimension>({ key: text, label: text, hint: text, present: num, total: num, pct: num, scored: flag });
const hostGap = shape<HostGap>({ hostid: text, name: text, site: text, groups: listOf(text), missing: listOf(text) });
const scorecard = shape<ScorecardResponse>({
  dimensions: listOf(dimension),
  overall: shape<ScorecardResponse['overall']>({ hosts: num, complete: num, pct: num }),
  groups: listOf(shape<ScorecardResponse['groups'][number]>({ name: text, hosts: num, complete: num, pct: num })),
  gaps: listOf(hostGap),
});

const link = shape<Link>({
  id: text,
  hostid: text,
  host: text,
  target: text,
  label: text,
  up: opt(flag),
  loss: opt(num),
  latency: opt(num),
  jitter: opt(num),
  state: text,
  group: opt(text),
  role: opt(text),
  lastclock: opt(text),
});
const links = shape<LinksResponse>({
  links: listOf(link),
  paths: listOf(shape<LinksResponse['paths'][number]>({ name: text, links: listOf(link), state: text })),
  summary: shape<LinksResponse['summary']>({ total: num, up: num, degraded: num, down: num, unknown: num }),
  thresholds: shape<LinksResponse['thresholds']>({ lossWarn: num, lossCrit: num }),
});

const meterZone = shape<MeterZone>({ from: num, level: text });
const meterOther = shape<MeterOther>({
  direction: text,
  itemid: text,
  value: orNull(num),
  clock: orNull(num),
  fraction: orNull(num),
  zone: orNull(text),
});
const meter = shape<Meter>({
  id: text,
  title: text,
  page: text,
  host: orNull(text),
  hostid: orNull(text),
  item: orNull(text),
  itemid: orNull(text),
  direction: orNull(text),
  link: text,
  other: orNull(meterOther),
  units: text,
  value: orNull(num),
  clock: orNull(num),
  min: num,
  max: orNull(num),
  zones: listOf(meterZone),
  fraction: orNull(num),
  zone: orNull(text),
  state: text,
});
const meters = shape<MetersResponse>({
  dashboard: text,
  found: flag,
  generatedAt: num,
  meters: listOf(meter),
  summary: shape<MetersResponse['summary']>({
    total: num,
    current: num,
    critical: num,
    warn: num,
    stale: num,
    unavailable: num,
    down: num,
    otherHigh: num,
  }),
});

const topHostRow = shape<TopHostRow>({ hostid: text, host: text, itemid: text, value: num, clock: num });
const topHosts = shape<TopHostsResponse>({
  generatedAt: num,
  metrics: listOf(shape<TopHostsMetric>({ key: text, label: text, considered: num, current: num, rows: listOf(topHostRow) })),
});

const webFailure = shape<WebFailure>({ hostid: text, host: text, name: text, itemid: text, step: num, clock: num });
const webMonitoring = shape<WebMonitoringResponse>({
  generatedAt: num,
  total: num,
  ok: num,
  failed: num,
  unknown: num,
  failures: listOf(webFailure),
});

const sliGroup = shape<SliGroup>({
  key: text,
  name: text,
  hosts: num,
  withData: num,
  sli: orNull(num),
  downtime: num,
  meeting: orNull(flag),
  belowTarget: num,
});
const sliGap = shape<SliGap>({ from: num, to: num });
const hostAvailability = shape<HostAvailability>({
  hostid: text,
  host: text,
  availability: orNull(num),
  downtime: num,
  incidents: num,
  longest: num,
  coverage: opt(num),
  dataStatus: opt(text),
  category: opt(text),
  site: opt(orNull(siteRef)),
});
const availability = shape<AvailabilityReport>({
  from: num,
  to: num,
  windowSeconds: num,
  minSeverity: num,
  hosts: listOf(hostAvailability),
  truncated: flag,
  basis: opt(text),
  profile: opt(text),
  month: opt(orNull(text)),
  target: opt(num),
  overall: opt(sliGroup),
  categories: opt(listOf(sliGroup)),
  sites: opt(listOf(sliGroup)),
  gaps: opt(listOf(sliGap)),
});

const aging = shape<AgingReport>({
  buckets: listOf(shape<AgingReport['buckets'][number]>({ label: text, count: num })),
  unacknowledged: num,
  total: num,
  oldest: listOf(shape<AgingReport['oldest'][number]>({ eventid: text, name: text, host: text, severity: text, clock: text, ageSeconds: num })),
});

const capacityRow = shape<CapacityRow>({
  metric: text,
  label: text,
  itemid: text,
  hostid: text,
  host: text,
  name: text,
  units: text,
  avg: num,
  max: num,
  source: text,
});
const capacity = shape<CapacityReport>({
  days: num,
  metrics: listOf(shape<CapacityReport['metrics'][number]>({ key: text, label: text, rows: listOf(capacityRow) })),
});

const noisyTrigger = shape<NoisyTrigger>({
  objectid: text,
  name: text,
  host: text,
  hostid: text,
  severity: text,
  count: num,
  medianDuration: num,
  shortLived: num,
  ackRate: num,
  totalDuration: num,
  longest: num,
  stillOpen: flag,
  flags: listOf(text),
});
const noise = shape<NoiseReport>({
  from: num,
  to: num,
  windowSeconds: num,
  minSeverity: num,
  truncated: flag,
  totalEvents: num,
  distinctTriggers: num,
  concentration: shape<NoiseReport['concentration']>({ topN: num, percentOfEvents: num }),
  counts: counts,
  thresholds: shape<NoiseReport['thresholds']>({ shortSeconds: num, minCount: num }),
  total: opt(num),
  triggers: listOf(noisyTrigger),
});

/** A service tree is as deep as the estate's groups, so a node names its children through this. */
const lazy =
  (get: () => Check): Check =>
  (v) =>
    get()(v);
const serviceSla = shape<ServiceSla>({ slaid: text, name: text, slo: num, sli: num, errorBudget: num, meeting: flag });
const serviceFields: Shape<ServiceNode> = {
  serviceid: text,
  name: text,
  status: num,
  algorithm: text,
  description: opt(text),
  tags: listOf(tag),
  problems: listOf(shape<ServiceNode['problems'][number]>({ eventid: text, name: text, severity: text })),
  sla: opt(serviceSla),
  children: listOf(lazy(() => serviceNode)),
  worst: num,
  descendants: num,
};
const serviceNode: Check = shape<ServiceNode>(serviceFields);
const services = shape<ServicesResponse>({ tree: listOf(serviceNode), total: num, degraded: num, worst: num });

const derivedNode: Check = shape<DerivedServiceNode>({
  ...serviceFields,
  kind: text,
  hostid: opt(text),
  dataStatus: text,
  coverage: orNull(num),
  children: listOf(lazy(() => derivedNode)),
});
const derivedServices = shape<DerivedServicesResponse>({
  tree: listOf(derivedNode),
  total: num,
  degraded: num,
  worst: num,
  source: text,
  label: text,
  month: text,
  profile: text,
  target: num,
  closed: flag,
  gaps: listOf(sliGap),
});

const sliHost = shape<SliHost>({
  hostid: text,
  name: text,
  hostStatus: text,
  site: orNull(siteRef),
  category: text,
  deviceClass: text,
  triggerids: listOf(text),
  sli: orNull(num),
  downtime: num,
  window: num,
  covered: num,
  maintenance: num,
  coverage: num,
  incidents: num,
  longest: num,
  dataStatus: text,
  measured: opt(flag),
  meeting: orNull(flag),
  errorBudget: orNull(num),
});
const sliPath = shape<SliPath>({
  key: text,
  name: text,
  site: orNull(siteRef),
  legs: listOf(shape<SliPath['legs'][number]>({ hostid: text, name: text, leg: text, sli: orNull(num), dataStatus: text })),
  sli: orNull(num),
  downtime: num,
  coverage: num,
  dataStatus: text,
});
const sliWeb = shape<SliWeb>({ itemid: text, name: text, sli: orNull(num), downtime: num, coverage: num, dataStatus: text });
const sli = shape<SliReport>({
  source: text,
  label: text,
  profile: text,
  month: orNull(text),
  from: num,
  to: num,
  end: num,
  closed: flag,
  timezone: text,
  target: num,
  basis: shape<SliReport['basis']>({ triggers: listOf(text), gapPolicy: text, noDataPolicy: text, maintenancePolicy: text }),
  overall: sliGroup,
  categories: listOf(sliGroup),
  sites: listOf(sliGroup),
  classes: listOf(sliGroup),
  hosts: listOf(sliHost),
  wanPaths: listOf(sliPath),
  web: listOf(sliWeb),
  gaps: listOf(sliGap),
  stats: shape<SliReport['stats']>({ zabbixCalls: num, triggers: num, events: num, trendRows: num, ms: num }),
  generatedAt: num,
});

const slaSource = shape<SlaSource>({ real: flag, slas: num, services: num });
const sla = shape<Sla>({ slaid: text, name: text, slo: text, period: text, status: text, timezone: opt(text), description: opt(text) });
const slaSli = shape<SlaSli>({ serviceid: text, name: text, sli: num, uptime: num, downtime: num, error_budget: num, period_from: num, period_to: num });

/** GET /api/problems, and each `problems` frame of the live stream. */
export const problemListGuard = guard<Problem[]>('the problem list', listOf(problem));
/** GET /api/hosts/overview. */
export const hostOverviewGuard = guard<HostOverview[]>('the host list', listOf(hostOverview));
/** GET /api/devices. */
export const devicesGuard = guard<DevicesResponse>('the device list', devices);
/** GET /api/stats. */
export const statsGuard = guard<Stats>('the dashboard counts', stats);
/** GET /api/reports/problems-by-group. */
export const groupProblemsGuard = guard<GroupProblems[]>('the problems by host group', listOf(groupProblems));
/** GET /api/freshness. */
export const freshnessGuard = guard<Freshness>('the data freshness', freshness);
/** GET /api/auth/me. */
export const meGuard = guard<Me>('your sign-in details', me);
/** GET /api/hosts. */
export const hostListGuard = guard<Host[]>('the host list', listOf(host));
/** GET /api/hostgroups. */
export const hostGroupListGuard = guard<HostGroup[]>('the host groups', listOf(hostGroup));
/** GET /api/items, by host or by id. */
export const itemListGuard = guard<Item[]>('the item list', listOf(item));
/** GET /api/latest. */
export const latestGuard = guard<LatestResponse>('the latest data', latest);
/** GET /api/graph. */
export const graphGuard = guard<GraphResponse>('the graph', graph);
/** GET /api/net/devices. */
export const netDevicesGuard = guard<NetDevice[]>('the network devices', listOf(netDevice));
/** GET /api/net/interfaces. */
export const netInterfacesGuard = guard<NetInterfacesResponse>('the interface list', netInterfaces);
/** GET /api/reports/top-triggers. */
export const topTriggersGuard = guard<TopTriggersReport>('the top triggers', topTriggers);
/** GET /api/maps. */
export const mapListGuard = guard<ZMap[]>('the map list', listOf(zmap));
/** GET /api/maps/detail. */
export const mapDetailGuard = guard<MapDetail[]>('the map', listOf(mapDetail));
/** GET /api/sites. */
export const sitesGuard = guard<SitesResponse>('the site list', sites);
/** GET /api/reports/inventory. */
export const scorecardGuard = guard<ScorecardResponse>('the inventory scorecard', scorecard);
/** GET /api/links. */
export const linksGuard = guard<LinksResponse>('the link health', links);
/** GET /api/net/meters. */
export const metersGuard = guard<MetersResponse>('the internet traffic meters', meters);
/** GET /api/reports/top-hosts. */
export const topHostsGuard = guard<TopHostsResponse>('the busiest hosts', topHosts);
/** GET /api/reports/web-monitoring. */
export const webMonitoringGuard = guard<WebMonitoringResponse>('web monitoring', webMonitoring);
/** GET /api/reports/availability, either basis. */
export const availabilityGuard = guard<AvailabilityReport>('the availability report', availability);
/** GET /api/reports/aging. */
export const agingGuard = guard<AgingReport>('the problem ageing', aging);
/** GET /api/reports/capacity. */
export const capacityGuard = guard<CapacityReport>('the capacity report', capacity);
/** GET /api/reports/noise. */
export const noiseGuard = guard<NoiseReport>('the alert noise report', noise);
/** GET /api/services. */
export const servicesGuard = guard<ServicesResponse>('the service tree', services);
/** GET /api/services/derived. */
export const derivedServicesGuard = guard<DerivedServicesResponse>('the service tree', derivedServices);
/** GET /api/sli. */
export const sliGuard = guard<SliReport>('the SLA report', sli);
/** GET /api/sla/source. */
export const slaSourceGuard = guard<SlaSource>('the SLA source', slaSource);
/** GET /api/sla. */
export const slaListGuard = guard<Sla[]>('the SLA list', listOf(sla));
/** GET /api/sla/sli. */
export const slaSliGuard = guard<SlaSli[]>('the SLA figures', listOf(slaSli));

/**
 * What a person reads when an answer fails its check. Plain words: the detail goes to the console, not to the page.
 * It must not say "Zabbix": the error state would then add its hint about reaching Zabbix, which is not the fault.
 */
export const unreadableMessage = (what: string) =>
  `The portal sent back ${what} in a form this page cannot read. Try again in a minute, or tell the portal admin.`;

/** The error for an answer that failed its check; `detail` is the first thing wrong, for a log. */
export class UnreadableAnswer extends Error {
  constructor(
    readonly path: string,
    what: string,
    readonly detail: string,
  ) {
    super(unreadableMessage(what));
    this.name = 'UnreadableAnswer';
  }
}

const told = new Set<string>();
/** A bad answer repeats on every poll: say what was wrong once, in the console, for whoever opens it. */
export function noteMisfit(source: string, detail: string): void {
  const line = `${source}: ${detail}`;
  // Capped, so a list that differs at every row cannot fill the console or grow this set for ever.
  if (told.has(line) || told.size >= 50) return;
  told.add(line);
  console.warn(`The portal's answer did not match what the page expects. ${line}`);
}

/** `body` itself when it fits `guard`; otherwise an UnreadableAnswer, which the page shows as its ordinary error. */
export function assertFits<T>(guard: Guard<T>, body: unknown, path: string): T {
  const detail = guard.misfit(body);
  if (detail === null) return body as T;
  noteMisfit(path, detail);
  throw new UnreadableAnswer(path, guard.what, detail);
}
