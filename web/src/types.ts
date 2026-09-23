export interface HostInterface {
  ip: string;
  type?: string; // '1' agent, '2' SNMP, '3' IPMI, '4' JMX
  available?: string; // '0' unknown, '1' available, '2' unavailable
}

export interface Host {
  hostid: string;
  name: string;
  status: string; // '0' = monitored, '1' = not monitored
  maintenance_status?: string; // '1' = in maintenance
  interfaces?: HostInterface[];
  /** Site read from the host name (server naming.ts); null when the name doesn't say. */
  site?: SiteRef | null;
}

export interface SiteRef {
  code: number;
  name: string;
}

/** One reachability state per host, ping first (server reachability.ts). */
export type HostState = 'up' | 'down' | 'degraded' | 'nodata' | 'disabled';

/** Where a host's state came from. `snmp-silent`/`agent-silent`: answers ping, but that interface does not. */
export type StateReason =
  | 'ping'
  | 'interface'
  | 'snmp-silent'
  | 'agent-silent'
  | 'stale'
  | 'no-interface'
  | 'unsupported'
  | 'disabled';

export interface HostOverview extends Host {
  problems: { total: number; bySeverity: Record<string, number> };
  state?: HostState;
  reason?: StateReason;
}

export interface HostGroup {
  groupid: string;
  name: string;
}

export interface Problem {
  eventid: string;
  objectid: string;
  object: string;
  name: string;
  severity: string; // '0'..'5'
  clock: string;
  r_eventid?: string; // '0' when still open
  r_clock?: string;
  acknowledged: string; // '0' | '1'
  suppressed?: string;
  opdata?: string;
  tags?: { tag: string; value: string }[];
  host?: string;
  hostid?: string;
  /** Whether the trigger permits manual close, gates the Close option (§20). */
  manualClose?: boolean;
}

export interface Item {
  itemid: string;
  name: string;
  key_: string;
  value_type: string; // '0' float, '1' char, '2' log, '3' uint, '4' text
  units?: string;
  lastvalue?: string;
  lastclock?: string;
  state?: string; // '0' normal, '1' not supported
  status?: string; // '0' enabled, '1' disabled
  delay?: string;
  flags?: string;
  tags?: { tag: string; value: string }[];
  hosts?: { hostid: string; name: string }[];
}

export interface LatestItem extends Item {
  lastclock?: string;
  prevvalue?: string;
  state?: string; // '0' normal, '1' not supported
  hosts?: { hostid: string; name: string }[];
}

export interface LatestResponse {
  items: LatestItem[];
  /** True when Zabbix returned a full page: the list is a floor, not the total. */
  truncated: boolean;
  /** Present when requested with `page`: total matches across all pages. */
  total?: number;
  page?: number;
  pageSize?: number;
}

// Graph pipeline (/api/graph)

/** [ms, avg, min, max], null avg marks a collection gap; min/max null for raw history. */
export type GraphPoint = [number, number | null, number | null, number | null];

export interface GraphSeries {
  itemid: string;
  name: string;
  host: string;
  units: string;
  value_type: string;
  delaySeconds: number;
  step: boolean;
  points: GraphPoint[];
  stats: { min: number; avg: number; max: number; last: number; lastClock: number } | null;
  coverage: { coveredSeconds: number; firstClock: number | null; lastClock: number | null };
}

export interface GraphResponse {
  from: number;
  to: number;
  source: 'history' | 'trend' | 'trend+history';
  series: GraphSeries[];
  latestClock: number | null;
  downsampled: boolean;
}

/** A graph window: a preset ending now, a calendar month, or a fixed from/to (epoch s). */
export type GraphRange =
  | { kind: 'hours'; hours: number }
  | { kind: 'month'; month: string }
  | { kind: 'custom'; from: number; to: number };

export type IcmpState = 'up' | 'down' | 'unknown';

export interface NetDevice extends Host {
  /** `up`/`loss`/`latency` only when a fresh value exists; null when the host has no ICMP items. */
  icmp: { up?: boolean; loss?: number; latency?: number; state?: IcmpState } | null;
}

export type OperStatus =
  | 'up'
  | 'down'
  | 'testing'
  | 'unknown'
  | 'dormant'
  | 'notPresent'
  | 'lowerLayerDown';

