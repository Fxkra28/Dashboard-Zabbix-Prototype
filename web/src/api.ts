import type {
  Host,
  HostOverview,
  HostGroup,
  Item,
  LatestResponse,
  Problem,
  NetDevice,
  NetInterfacesResponse,
  GraphResponse,
  GraphRange,
  TopTrigger,
  Stats,
  GroupProblems,
  ZMap,
  MapDetail,
  SitesResponse,
  ServicesResponse,
  DerivedServicesResponse,
  SliReport,
  SliProfile,
  SlaSource,
  AvailabilityBasis,
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
  ChatContext,
  ChatDone,
  ChatMessage,
} from './types';

const TOKEN_KEY = 'hcml_token';
export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const setToken = (t: string) => localStorage.setItem(TOKEN_KEY, t);
export const clearToken = () => localStorage.removeItem(TOKEN_KEY);

/**
 * The abort signal for requests started right now; see `withSignal`.
 *
 * useAsync cancels a request nobody will read: the page moved to another
 * device, reloaded, or closed. Rather than thread a signal through every
 * `api.*` method, it sets this around its synchronous call to the fetcher.
 * `request()` reads it before its first `await`, so every request that call
 * starts picks it up; one started later (after an `await`) does not.
 */
let currentSignal: AbortSignal | undefined;

/** Run `fn`, attaching `signal` to each `request()` it starts synchronously. */
export function withSignal<T>(signal: AbortSignal | undefined, fn: () => T): T {
  const previous = currentSignal;
  currentSignal = signal;
  try {
    return fn();
  } finally {
    currentSignal = previous;
  }
}

