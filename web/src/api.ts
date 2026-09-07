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
    // The BFF returns a typed body for a rejected Zabbix token — show the
    // operator what to fix instead of a bare status code.
    const body = (await res.json().catch(() => null)) as
      | { error?: string; message?: string }
      | null;
    if (body?.error === 'zabbix_auth') throw new Error(body.message ?? 'Zabbix token rejected');
    throw new Error(`${path}: HTTP ${res.status}`);
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
  health: () => request<{ ok: boolean; ts: number }>('/api/health'),
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
    request<TopTrigger[]>(`/api/reports/top-triggers${qs({ days })}`),
  stats: () => request<Stats>('/api/stats'),
  problemsByGroup: () => request<GroupProblems[]>('/api/reports/problems-by-group'),
  maps: () => request<ZMap[]>('/api/maps'),
  mapDetail: (mapid: string) => request<MapDetail[]>(`/api/maps/detail${qs({ mapid })}`),
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