export interface NetInterface {
  index: number;
  name: string;
  alias: string;
  operStatus: OperStatus;
  speed: number | null;
  inBps: number | null;
  outBps: number | null;
  utilisation: number | null;
  inErrors: number | null;
  outErrors: number | null;
  inDiscards: number | null;
  outDiscards: number | null;
  lastclock: number | null;
  itemids: Partial<Record<'in' | 'out' | 'status' | 'speed' | 'inErrors' | 'outErrors', string>>;
}

export interface NetInterfacesResponse {
  rows: NetInterface[];
  total: number;
  summary: { up: number; down: number; other: number };
  page: number;
  pageSize: number;
}

export interface TopTrigger {
  objectid: string;
  name: string;
  severity: string;
  host: string;
  count: number;
}

export interface TopTriggersReport {
  triggers: TopTrigger[];
  /** True when the event window filled a page: the counts are a floor. */
  truncated: boolean;
  days: number;
}


export type Role = 'viewer' | 'operator' | 'admin';

export interface Me {
  authEnabled: boolean;
  user: { name: string; role: Role } | null;
}

// Inventory scorecard (Goal 1)

export type DimensionKey = 'naming' | 'site' | 'owner' | 'criticality';

export interface Dimension {
  key: DimensionKey;
  label: string;
  hint: string;
  present: number;
  total: number;
  pct: number;
  scored: boolean;
}

export interface HostGap {
  hostid: string;
  name: string;
  site: string;
  groups: string[];
  missing: DimensionKey[];
}

export interface ScorecardResponse {
  dimensions: Dimension[];
  overall: { hosts: number; complete: number; pct: number };
  groups: { name: string; hosts: number; complete: number; pct: number }[];
  gaps: HostGap[];
}

// Link & WAN health (Goal 3)

export type LinkState = 'up' | 'degraded' | 'down' | 'unknown';

export interface Link {
  id: string;
  hostid: string;
  host: string;
  target: string;
  label: string;
  up?: boolean;
  loss?: number;
  latency?: number;
  jitter?: number;
  state: LinkState;
  group?: string;
  role?: string;
  lastclock?: string;
}

export interface LinksResponse {
  links: Link[];
  paths: { name: string; links: Link[]; state: LinkState }[];
  summary: { total: number; up: number; degraded: number; down: number; unknown: number };
  thresholds: { lossWarn: number; lossCrit: number };
}

// Reports (Goal 6)

export interface HostAvailability {
  hostid: string;
  host: string;
  /** Percent; null = too little collected data to say (availability basis). */
  availability: number | null;
  downtime: number;
  incidents: number;
  longest: number;
  coverage?: number;
  dataStatus?: DataStatus;
  category?: string;
  site?: SiteRef | null;
}

export type AvailabilityBasis = 'availability' | 'all-problems';

export interface AvailabilityReport {
  from: number;
  to: number;
  windowSeconds: number;
  minSeverity: number;
  hosts: HostAvailability[];
  truncated: boolean;
  basis?: AvailabilityBasis;
  profile?: SliProfile;
  month?: string | null;
  target?: number;
  overall?: SliGroup;
  categories?: SliGroup[];
  sites?: SliGroup[];
  gaps?: SliGap[];
}

// Derived monthly SLA (/api/sli, server sli/engine.ts)

/** `availability` = strict (unreachable counts, gaps excluded); `hcml-report` = HCML's published method. */
export type SliProfile = 'availability' | 'hcml-report';

export type DataStatus = 'ok' | 'partial' | 'nodata';

export interface SliGap {
  from: number;
  to: number;
}

export interface SliHost {
  hostid: string;
  name: string;
  hostStatus: string;
  site: SiteRef | null;
  category: string;
  deviceClass: string;
  triggerids: string[];
  sli: number | null;
  downtime: number;
  window: number;
  covered: number;
  coverage: number;
  incidents: number;
  longest: number;
  dataStatus: DataStatus;
  /** False when the host's ICMP never collected; HCML's method still counts it as 100 %. */
  measured?: boolean;
  meeting: boolean | null;
  errorBudget: number | null;
}

