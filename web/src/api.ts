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
  Stats,
  Freshness,
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
  MetersResponse,
  TopHostsResponse,
  WebMonitoringResponse,
  DevicesResponse,
  AvailabilityReport,
  AgingReport,
  CapacityReport,
  NoiseReport,
  Me,
  ChatContext,
  ChatDone,
  ChatMessage,
} from './types';
import { noteStaleCopy } from './shared/lib/freshness';
import { clearConversation, startConversation } from './shared/lib/chatStore';
import {
  assertFits,
  agingGuard,
  availabilityGuard,
  capacityGuard,
  derivedServicesGuard,
  freshnessGuard,
  graphGuard,
  groupProblemsGuard,
  hostGroupListGuard,
  hostListGuard,
  hostOverviewGuard,
  itemListGuard,
  latestGuard,
  linksGuard,
  mapDetailGuard,
  mapListGuard,
  meGuard,
  netDevicesGuard,
  metersGuard,
  topHostsGuard,
  webMonitoringGuard,
  devicesGuard,
  netInterfacesGuard,
  noiseGuard,
  problemListGuard,
  scorecardGuard,
  servicesGuard,
  sitesGuard,
  slaListGuard,
  slaSliGuard,
  slaSourceGuard,
  sliGuard,
  statsGuard,
  topTriggersGuard,
  type Guard,
} from './guards';

/**
 * The session. The token itself lives in an httpOnly cookie that no script on this page can read;
 * the browser sends it with every same-origin request. What the page keeps is when the session
 * ends, by its own clock, from the `expiresIn` the BFF gives with each sign-in, renewal and
 * /api/auth/me.
 */
let session: { endsAt: number; lifeMs: number } | null = null;
/** The user the last answer named, so a renewal can tell when the role changed. */
let lastUser: { name: string; role: string } | null = null;
/** Set by a sign-out in this tab or another, so a renewal on its way out cannot undo it. */
let signedOut = false;
/** The renewal in flight, which a sign-out waits for: its answer would set the cookie again. */
let renewing: Promise<unknown> | null = null;

/** Every POST carries this; with the session in a cookie the BFF refuses one without it. */
const CSRF = { 'X-HCML-CSRF': '1' };

// Earlier builds kept the token in localStorage. Drop it: it still works as a
// Bearer token until it ends, and nothing reads it now.
try {
  localStorage.removeItem('hcml_token');
} catch {
  /* storage blocked: nothing to clear */
}

/** Note a session the BFF just described: `expiresIn` seconds from now. */
export function recordSession(expiresIn: unknown, user?: { name: string; role: string } | null): void {
  if (typeof expiresIn === 'number' && expiresIn > 0) {
    session = { endsAt: Date.now() + expiresIn * 1000, lifeMs: expiresIn * 1000 };
    signedOut = false;
  }
  if (user) lastUser = { name: user.name, role: user.role };
}

/** When the session ends and how long it had left when the page heard, or null when unknown. */
export const sessionTiming = () => session;
export const isSignedOut = () => signedOut;

/** Fired on window when the user or role may have changed, here or in another tab, so the menus follow it (useAuth). */
export const AUTH_CHANGED = 'hcml:auth-changed';

type AuthMessage = { type: 'signed-in' | 'signed-out' | 'changed' };

// Tabs share the cookie but not this module: tell the others when the session
// changes hands. Missing before Safari 15.4, where each tab finds out at its
// next request instead.
const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('hcml-auth');
const announce = (type: AuthMessage['type']) => channel?.postMessage({ type } satisfies AuthMessage);

channel?.addEventListener('message', (e: MessageEvent<AuthMessage>) => {
  if (e.data?.type === 'signed-out') {
    signedOut = true;
    session = null;
    // A renewal this tab had out would set the cookie again: clear it once more when it lands.
    const pending = renewing;
    if (pending) void pending.finally(() => void postLogout().catch(() => undefined));
    goToSignIn();
  } else if (e.data?.type === 'signed-in' || e.data?.type === 'changed') {
    signedOut = false;
    window.dispatchEvent(new Event(AUTH_CHANGED));
  }
});

// Back can bring a page out of the browser's back/forward cache exactly as it was left, although
// the session may have ended since: after a sign-out in another tab the signed-in page would sit
// behind /login. Check again on the way back. A sign-out goes straight to sign-in; otherwise the
// BFF's 401 does, and another user signed in meanwhile gets the menus redrawn for them.
window.addEventListener('pageshow', (e) => {
  if (!e.persisted) return;
  if (signedOut) {
    goToSignIn();
    return;
  }
  const was = lastUser;
  void api
    .me()
    .then((m) => {
      if (was && m.user && (m.user.name !== was.name || m.user.role !== was.role)) {
        window.dispatchEvent(new Event(AUTH_CHANGED));
      }
    })
    .catch(() => undefined);
});

