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