export interface SliGroup {
  key: string;
  name: string;
  hosts: number;
  withData: number;
  sli: number | null;
  downtime: number;
  meeting: boolean | null;
  belowTarget: number;
}

export interface SliPath {
  key: string;
  name: string;
  site: SiteRef | null;
  legs: { hostid: string; name: string; leg: string; sli: number | null; dataStatus: DataStatus }[];
  sli: number | null;
  downtime: number;
  coverage: number;
  dataStatus: DataStatus;
}

export interface SliWeb {
  itemid: string;
  name: string;
  sli: number | null;
  downtime: number;
  coverage: number;
  dataStatus: DataStatus;
}

export interface SliReport {
  source: 'derived';
  label: string;
  profile: SliProfile;
  month: string | null;
  from: number;
  to: number;
  end: number;
  closed: boolean;
  timezone: string;
  target: number;
  basis: {
    triggers: string[];
    gapPolicy: 'counted-as-up' | 'excluded';
    noDataPolicy: 'counted-as-100' | 'excluded';
  };
  overall: SliGroup;
  categories: SliGroup[];
  sites: SliGroup[];
  classes: SliGroup[];
  hosts: SliHost[];
  wanPaths: SliPath[];
  web: SliWeb[];
  gaps: SliGap[];
  stats: { zabbixCalls: number; triggers: number; events: number; trendRows: number; ms: number };
  generatedAt: number;
}

export interface AgingReport {
  buckets: { label: string; count: number }[];
  unacknowledged: number;
  total: number;
  oldest: {
    eventid: string;
    name: string;
    host: string;
    severity: string;
    clock: string;
    ageSeconds: number;
  }[];
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
  source: 'trend' | 'history' | 'none';
}

/** `ifutil` rows are one interface each: `name` is the port, avg/max in %. */
export type CapacityMetricKey = 'cpu' | 'memory' | 'disk' | 'ifutil';

export interface CapacityReport {
  days: number;
  metrics: { key: CapacityMetricKey | (string & {}); label: string; rows: CapacityRow[] }[];
}

// Alert noise / flapping (Goal 4)

export type NoiseFlag = 'flapping' | 'unactioned' | 'chronic';

export interface NoisyTrigger {
  objectid: string;
  name: string;
  host: string;
  hostid: string;
  severity: string;
  count: number;
  /** Median, not mean: one long outlier must not hide many short firings. */
  medianDuration: number;
  shortLived: number;
  /** 0..1 */
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
  concentration: { topN: number; percentOfEvents: number };
  counts: Record<NoiseFlag, number>;
  thresholds: { shortSeconds: number; minCount: number };
  /** Triggers before `?top=` cut the list (default 100); the figures above cover all of them. */
  total?: number;
  triggers: NoisyTrigger[];
}

export interface Stats {
  hosts: number;
  items: number;
  triggers: number;
  groups: number;
  problems: number;
  unacknowledged: number;
  bySeverity: Record<string, number>;
}

export interface GroupProblems {
  groupid: string;
  name: string;
  total: number;
  bySeverity: Record<string, number>;
}

export interface ZMap {
  sysmapid: string;
  name: string;
  width: string;
  height: string;
}

export interface MapSelement {
  selementid: string;
  label: string;
  x: string;
  y: string;
  elementtype: string; // '0' host, '1' map, '2' trigger, '3' host group, '4' image
  /** Label with host macros expanded by the BFF ({HOSTNAME}, {HOST.IP}, …). */
  labelText?: string;
  /** Host elements only. */
  hostid?: string;
  hostName?: string;
  problems?: number;
  maxSeverity?: number; // -1 when the host has no open problem
}

export interface MapLink {
  linkid: string;
  selementid1: string;
  selementid2: string;
  color?: string; // hex without the '#', as Zabbix stores it
}

export interface MapDetail extends ZMap {
  selements: MapSelement[];
  links: MapLink[];
}


/** Where a host's site name came from, weakest last. */
export type SiteSource = 'tag' | 'name' | 'inventory' | 'group';

export interface SiteHost {
  hostid: string;
  name: string;
  status: string;
  maintenance_status?: string;
  interfaces?: HostInterface[];
  /** Interface flags alone; prefer `state`. */
  availability: 'available' | 'unavailable' | 'unknown';
  state?: HostState;
  reason?: StateReason;
  siteSource: SiteSource;
  problems: { total: number; bySeverity: Record<string, number> };
}

