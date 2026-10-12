import type { FastifyInstance, FastifyRequest } from 'fastify';
import { zbxWrite } from '../zabbix.js';
import { invalidate } from '../cache.js';
import { config, writeBackEnabled } from '../config.js';
import { notifyProblemsChanged } from './stream.js';
import { acknowledgeBody } from '../schemas.js';

/**
 * Acknowledge / close write-back: the portal's only write path.
 *
 * Everything else in this BFF is read-only by design (`setup.md` §20). These two routes
 * deliberately break that, so they are fenced four ways:
 *
 *   1. a separate `ZABBIX_WRITE_TOKEN`: the read token never gains write power
 *   2. `operator` role or above, enforced in auth.ts ROUTE_RULES
 *   3. blank write token ⇒ 503, and the UI hides the buttons entirely
 *   4. sign-in off ⇒ 503 too, unless ALLOW_WRITE_WITHOUT_AUTH=true
 *
 * Zabbix files every write under the write token's owner, so the portal user goes into the message
 * as `[portal:<user>]`; every attempt and failure is logged with user and address, and one request
 * acts on at most 50 events.
 *
 * Zabbix exposes both actions through one method, `event.acknowledge`, with a bitmask. The bits
 * used here:
 *
 *   1  close problem      2  acknowledge      4  add message
 *
 * Closing only works when the trigger sets `manual_close`; `getProblems()` carries that flag so the
 * UI does not offer a button Zabbix will reject.
 */

const ACTION_CLOSE = 1;
const ACTION_ACKNOWLEDGE = 2;
const ACTION_MESSAGE = 4;

/** Zabbix caps acknowledge messages at 2048 characters. */
const MAX_MESSAGE = 2048;

/** Most event ids one request may act on: a slip or a script cannot close a whole estate. */
export const MAX_EVENTIDS = 50;

/** Who is acting, for the message tag and the log. Brackets and control characters are dropped, so the tag cannot be closed early. */
function actor(req: FastifyRequest): string {
  const sub = (req.user as { sub?: unknown } | undefined)?.sub;
  const name = typeof sub === 'string' ? sub.replace(/[\p{Cc}\p{Cf}[\]]/gu, '').trim().slice(0, 64) : '';
  return name || 'anonymous';
}

/** The event ids a body names, for the log only: at most MAX_EVENTIDS, each cut short, whatever the body holds. */
function idsForLog(body: unknown): string[] {
  const raw = body && typeof body === 'object' ? (body as AckBody).eventids : undefined;
  return (Array.isArray(raw) ? raw : [raw])
    .filter((id): id is string => typeof id === 'string')
    .slice(0, MAX_EVENTIDS)
    .map((id) => id.slice(0, 32));
}

/** Who, from where, which events and what for, read loosely: even a malformed body leaves a line that says what it was after. */
function trailOf(req: FastifyRequest) {
  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as AckBody;
  return {
    user: actor(req),
    ip: req.ip,
    eventids: idsForLog(req.body),
    acknowledge: typeof body.acknowledge === 'boolean' ? body.acknowledge : true,
    close: body.close === true,
  };
}

/** Every attempt is on record with who and from where, before any check can turn it away. */
async function logAttempt(req: FastifyRequest): Promise<void> {
  req.log.info(trailOf(req), 'zabbix write-back attempt');
}

/** Requests the handler has already logged as refused or failed, so the response hook does not log them twice. */
const answered = new WeakSet<FastifyRequest>();

interface AckBody {
  eventids?: string[] | string;
  message?: string;
  /** Also close the problem. Requires the trigger to allow manual close. */
  close?: boolean;
  /** Acknowledge as well as close. Defaults to true. */
  acknowledge?: boolean;
}

/**
 * Caches that show problem/acknowledgement state and go stale after a write.
 * Prefixes: `map:` is every map's detail, `services` both service trees.
 * `chat:snapshot` exists only in the portal with the assistant; elsewhere it
 * matches nothing.
 */
const STALE_AFTER_WRITE = [
  'problems',
  'stats',
  'probsByGroup',
  'sites',
  'aging',
  'services',
  'hosts:overview',
  'map:',
  'chat:snapshot',
];

/**
 * How long those keys stay on a short TTL after a write. Zabbix applies a
 * close a few seconds after `event.acknowledge` returns, so the first refetch
 * can still read the problem as open.
 */
const WRITE_HOLD_MS = 15_000;

