/** The checks for availability and SLA: the availability report, the derived monthly SLA, the service trees and Zabbix's own SLAs. */

import type { AvailabilityReport, DerivedServiceNode, DerivedServicesResponse, HostAvailability, ServiceNode, ServiceSla, ServicesResponse, Sla, SlaSli, SlaSource, SliGap, SliGroup, SliHost, SliPath, SliReport, SliWeb } from '../types';
import { siteRef } from './hosts';
import { type Check, flag, guard, lazy, listOf, num, opt, orNull, shape, type Shape, tag, text } from './shape';

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
  noDataWindows: opt(listOf(sliGap)),
});

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
  noDataWindows: listOf(sliGap),
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
  noDataWindows: listOf(sliGap),
  stats: shape<SliReport['stats']>({ zabbixCalls: num, triggers: num, events: num, trendRows: num, ms: num }),
  generatedAt: num,
});

const slaSource = shape<SlaSource>({ real: flag, slas: num, services: num });

const sla = shape<Sla>({ slaid: text, name: text, slo: text, period: text, status: text, timezone: opt(text), description: opt(text) });

const slaSli = shape<SlaSli>({ serviceid: text, name: text, sli: num, uptime: num, downtime: num, error_budget: num, period_from: num, period_to: num });

/** GET /api/reports/availability, either basis. */
export const availabilityGuard = guard<AvailabilityReport>('the availability report', availability);

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