/**
 * Off to sign in, remembering the page to come back to, so a wall screen
 * returns to its wall mode and a filtered list to its filters.
 */
export function goToSignIn(): void {
  // Every refused session and every sign-out in another tab ends here: the Assistant's conversation goes with it.
  clearConversation();
  if (location.pathname === '/login') return;
  location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
}

/**
 * Swap the session for a fresh one (POST /api/auth/refresh). "signed-out" when
 * the BFF refused it, with the page already on its way to sign-in, or when the
 * user signed out meanwhile; "failed" when the BFF did not answer, worth
 * another try while the session lasts.
 */
export function renewSession(): Promise<'renewed' | 'failed' | 'signed-out'> {
  const run = doRenew();
  renewing = run;
  void run.finally(() => {
    if (renewing === run) renewing = null;
  });
  return run;
}

async function doRenew(): Promise<'renewed' | 'failed' | 'signed-out'> {
  if (signedOut) return 'signed-out';
  type Renewed = { user?: { name: string; role: string }; expiresIn?: unknown };
  let res: Response;
  let body: Renewed | null = null;
  // A request that never answers would hold renewal up until the session ran
  // out (nginx waits up to an hour): give up and let the retry take over. A
  // plain controller, since AbortSignal.timeout is missing before Chrome 103 and Safari 16.
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 30_000);
  try {
    res = await fetch('/bff/api/auth/refresh', { method: 'POST', headers: CSRF, signal: abort.signal });
    if (res.ok) body = (await res.json().catch(() => null)) as Renewed | null;
  } catch {
    return 'failed';
  } finally {
    clearTimeout(timer);
  }
  if (signedOut) return 'signed-out';
  if (res.status === 401) {
    // Refused: stop renewing until a sign-in, here or in another tab.
    signedOut = true;
    session = null;
    goToSignIn();
    return 'signed-out';
  }
  if (typeof body?.expiresIn !== 'number' || !body.user) return 'failed';
  const was = lastUser;
  recordSession(body.expiresIn, body.user);
  if (was && (was.role !== body.user.role || was.name !== body.user.name)) {
    window.dispatchEvent(new Event(AUTH_CHANGED));
    announce('changed');
  }
  return 'renewed';
}

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

/**
 * A reply that was not a success. `told` is whether the BFF said why in its own words; when it did
 * not (an nginx 502 page, an empty 504), the message is only the route and the status, which is
 * for a log and not for a person.
 */
export class HttpFailure extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly told: boolean,
  ) {
    super(message);
    this.name = 'HttpFailure';
  }
}

/** The GET behind every read, JSON or file, so a 401 and a failure's message are handled in one place. */
async function fetchOk(path: string, signal: AbortSignal | undefined): Promise<Response> {
  // Same-origin, so the browser sends the session cookie by itself.
  const res = await fetch(`/bff${path}`, { signal });

  if (res.status === 401) {
    session = null;
    goToSignIn();
    throw new Error('Unauthorized');
  }
  if (!res.ok) {
    // The BFF returns a typed body for the failures an operator can act on:
    // a rejected Zabbix token, the AI layer off or unreachable. Show that
    // message instead of a bare status code.
    const body = (await res.json().catch(() => null)) as
      | { error?: unknown; message?: unknown }
      | null;
    // Only words count: an empty message or an object would read as a blank or "[object Object]".
    const said = [body?.message, body?.error].find((v): v is string => typeof v === 'string' && v.trim() !== '');
    throw new HttpFailure(said ?? `${path}: HTTP ${res.status}`, res.status, said !== undefined);
  }
  return res;
}

/** How long a read may go unanswered before the page is told it failed. */
const REQUEST_TIMEOUT_MS = 30_000;
/**
 * An explanation waits on a language model, which the BFF itself allows 30 s
 * (one retry) hosted or 120 s local. This stays above both, and below nginx's 180 s.
 */
const EXPLAIN_TIMEOUT_MS = 170_000;
/** The first monthly SLA after a restart is computed from months of events. Below nginx's 180 s. */
const SLI_TIMEOUT_MS = 170_000;