/** All portal data goes through /bff (proxied to the BFF); the browser never sees Zabbix. */
async function request<T>(path: string, init: { signal?: AbortSignal } = {}): Promise<T> {
  const signal = init.signal ?? currentSignal;
  const token = getToken();
  const res = await fetch(`/bff${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    signal,
  });

  if (res.status === 401) {
    clearToken();
    if (location.pathname !== '/login') location.href = '/login';
    throw new Error('Unauthorized');
  }
  if (!res.ok) {
    // The BFF returns a typed body for the failures an operator can act on:
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
    request<{
      ok: boolean;
      ts: number;
      ai: boolean;
      writeBack: boolean;
      defaults?: { availabilityMinSeverity?: number };
    }>('/api/health'),
  hosts: () => request<Host[]>('/api/hosts'),
  hostsOverview: () => request<HostOverview[]>('/api/hosts/overview'),
  hostgroups: () => request<HostGroup[]>('/api/hostgroups'),
  items: (hostid: string, search?: string, opts: { graphable?: boolean } = {}) =>
    request<Item[]>(`/api/items${qs({ hostid, search, graphable: opts.graphable ? 1 : undefined })}`),
  /** Resolve specific items (any host), deep links like /graphs?itemid=a,b. */
  itemsById: (itemids: string[]) => request<Item[]>(`/api/items${qs({ itemids: itemids.join(',') })}`),
  latest: (opts: {
    hostid?: string;
    groupid?: string;
    search?: string;
    page?: number;
    pageSize?: number;
  }) => request<LatestResponse>(`/api/latest${qs(opts)}`),
  /** Chart-ready series for 1–4 numeric items over a pinned window. */
  graph: (itemids: string[], range: GraphRange, points?: number) =>
    request<GraphResponse>(
      `/api/graph${qs({
        itemids: itemids.join(','),
        points,
        ...(range.kind === 'hours'
          ? { hours: range.hours }
          : range.kind === 'month'
            ? { month: range.month }
            : { from: range.from, to: range.to }),
      })}`,
    ),
  netInterfaces: (opts: {
    hostid: string;
    search?: string;
    status?: 'up' | 'down' | 'other' | '';
    page?: number;
    pageSize?: number;
  }) => request<NetInterfacesResponse>(`/api/net/interfaces${qs(opts)}`),
  problems: () => request<Problem[]>('/api/problems'),
  netDevices: () => request<NetDevice[]>('/api/net/devices'),
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

  // Site view: every host rolled up to the site it lives at.
  sites: () => request<SitesResponse>('/api/sites'),

  // Governance: how standardised is the estate? (admin)
  inventory: () => request<ScorecardResponse>('/api/reports/inventory'),

  // WAN / SD-WAN / radio link health (operator)
  links: () => request<LinksResponse>('/api/links'),

  // Automated reporting
  /** `(days, severity)` is the legacy all-problems form; pass an object for the engine-backed basis. */
  availability: (arg: number | AvailabilityQuery, severity?: number) =>
    request<AvailabilityReport>(
      `/api/reports/availability${qs(
        typeof arg === 'number'
          ? { days: arg, severity }
          : {
              basis: arg.basis,
              profile: arg.basis === 'all-problems' ? undefined : arg.profile,
              month: arg.month,
              days: arg.month ? undefined : arg.days,
              severity: arg.basis === 'all-problems' ? arg.severity : undefined,
            },
      )}`,
    ),
  aging: () => request<AgingReport>('/api/reports/aging'),
  capacity: (days: number) => request<CapacityReport>(`/api/reports/capacity${qs({ days })}`),
  /** `top` = how many triggers come back (the BFF's default is 100); `total` counts them all. */
  noise: (days: number, severity: number, top?: number) =>
    request<NoiseReport>(`/api/reports/noise${qs({ days, severity, top })}`),

  // Services tree with roll-up status: the service-centric view.
  services: () => request<ServicesResponse>('/api/services'),
  /** The tree derived from the estate, for a Zabbix with no services configured. */
  servicesDerived: (month?: string, profile?: SliProfile) =>
    request<DerivedServicesResponse>(`/api/services/derived${qs({ month, profile })}`),

  // Derived monthly SLA (portal-computed from ICMP triggers, read-only)
  sli: (month?: string, profile?: SliProfile) =>
    request<SliReport>(`/api/sli${qs({ month, profile })}`),

  // Services → SLA
  slaSource: () => request<SlaSource>('/api/sla/source'),
  sla: () => request<Sla[]>('/api/sla'),
  slaSli: (slaid: string, serviceid?: string) =>
    request<SlaSli[]>(`/api/sla/sli${qs({ slaid, serviceid })}`),

  // Plain-language layer, on-demand only, never called on page load.
  explainProblem: (eventid: string) =>
    request<ProblemExplanation>(`/api/explain/problem${qs({ eventid })}`),
  /** `(slaid, serviceid?)` or an object: a Zabbix SLA, or a scope of the derived monthly SLA. */
  explainSla: (arg: string | ExplainSlaQuery, serviceid?: string) =>
    request<SlaExplanation>(
      `/api/explain/sla${qs(
        typeof arg === 'string'
          ? { slaid: arg, serviceid }
          : 'source' in arg
            ? { source: 'derived', month: arg.month, profile: arg.profile, scope: arg.scope }
            : { slaid: arg.slaid, serviceid: arg.serviceid },
      )}`,
    ),
};

export interface AvailabilityQuery {
  basis?: AvailabilityBasis;
  profile?: SliProfile;
  /** YYYY-MM calendar month (Asia/Jakarta); takes precedence over `days`. */
  month?: string;
  days?: number;
  /** Legacy all-problems basis only. */
  severity?: number;
}

export type ExplainSlaQuery =
  | { slaid: string; serviceid?: string }
  | { source: 'derived'; month?: string; profile?: SliProfile; scope: string };

/** EventSource can't set headers, so pass the token via query when auth is on. */
export function streamUrl(): string {
  const t = getToken();
  return `/bff/api/stream${t ? `?token=${encodeURIComponent(t)}` : ''}`;
}

/**
 * The assistant. A POST whose response is a text/event-stream (server
 * routes/chat.ts), so it fits neither `post()` nor `EventSource`. Read the
 * body as it arrives and hand each frame to the caller. Resolves on `done`,
 * rejects on an `error` frame, and stops early when `signal` aborts.
 */
export async function chatStream(
  messages: ChatMessage[],
  on: {
    onContext?: (c: ChatContext) => void;
    onToken: (t: string) => void;
    onDone?: (d: ChatDone) => void;
  },
  signal?: AbortSignal,
): Promise<void> {
  const token = getToken();
  const res = await fetch('/bff/api/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ messages }),
    signal,
  });

  if (res.status === 401) {
    clearToken();
    if (location.pathname !== '/login') location.href = '/login';
    throw new Error('Unauthorized');
  }
  if (!res.ok || !res.body) {
    const b = (await res.json().catch(() => null)) as { error?: string; message?: string } | null;
    throw new Error(b?.message ?? b?.error ?? `/api/chat: HTTP ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      const event = /^event: (.*)$/m.exec(block)?.[1];
      const data = /^data: (.*)$/m.exec(block)?.[1];
      if (!event || data === undefined) continue;
      const payload = JSON.parse(data) as unknown;
      if (event === 'token') on.onToken((payload as { t: string }).t);
      else if (event === 'context') on.onContext?.(payload as ChatContext);
      else if (event === 'error') throw new Error((payload as { message: string }).message);
      else if (event === 'done') {
        on.onDone?.(payload as ChatDone);
        return;
      }
    }
  }
}

/**
 * Ask the BFF to load the local model now, so the first question does not wait
 * for it. Fire-and-forget: failures only mean a slower first answer.
 */
export async function chatWarm(): Promise<void> {
  const token = getToken();
  await fetch('/bff/api/chat/warm', {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  }).catch(() => undefined);
}

export async function login(username: string, password: string) {
  const res = await fetch('/bff/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  // Only a 401 means the credentials were wrong. A 429 (rate limit) or a BFF
  // that is down used to be reported as "Invalid credentials" too.
  if (res.status === 401) throw new Error('Invalid username or password.');
  if (!res.ok) {
    const b = (await res.json().catch(() => null)) as { error?: string; message?: string } | null;
    throw new Error(b?.message ?? `Sign-in failed (HTTP ${res.status}). Is the BFF running?`);
  }
  const data = (await res.json()) as { token: string; user: { name: string; role: string } };
  setToken(data.token);
  return data;
}
