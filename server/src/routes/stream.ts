import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type { ServerResponse } from 'node:http';
import { getProblems, type ZbxProblem } from '../queries.js';
import { cached } from '../cache.js';
import { ZabbixApiError, ZabbixAuthError, ZabbixTimeoutError } from '../zabbix.js';

/**
 * Live problems via SSE (setup.md §7). Upgrade to WebSocket / Redis fan-out later.
 *
 * One ticker serves every connected screen. Every 5 s it reads the same cache
 * entry as GET /api/problems and sends a frame only when something a screen
 * shows has changed: a problem opened, resolved, acknowledged, suppressed or
 * re-graded, or when 30 s have gone by, so the live `opdata` values do not
 * go stale. Keep-alive comments fill the gaps.
 *
 * Before, every connection ran its own timer and serialised and sent the whole
 * list every 5 s whether or not anything had changed: ~450 KB per screen per
 * tick against HCML's Zabbix.
 */

export const TICK_MS = 5_000;
/** Resend an unchanged list after this long, so `opdata` keeps up. */
export const MAX_QUIET_MS = 30_000;
const KEEPALIVE_MS = 15_000;

// Pure parts (unit-tested)

/**
 * What a screen shows of the list, as one comparable string. `opdata`, tags
 * and host names are left out on purpose: the 30 s resend covers them. Sorted,
 * so the same problems returned in another order are not a change.
 */
export function fingerprint(problems: readonly ZbxProblem[]): string {
  return problems
    .map((p) => `${p.eventid}:${p.severity}:${p.acknowledged}:${p.suppressed ?? ''}:${p.r_eventid ?? ''}`)
    .sort()
    .join('|');
}

/** The last list sent to the screens: its fingerprint, and when. */
export interface Sent {
  fingerprint: string;
  at: number;
}

/**
 * Whether a fresh read is worth a frame. An unchanged list goes out once the
 * next tick would be past MAX_QUIET_MS, checked only every TICK_MS, a plain
 * `>= MAX_QUIET_MS` let it wait up to 35 s.
 */
export function shouldSend(last: Sent | null, current: string, now: number): boolean {
  return last === null || last.fingerprint !== current || now + TICK_MS - last.at > MAX_QUIET_MS;
}

// The shared ticker

interface Frame {
  id: number;
  text: string;
}

interface Client {
  res: ServerResponse;
  /** `write()` returned false: data frames are skipped until 'drain'. */
  blocked: boolean;
  /** The frame this client last had written to it. */
  frameId: number;
  lastWrite: number;
}

const clients = new Set<Client>();
/** The latest frame: what a new connection gets first, and what a drained one catches up to. */
let latest: Frame | null = null;
let lastSent: Sent | null = null;
let frameIds = 0;
let ticker: NodeJS.Timeout | null = null;
let ticking = false;
/** Reads are numbered so a slow one that lands late cannot replace a newer frame. */
let readsStarted = 0;
let readsApplied = 0;
/** The failure last reported, so a Zabbix outage is logged once rather than every tick. */
let lastError: string | null = null;
let log: FastifyBaseLogger | undefined;

function write(client: Client, text: string, now: number): void {
  const { res } = client;
  if (res.destroyed || res.writableEnded) return;
  client.lastWrite = now;
  if (res.write(text)) return;
  // The socket's buffer is full: a slow link, or a tab the browser throttles.
  // Stacking 450 KB frames behind it would only grow the BFF's memory.
  client.blocked = true;
  res.once('drain', () => {
    client.blocked = false;
    if (latest && client.frameId !== latest.id && clients.has(client)) deliver(client, latest, Date.now());
  });
}

function deliver(client: Client, frame: Frame, now: number): void {
  if (client.blocked) return;
  client.frameId = frame.id;
  write(client, frame.text, now);
}

function broadcast(text: string, now: number): void {
  latest = { id: ++frameIds, text };
  for (const client of clients) deliver(client, latest, now);
}

/**
 * What a screen may be told about a failed read. Zabbix's typed errors carry a
 * message written for it (and never the Zabbix address); anything else is a
 * bug, whose wording stays in the log: the same split errors.ts makes.
 */
function publicMessage(err: unknown): string {
  const known = err instanceof ZabbixApiError || err instanceof ZabbixTimeoutError || err instanceof ZabbixAuthError;
  const message = known ? err.message : 'The live stream hit an unexpected error. Details are in the BFF log.';
  if (message !== lastError) {
    if (err instanceof ZabbixApiError || err instanceof ZabbixTimeoutError) {
      log?.error({ detail: err.detail }, err.message);
    } else {
      log?.error(err);
    }
  }
  lastError = message;
  return message;
}

async function refresh(force: boolean): Promise<void> {
  const read = ++readsStarted;
  try {
    let problems: ZbxProblem[] | null = null;
    let failure: unknown;
    try {
      problems = await cached('problems', 5_000, getProblems);
    } catch (err) {
      failure = err;
    }
    if (read < readsApplied || !clients.size) return;
    readsApplied = read;
    const now = Date.now();

    if (!problems) {
      // Sent every tick, as before, and the next good read goes out whatever
      // its fingerprint, so screens drop the error as soon as Zabbix is back.
      lastSent = null;
      broadcast(`event: error\ndata: ${JSON.stringify({ message: publicMessage(failure) })}\n\n`, now);
      return;
    }
    lastError = null;
    const current = fingerprint(problems);
    if (!force && !shouldSend(lastSent, current, now)) return;
    lastSent = { fingerprint: current, at: now };
    broadcast(`event: problems\ndata: ${JSON.stringify(problems)}\n\n`, now);
  } catch (err) {
    log?.error(err);
  }
}

function tick(): void {
  const now = Date.now();
  for (const client of clients) {
    if (!client.blocked && now - client.lastWrite >= KEEPALIVE_MS) write(client, ': keep-alive\n\n', now);
  }
  // Zabbix slower than the tick: let the read in flight finish rather than queue more.
  if (ticking) return;
  ticking = true;
  void refresh(false).then(() => {
    ticking = false;
  });
}

/**
 * Add one screen. It gets the latest frame at once, or, for the first screen,
 * as soon as the first read lands, and the ticker runs while anyone listens.
 * Returns the function that removes it again.
 */
export function subscribe(res: ServerResponse): () => void {
  const client: Client = { res, blocked: false, frameId: 0, lastWrite: Date.now() };
  clients.add(client);
  if (!ticker) {
    ticker = setInterval(tick, TICK_MS);
    ticker.unref?.();
  }
  if (latest) deliver(client, latest, Date.now());
  else if (!ticking) {
    ticking = true;
    void refresh(false).then(() => {
      ticking = false;
    });
  }

  return () => {
    if (!clients.delete(client) || clients.size || !ticker) return;
    clearInterval(ticker);
    ticker = null;
    latest = null;
    lastSent = null;
  };
}

/** Screens connected right now. */
export function connectedClients(): number {
  return clients.size;
}

/**
 * Send the list to every screen now. Called after an acknowledge or close,
 * once actions.ts has invalidated the cache: this only reads and pushes, so
 * the change shows without waiting for the next tick. Never rejects.
 */
export async function notifyProblemsChanged(): Promise<void> {
  if (clients.size) await refresh(true);
}

export async function streamRoutes(app: FastifyInstance): Promise<void> {
  log = app.log;
  app.get('/api/stream', (req, reply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // let nginx pass SSE straight through
    });

    const unsubscribe = subscribe(reply.raw);
    req.raw.on('close', unsubscribe);
  });
}
