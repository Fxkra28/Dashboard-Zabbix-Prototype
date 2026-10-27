/** Availability and SLA: the availability report, the derived monthly SLA, the service trees and Zabbix's own SLAs. */

import type { SiteRef } from './hosts';

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
  /** Spans the portal's setting SLA_NO_DATA_WINDOWS declares not measured; no downtime is counted in them. */
  noDataWindows?: SliGap[];
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
  /** Seconds inside planned maintenance, left out of the figure. */
  maintenance: number;
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
    maintenancePolicy: 'excluded';
  };
  overall: SliGroup;
  categories: SliGroup[];
  sites: SliGroup[];
  classes: SliGroup[];
  hosts: SliHost[];
  wanPaths: SliPath[];
  web: SliWeb[];
  gaps: SliGap[];
  /** Spans declared not measured (SLA_NO_DATA_WINDOWS), treated as hours with no data by both methods. */
  noDataWindows: SliGap[];
  stats: { zabbixCalls: number; triggers: number; events: number; trendRows: number; ms: number };
  generatedAt: number;
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
  noDataWindows: SliGap[];
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
