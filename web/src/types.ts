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
}

export interface HostOverview extends Host {
  problems: { total: number; bySeverity: Record<string, number> };
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
  /** Whether the trigger permits manual close — gates the Close option (§20). */
  manualClose?: boolean;
}

export interface Item {
  itemid: string;
  name: string;
  key_: string;
  value_type: string; // '0' float, '1' char, '2' log, '3' uint, '4' text
  units?: string;
  lastvalue?: string;
}

export interface LatestItem extends Item {
  lastclock?: string;
  prevvalue?: string;
  state?: string; // '0' normal, '1' not supported
  hosts?: { hostid: string; name: string }[];
}

export interface HistoryPoint {
  clock: string;
  value: string;
  itemid: string;
}

export interface NetDevice extends Host {
  icmp: { up?: boolean; loss?: number; latency?: number } | null;
}

export interface NetPort {
  itemid: string;
  name: string;
  key_: string;
  units?: string;
  lastvalue?: string;
  value_type?: string;
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
  /** True when the event window filled a page — the counts are a floor. */
  truncated: boolean;
  days: number;
}

/* ---------- RBAC ---------- */

export type Role = 'viewer' | 'operator' | 'admin';

export interface Me {
  authEnabled: boolean;
  user: { name: string; role: Role } | null;
}

/* ---------- Inventory scorecard (Goal 1) ---------- */

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

/* ---------- Link & WAN health (Goal 3) ---------- */

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

/* ---------- Reports (Goal 6) ---------- */

export interface HostAvailability {
  hostid: string;
  host: string;
  availability: number;
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
  truncated: boolean;
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

export interface CapacityReport {
  days: number;
  metrics: { key: string; label: string; rows: CapacityRow[] }[];
}

/* ---------- Alert noise / flapping (Goal 4) ---------- */

export type NoiseFlag = 'flapping' | 'unactioned' | 'chronic';

export interface NoisyTrigger {
  objectid: string;
  name: string;
  host: string;
  hostid: string;
  severity: string;
  count: number;
  /** Median, not mean — one long outlier must not hide many short firings. */
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
}

export interface MapLink {
  linkid: string;
  selementid1: string;
  selementid2: string;
}

export interface MapDetail extends ZMap {
  selements: MapSelement[];
  links: MapLink[];
}

/* ---------- Site view ---------- */

/** Where a host's site name came from — weakest last. */
export type SiteSource = 'tag' | 'inventory' | 'group';

export interface SiteHost {
  hostid: string;
  name: string;
  status: string;
  maintenance_status?: string;
  interfaces?: HostInterface[];
  availability: 'available' | 'unavailable' | 'unknown';
  siteSource: SiteSource;
  problems: { total: number; bySeverity: Record<string, number> };
}

export interface Site {
  name: string;
  total: number;
  available: number;
  unavailable: number;
  unknown: number;
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
  coverage: { hosts: number; tag: number; inventory: number; group: number };
}

/* ---------- Services tree (Zabbix Services, read-only) ---------- */

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

/* ---------- Services → SLA (Zabbix-native, read-only) ---------- */

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

/* ---------- Plain-language layer (plan_1.1) ---------- */

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
}