export async function actionRoutes(app: FastifyInstance): Promise<void> {
  // What is turned away outside the handler (no token, a viewer, a bad body, a limit) is on record too,
  // with whatever is known of it: the guard answers before the body is read, so those lines name no events.
  app.addHook('onResponse', async (req, reply) => {
    if (reply.statusCode < 400 || answered.has(req)) return;
    req.log.warn({ ...trailOf(req), status: reply.statusCode }, reply.statusCode >= 500 ? 'zabbix write-back failed' : 'zabbix write-back refused');
  });

  app.post('/api/problems/acknowledge', { schema: { body: acknowledgeBody }, preValidation: logAttempt }, async (req, reply) => {
    const trail = trailOf(req);
    const user = trail.user;
    // A refusal is logged too, so a probe or a slip leaves a line with the same fields.
    const refuse = (status: number, error: string, message: string) => {
      answered.add(req);
      req.log.warn({ ...trail, status, error }, 'zabbix write-back refused');
      return reply.code(status).send({ error, message });
    };

    if (!writeBackEnabled()) {
      return refuse(
        503,
        'zabbix_write_disabled',
        config.zbxWriteToken
          ? 'Write-back is off while sign-in is off. For local dev only, set ALLOW_WRITE_WITHOUT_AUTH=true in server/.env.'
          : 'Write-back is not configured. Set ZABBIX_WRITE_TOKEN in server/.env.',
      );
    }

    if (req.body != null && (typeof req.body !== 'object' || Array.isArray(req.body))) {
      return refuse(400, 'bad_request', 'The request body must be a JSON object.');
    }
    const body = (req.body ?? {}) as AckBody;
    const raw = Array.isArray(body.eventids) ? body.eventids : [body.eventids];
    const eventids = raw.filter((id): id is string => typeof id === 'string' && id.length > 0);

    if (!eventids.length) {
      return refuse(400, 'bad_request', 'eventids is required: one or more Zabbix event ids.');
    }
    if (eventids.length > MAX_EVENTIDS) {
      return refuse(400, 'bad_request', `At most ${MAX_EVENTIDS} event ids per request.`);
    }
    // Ids go straight into a write against Zabbix; refuse anything that is not one.
    if (eventids.some((id) => !/^\d+$/.test(id))) {
      return refuse(400, 'bad_request', 'eventids must be numeric Zabbix event ids.');
    }

    // Types are checked, not coerced: a non-string message would throw into a
    // 500, and the text "false" would count as true for `acknowledge`. null is
    // read as "not given".
    if (body.message != null && typeof body.message !== 'string') {
      return refuse(400, 'bad_request', 'message must be text.');
    }
    for (const flag of ['acknowledge', 'close'] as const) {
      if (body[flag] != null && typeof body[flag] !== 'boolean') {
        return refuse(400, 'bad_request', `${flag} must be true or false.`);
      }
    }

    const note = (body.message ?? '').trim();
    const acknowledge = body.acknowledge ?? true;
    const close = body.close === true;

    // What the caller asked for. The reply reports this, so the field means what it always did.
    let asked = 0;
    if (acknowledge) asked |= ACTION_ACKNOWLEDGE;
    if (close) asked |= ACTION_CLOSE;
    if (note) asked |= ACTION_MESSAGE;

    if (asked === 0) {
      return refuse(400, 'bad_request', 'Nothing to do. Supply acknowledge, close, or a message.');
    }

    // Zabbix files the write under the token's owner, so the portal user goes into the text. The tag
    // comes first: a "[portal:...]" typed after it is only text, and the cut to Zabbix's limit keeps it.
    const tag = `[portal:${user}]`;
    const message = (note ? `${tag} ${note}` : tag).slice(0, MAX_MESSAGE);
    const action = asked | ACTION_MESSAGE;
    const sent = { ...trail, eventids, action, close, acknowledge };

    let result: { eventids: string[] } | undefined;
    try {
      result = await zbxWrite<{ eventids: string[] }>('event.acknowledge', { eventids, action, message });
    } catch (err) {
      answered.add(req);
      req.log.warn({ ...sent, err: err instanceof Error ? `${err.name}: ${err.message}` : String(err) }, 'zabbix write-back failed');
      throw err;
    }

    // Without this the change wouldn't surface until the 5s cache expired, and
    // the click would look like it did nothing.
    for (const key of STALE_AFTER_WRITE) invalidate(key, { holdMs: WRITE_HOLD_MS });
    // Live screens get the new list now, not on the stream's next tick.
    void notifyProblemsChanged();

    req.log.info(sent, 'zabbix write-back');

    return { ok: true, eventids: result?.eventids ?? eventids, action: asked };
  });
}