/**
 * All portal data goes through /bff (proxied to the BFF); the browser never sees Zabbix.
 *
 * Every request has a deadline: without one a stalled request freezes a page's polling until nginx
 * gives up, with no "refresh failed" note. A plain controller, as in `doRenew`, joined to the
 * caller's signal: AbortSignal.timeout and .any are missing in older browsers. Only a deadline that
 * passed reads as a failure; a cancel from the caller stays a cancel.
 */
async function request<T>(
  path: string,
  init: { signal?: AbortSignal; timeoutMs?: number; guard?: Guard<T> } = {},
): Promise<T> {
  const caller = init.signal ?? currentSignal;
  const abort = new AbortController();
  const cancel = () => abort.abort();
  if (caller?.aborted) cancel();
  else caller?.addEventListener('abort', cancel, { once: true });
  const limit = init.timeoutMs ?? REQUEST_TIMEOUT_MS;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    abort.abort();
  }, limit);
  try {
    const res = await fetchOk(path, abort.signal);
    const json = (await res.json()) as T;
    // An answer of the wrong shape becomes the page's ordinary error, not a crash in whatever reads it.
    const body = init.guard ? assertFits(init.guard, json, path) : json;
    // An old copy kept because Zabbix failed is flagged in a header, not the body.
    noteStaleCopy(body, res.headers);
    return body;
  } catch (err) {
    if (timedOut && !caller?.aborted) {
      throw new Error(`No answer from the server within ${Math.round(limit / 1000)} seconds.`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
    caller?.removeEventListener('abort', cancel);
  }
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`/bff${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...CSRF },
    body: JSON.stringify(body),
  });

  if (res.status === 401) {
    session = null;
    goToSignIn();
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

/** The two file types the monthly SLA report comes in. */
export type ReportFormat = 'pdf' | 'xlsx';

/**
 * The file name a Content-Disposition header proposes, or `fallback` when it
 * names none. `filename*` (UTF-8) wins over `filename`. Only the last path
 * segment is kept, so a header can never aim a download at another folder.
 */
export function fileNameFrom(disposition: string | null, fallback: string): string {
  const params = new Map<string, string>();
  // A quoted value is taken whole, so a ";" inside one never starts a parameter.
  const param = /;\s*([\w*-]+)\s*=\s*("(?:[^"\\]|\\.)*"|[^;]*)/g;
  for (const [, key, raw] of (disposition ?? '').matchAll(param)) {
    const quoted = /^"(.*)"$/s.exec(raw);
    params.set(key.toLowerCase(), quoted ? quoted[1].replace(/\\(.)/g, '$1') : raw.trim());
  }
  let name = params.get('filename') ?? '';
  const encoded = /^utf-8'[^']*'(.*)$/i.exec(params.get('filename*') ?? '');
  if (encoded) {
    try {
      name = decodeURIComponent(encoded[1]);
    } catch {
      // A broken escape: the plain name, if there is one, still stands.
    }
  }
  const clean = (name.replace(/\p{Cc}/gu, '').split(/[\\/]/).pop() ?? '').trim();
  return clean && clean !== '.' && clean !== '..' ? clean : fallback;
}

/**
 * The name to save a report under: the one the BFF sent when it ends in the format's own
 * extension and holds no invisible formatting characters, otherwise one made here. The BFF names
 * the file from the month alone, so this only matters if something between it and the browser
 * answers in its place, and then a name such as `report.pdf.exe` must not survive.
 */
export function reportFileName(disposition: string | null, month: string, format: ReportFormat): string {
  const fallback = `HCML_SLA_Report_${month}.${format}`;
  const proposed = fileNameFrom(disposition, fallback);
  return proposed.toLowerCase().endsWith(`.${format}`) && !/\p{Cf}/u.test(proposed) ? proposed : fallback;
}

/** What each format's file is, as the Content-Type header says it. */
const REPORT_TYPES: Record<ReportFormat, { type: string; what: string }> = {
  pdf: { type: 'application/pdf', what: 'a PDF file' },
  xlsx: { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', what: 'an Excel file' },
};

export const api = {
  health: () =>
    request<{
      ok: boolean;
      ts: number;
      ai: boolean;
      aiProvider?: string;
      aiExternal?: boolean;
      writeBack: boolean;
      defaults?: { availabilityMinSeverity?: number; timezone?: string };
      /** Only in the reply a signed-in caller gets. */
      build?: { commit?: string; time?: string };
      /** Only in the reply a signed-in caller gets: the BFF's cached check of Zabbix and of the AI model. */
      ready?: { model?: string };
    }>('/api/health'),
  hosts: () => request<Host[]>('/api/hosts', { guard: hostListGuard }),
  hostsOverview: () => request<HostOverview[]>('/api/hosts/overview', { guard: hostOverviewGuard }),
  /** Every host as a device of one kind, for the Devices page. */
  devices: () => request<DevicesResponse>('/api/devices', { guard: devicesGuard }),
  hostgroups: () => request<HostGroup[]>('/api/hostgroups', { guard: hostGroupListGuard }),
  items: (hostid: string, search?: string, opts: { graphable?: boolean } = {}) =>
    request<Item[]>(`/api/items${qs({ hostid, search, graphable: opts.graphable ? 1 : undefined })}`, { guard: itemListGuard }),
  /** Resolve specific items (any host), deep links like /graphs?itemid=a,b. */
  itemsById: (itemids: string[]) => request<Item[]>(`/api/items${qs({ itemids: itemids.join(',') })}`, { guard: itemListGuard }),
  latest: (opts: {
    hostid?: string;
    groupid?: string;
    search?: string;
    page?: number;
    pageSize?: number;
  }) => request<LatestResponse>(`/api/latest${qs(opts)}`, { guard: latestGuard }),
  /** Chart-ready series for 1 to 4 numeric items over a pinned window. */
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
      { guard: graphGuard },
    ),
  netInterfaces: (opts: {
    hostid: string;
    search?: string;
    status?: 'up' | 'down' | 'other' | '';
    page?: number;
    pageSize?: number;
  }) => request<NetInterfacesResponse>(`/api/net/interfaces${qs(opts)}`, { guard: netInterfacesGuard }),
  problems: () => request<Problem[]>('/api/problems', { guard: problemListGuard }),
  netDevices: () => request<NetDevice[]>('/api/net/devices', { guard: netDevicesGuard }),
  /** The internet traffic meters: the gauge widgets of a Zabbix dashboard, with a value each. Operator and admin. */
  netMeters: () => request<MetersResponse>('/api/net/meters', { guard: metersGuard }),
  /** The hosts with the highest CPU and memory use now, a few of each. */
  topHosts: () => request<TopHostsResponse>('/api/reports/top-hosts', { guard: topHostsGuard }),
  /** Web scenarios that pass, fail or have no current result, with the failed ones listed. */
  webMonitoring: () => request<WebMonitoringResponse>('/api/reports/web-monitoring', { guard: webMonitoringGuard }),
  topTriggers: (days: number) =>
    request<TopTriggersReport>(`/api/reports/top-triggers${qs({ days })}`, { guard: topTriggersGuard }),
  stats: () => request<Stats>('/api/stats', { guard: statsGuard }),
  /** When Zabbix last collected a value, and whether that is long enough ago to call it stopped. */
  freshness: () => request<Freshness>('/api/freshness', { guard: freshnessGuard }),
  problemsByGroup: () => request<GroupProblems[]>('/api/reports/problems-by-group', { guard: groupProblemsGuard }),
  maps: () => request<ZMap[]>('/api/maps', { guard: mapListGuard }),
  mapDetail: (mapid: string) => request<MapDetail[]>(`/api/maps/detail${qs({ mapid })}`, { guard: mapDetailGuard }),

  // Who am I, and what may I see? Drives sidebar filtering. Also how long the
  // session has left, which times its renewal (useSessionRenewal).
  me: () =>
    request<Me>('/api/auth/me', { guard: meGuard }).then((m) => {
      recordSession(m.expiresIn, m.user);
      return m;
    }),

  /** The portal's only write. Operator role + ZABBIX_WRITE_TOKEN required. */
  acknowledge: (body: {
    eventids: string[];
    message?: string;
    close?: boolean;
    acknowledge?: boolean;
  }) => post<{ ok: true; eventids: string[]; action: number }>('/api/problems/acknowledge', body),

  // Site view: every host rolled up to the site it lives at.
  sites: () => request<SitesResponse>('/api/sites', { guard: sitesGuard }),

  // Governance: how standardised is the estate? (admin)
  inventory: () => request<ScorecardResponse>('/api/reports/inventory', { guard: scorecardGuard }),

  // WAN / SD-WAN / radio link health (operator)
  links: () => request<LinksResponse>('/api/links', { guard: linksGuard }),

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
      { guard: availabilityGuard },
    ),
  aging: () => request<AgingReport>('/api/reports/aging', { guard: agingGuard }),
  capacity: (days: number) => request<CapacityReport>(`/api/reports/capacity${qs({ days })}`, { guard: capacityGuard }),
  /** `top` = how many triggers come back (the BFF's default is 100); `total` counts them all. */
  noise: (days: number, severity: number, top?: number) =>
    request<NoiseReport>(`/api/reports/noise${qs({ days, severity, top })}`, { guard: noiseGuard }),

  // Services tree with roll-up status: the service-centric view.
  services: () => request<ServicesResponse>('/api/services', { guard: servicesGuard }),
  /** The tree derived from the estate, for a Zabbix with no services configured. */
  servicesDerived: (month?: string, profile?: SliProfile) =>
    request<DerivedServicesResponse>(`/api/services/derived${qs({ month, profile })}`, { guard: derivedServicesGuard }),

  // Derived monthly SLA (portal-computed from ICMP triggers, read-only)
  sli: (month?: string, profile?: SliProfile) =>
    request<SliReport>(`/api/sli${qs({ month, profile })}`, { timeoutMs: SLI_TIMEOUT_MS, guard: sliGuard }),
  /** The month's report as a PDF or Excel file, named by the BFF; `signal` cancels it. */
  sliExport: async (month: string, format: ReportFormat, signal?: AbortSignal) => {
    const res = await fetchOk(`/api/sli/export${qs({ month, format })}`, signal ?? currentSignal);
    const { type, what } = REPORT_TYPES[format];
    // A 200 is not proof of a report: a proxy that answers a lapsed session with a login page gets here too.
    if (!(res.headers.get('Content-Type') ?? '').toLowerCase().startsWith(type)) {
      throw new Error(`The server answered with something that is not ${what}.`);
    }
    const blob = await res.blob();
    if (blob.size === 0) throw new Error('The server sent an empty file.');
    return { blob, fileName: reportFileName(res.headers.get('Content-Disposition'), month, format) };
  },

  // Services → SLA
  slaSource: () => request<SlaSource>('/api/sla/source', { guard: slaSourceGuard }),
  sla: () => request<Sla[]>('/api/sla', { guard: slaListGuard }),
  slaSli: (slaid: string, serviceid?: string) =>
    request<SlaSli[]>(`/api/sla/sli${qs({ slaid, serviceid })}`, { guard: slaSliGuard }),

  // Plain-language layer, on-demand only, never called on page load.
  explainProblem: (eventid: string) =>
    request<ProblemExplanation>(`/api/explain/problem${qs({ eventid })}`, { timeoutMs: EXPLAIN_TIMEOUT_MS }),
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
      { timeoutMs: EXPLAIN_TIMEOUT_MS },
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

/** The live stream. EventSource sends the session cookie like any same-origin request, so no token rides in the URL. */
export function streamUrl(): string {
  return '/bff/api/stream';
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
  const res = await fetch('/bff/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...CSRF },
    body: JSON.stringify({ messages }),
    signal,
  });

  if (res.status === 401) {
    session = null;
    goToSignIn();
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
  await fetch('/bff/api/chat/warm').catch(() => undefined);
}

/** Sign in. The BFF sets the session cookie; the answer names the user and how long the session lasts. */
export async function login(username: string, password: string) {
  const res = await fetch('/bff/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...CSRF },
    body: JSON.stringify({ username, password }),
  });
  // Only a 401 means the credentials were wrong: a 429 (rate limit) or a BFF that is down must not
  // read as "Invalid credentials".
  if (res.status === 401) throw new Error('Invalid username or password.');
  if (!res.ok) {
    const b = (await res.json().catch(() => null)) as { error?: string; message?: string } | null;
    throw new Error(b?.message ?? `Sign-in failed (HTTP ${res.status}). The portal is not answering. Try again, or tell the portal admin.`);
  }
  const data = (await res.json()) as { user: { name: string; role: string }; expiresIn: number };
  recordSession(data.expiresIn, data.user);
  startConversation(); // a sign-in starts a conversation of its own, whoever was here before
  announce('signed-in');
  return data.user;
}

/** POST /api/auth/logout: the BFF clears the cookie. Public, so it works with an expired session too. */
async function postLogout(): Promise<void> {
  const res = await fetch('/bff/api/auth/logout', { method: 'POST', headers: CSRF });
  if (!res.ok) throw new Error(`Sign-out failed (HTTP ${res.status}).`);
}

/**
 * Sign out, here and in every other tab. Waits for a renewal on its way,
 * whose answer would otherwise set the cookie again after it was cleared.
 */
export async function logout(): Promise<void> {
  signedOut = true;
  session = null;
  lastUser = null;
  clearConversation(); // the next person at this workstation must not read it
  await renewing?.catch(() => undefined);
  announce('signed-out');
  await postLogout();
}
