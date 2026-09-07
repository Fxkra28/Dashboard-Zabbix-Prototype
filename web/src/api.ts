import type {
  Host,
  HostOverview,
  HostGroup,
  Item,
  LatestItem,
  HistoryPoint,
  Problem,
  NetDevice,
  NetPort,
  TopTrigger,
  Stats,
  GroupProblems,
  ZMap,
  MapDetail,
  SitesResponse,
  ServicesResponse,
  Sla,
  SlaSli,
  ProblemExplanation,
  SlaExplanation,
  TopTriggersReport,
  ScorecardResponse,
  LinksResponse,
  AvailabilityReport,
  AgingReport,
  CapacityReport,
  NoiseReport,
  Me,
} from './types';

const TOKEN_KEY = 'hcml_token';
export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const setToken = (t: string) => localStorage.setItem(TOKEN_KEY, t);
export const clearToken = () => localStorage.removeItem(TOKEN_KEY);

/** All portal data goes through /bff (proxied to the BFF); the browser never sees Zabbix. */
async function request<T>(path: string): Promise<T> {
  const token = getToken();
  const res = await fetch(`/bff${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });

  if (res.status === 401) {
    clearToken();
    if (location.pathname !== '/login') location.href = '/login';
    throw new Error('Unauthorized');
  }
  if (!res.ok) {
    // The BFF returns a typed body for the failures an operator can act on —
    // a rejected Zabbix token, the AI layer off or unreachable. Show that
    // message instead of a bare status code.
    const body = (await res.json().catch(() => null)) as
      | { error?: string; message?: string }
      | null;
    throw new Error(body?.message ?? body?.error ?? `${path}: HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const token = getToken();
  const res = await fetch(`/bff${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });

  if (res.status === 401) {
    clearToken();
    if (location.pathname !== '/login') location.href = '/login';
    throw new Error('Unauthorized');
  }
  if (!res.ok) {
    const b = (await res.json().catch(() => null)) as
      | { error?: string; message?: string }
      | null;
    throw new Error(b?.message ?? b?.error ?? `${path}: HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

const qs = (params: Record<string, string | number | undefined>) => {
  const p = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join('&');
  return p ? `?${p}` : '';
};

export const api = {
  health: () =>
    request<{ ok: boolean; ts: number; ai: boolean; writeBack: boolean }>('/api/health'),
  hosts: () => request<Host[]>('/api/hosts'),
  hostsOverview: () => request<HostOverview[]>('/api/hosts/overview'),
  hostgroups: () => request<HostGroup[]>('/api/hostgroups'),
  items: (hostid: string, search?: string) =>
    request<Item[]>(`/api/items${qs({ hostid, search })}`),
  latest: (opts: { hostid?: string; groupid?: string; search?: string }) =>
    request<LatestItem[]>(`/api/latest${qs(opts)}`),
  problems: () => request<Problem[]>('/api/problems'),
  history: (itemid: string, hours: number, valueType: number) =>
    request<HistoryPoint[]>(`/api/history${qs({ itemid, hours, history: valueType })}`),
  netDevices: () => request<NetDevice[]>('/api/net/devices'),
  netPorts: (hostid: string) => request<NetPort[]>(`/api/net/ports${qs({ hostid })}`),
  topTriggers: (days: number) =>
    request<TopTriggersReport>(`/api/reports/top-triggers${qs({ days })}`),
  stats: () => request<Stats>('/api/stats'),
  problemsByGroup: () => request<GroupProblems[]>('/api/reports/problems-by-group'),
  maps: () => request<ZMap[]>('/api/maps'),
  mapDetail: (mapid: string) => request<MapDetail[]>(`/api/maps/detail${qs({ mapid })}`),

  // Who am I, and what may I see? Drives sidebar filtering.
  me: () => request<Me>('/api/auth/me'),

  /** The portal's ONLY write. Operator role + ZABBIX_WRITE_TOKEN required. */
  acknowledge: (body: {
    eventids: string[];
    message?: string;
    close?: boolean;
    acknowledge?: boolean;
  }) => post<{ ok: true; eventids: string[]; action: number }>('/api/problems/acknowledge', body),

  // Site view — every host rolled up to the site it lives at.
  sites: () => request<SitesResponse>('/api/sites'),

  // Governance: how standardised is the estate? (admin)
  inventory: () => request<ScorecardResponse>('/api/reports/inventory'),

  // WAN / SD-WAN / radio link health (operator)
  links: () => request<LinksResponse>('/api/links'),

  // Automated reporting
  availability: (days: number, severity: number) =>
    request<AvailabilityReport>(`/api/reports/availability${qs({ days, severity })}`),
  aging: () => request<AgingReport>('/api/reports/aging'),
  capacity: (days: number) => request<CapacityReport>(`/api/reports/capacity${qs({ days })}`),
  noise: (days: number, severity: number) =>
    request<NoiseReport>(`/api/reports/noise${qs({ days, severity })}`),

  // Services tree with roll-up status — the service-centric view.
  services: () => request<ServicesResponse>('/api/services'),

  // Services → SLA
  sla: () => request<Sla[]>('/api/sla'),
  slaSli: (slaid: string, serviceid?: string) =>
    request<SlaSli[]>(`/api/sla/sli${qs({ slaid, serviceid })}`),

  // Plain-language layer — on-demand only, never called on page load.
  explainProblem: (eventid: string) =>
    request<ProblemExplanation>(`/api/explain/problem${qs({ eventid })}`),
  explainSla: (slaid: string, serviceid?: string) =>
    request<SlaExplanation>(`/api/explain/sla${qs({ slaid, serviceid })}`),
};

/** EventSource can't set headers, so pass the token via query when auth is on. */
export function streamUrl(): string {
  const t = getToken();
  return `/bff/api/stream${t ? `?token=${encodeURIComponent(t)}` : ''}`;
}

export async function login(username: string, password: string) {
  const res = await fetch('/bff/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) throw new Error('Invalid credentials');
  const data = (await res.json()) as { token: string; user: { name: string; role: string } };
  setToken(data.token);
  return data;
}
