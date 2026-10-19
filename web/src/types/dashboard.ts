/** What the Dashboard shows besides the problem list: counts, how fresh the data is, problems by group, the busiest hosts and web monitoring. */

// The busiest hosts (GET /api/reports/top-hosts): the highest CPU and memory use now.
export interface TopHostRow {
  hostid: string;
  host: string;
  itemid: string;
  /** Percent. */
  value: number;
  /** When the value was collected, epoch seconds. */
  clock: number;
}

export interface TopHostsMetric {
  key: 'cpu' | 'memory';
  label: string;
  /** Hosts that have such an item. */
  considered: number;
  /** Of those, with a current value. */
  current: number;
  rows: TopHostRow[];
}

export interface TopHostsResponse {
  generatedAt: number;
  metrics: TopHostsMetric[];
}

// Web monitoring (GET /api/reports/web-monitoring): every enabled web scenario as OK, failed or unknown.
export interface WebFailure {
  hostid: string;
  host: string;
  /** The scenario's name. */
  name: string;
  itemid: string;
  /** The step that failed, counting from 1. */
  step: number;
  /** When the result was collected, epoch seconds. */
  clock: number;
}

export interface WebMonitoringResponse {
  generatedAt: number;
  /** Enabled scenarios on monitored hosts: ok, failed and unknown added up. */
  total: number;
  ok: number;
  failed: number;
  /** No current result. An old one is never read as OK. */
  unknown: number;
  /** The failed ones, as many as were asked for. */
  failures: WebFailure[];
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

/** GET /api/freshness: when Zabbix last collected a value. Times in Unix seconds. */
export interface Freshness {
  lastCollectedAt: number | null;
  ageSeconds: number | null;
  /** Nothing collected for longer than `staleAfterSeconds`. */
  stale: boolean;
  staleAfterSeconds: number;
}

export interface GroupProblems {
  groupid: string;
  name: string;
  total: number;
  bySeverity: Record<string, number>;
}