export interface Site {
  name: string;
  total: number;
  /** Hosts by interface flags. */
  available: number;
  unavailable: number;
  unknown: number;
  /** Hosts by `state`; disabled hosts count in `disabled` only. */
  up?: number;
  down?: number;
  degraded?: number;
  nodata?: number;
  maintenance: number;
  disabled: number;
  problems: number;
  unacknowledged: number;
  bySeverity: Record<string, number>;
  /** Highest severity currently firing at this site; -1 when clear. */
  worst: number;
  hosts: SiteHost[];
}

export interface SitesResponse {
  sites: Site[];
  coverage: { hosts: number; tag: number; name?: number; inventory: number; group: number };
}

// Services tree (Zabbix Services, read-only)

export interface ServiceSla {
  slaid: string;
  name: string;
  slo: number;
  sli: number;
  /** Seconds of downtime the period can still absorb; negative = SLO missed. */
  errorBudget: number;
  meeting: boolean;
}

export interface ServiceNode {
  serviceid: string;
  name: string;
  /** -1 = OK, otherwise the Zabbix severity that propagated up. */
  status: number;
  algorithm: string;
  description?: string;
  tags: { tag: string; value: string }[];
  /** The problems Zabbix blames for this service's state. */
  problems: { eventid: string; name: string; severity: string }[];
  sla?: ServiceSla;
  children: ServiceNode[];
  worst: number;
  descendants: number;
}

export interface ServicesResponse {
  tree: ServiceNode[];
  total: number;
  degraded: number;
  worst: number;
}

/** Services derived from the estate (server sli/tree.ts) when Zabbix has none. */
export type DerivedKind = 'root' | 'business' | 'site' | 'class' | 'wan-path' | 'host' | 'web';

export interface DerivedServiceNode extends ServiceNode {
  kind: DerivedKind;
  hostid?: string;
  dataStatus: DataStatus;
  coverage: number | null;
  children: DerivedServiceNode[];
}

export interface DerivedServicesResponse extends ServicesResponse {
  tree: DerivedServiceNode[];
  source: 'derived';
  label: string;
  month: string;
  profile: SliProfile;
  target: number;
  closed: boolean;
  gaps: SliGap[];
}

/** Whether Zabbix's own SLAs have anything to show (/api/sla/source). */
export interface SlaSource {
  real: boolean;
  slas: number;
  services: number;
}

// Services → SLA (Zabbix-native, read-only)

export interface Sla {
  slaid: string;
  name: string;
  slo: string; // promised availability target, e.g. '99.9'
  period: string; // '0' daily … '4' annually
  status: string; // '0' disabled, '1' enabled
  timezone?: string;
  description?: string;
}

export interface SlaSli {
  serviceid: string;
  name: string;
  sli: number; // achieved availability %
  uptime: number; // seconds
  downtime: number; // seconds
  error_budget: number; // seconds left before the SLO is missed (negative = missed)
  period_from: number;
  period_to: number;
}

// Plain-language layer (plan_1.1)

export interface ProblemExplanation {
  summary: string;
  tagsExplained: { tag: string; value: string; meaning: string }[];
  businessImpact: string;
  recommendation: string;
}

export interface SlaExplanation {
  status: string;
  plain: string;
  meetingTarget: boolean;
  recommendation: string;
  /** Nothing was measured, answered without the model; show a neutral pill. */
  noData?: boolean;
}

// Assistant (chat)

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** What the model was shown for an answer: the BFF's `context` frame. */
export interface ChatContext {
  generatedAt: number;
  hosts: number;
  sites: number;
  problems: number;
  unacknowledged: number;
  slas: number;
  degradedServices: number;
  /** The estate was too large to show in full; lists were cut. */
  truncated: boolean;
}

/** The BFF's `done` frame for an answer. */
export interface ChatDone {
  /** Model wall time. */
  ms: number;
  /** The cleaned-up answer (think blocks and sign-offs removed); replaces the streamed text. */
  text?: string;
  /** Wait for the first token; null when the model produced nothing. */
  firstTokenMs?: number | null;
}
