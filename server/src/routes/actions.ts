import type { FastifyInstance } from 'fastify';
import { zbxWrite } from '../zabbix.js';
import { invalidate } from '../cache.js';
import { config } from '../config.js';
import { notifyProblemsChanged } from './stream.js';

/**
 * Acknowledge / close write-back (plan_1.2 D8): the portal's ONLY write path.
 *
 * Everything else in this BFF is read-only by design (`setup.md` §20).
 * These two routes deliberately break that, so they are fenced three ways:
 *
 *   1. a SEPARATE `ZABBIX_WRITE_TOKEN`: the read token never gains write power
 *   2. `operator` role or above, enforced in auth.ts ROUTE_RULES
 *   3. blank write token ⇒ 503, and the UI hides the buttons entirely
 *
 * Zabbix exposes both actions through one method, `event.acknowledge`, with a
 * bitmask. The bits used here:
 *
 *   1  close problem      2  acknowledge      4  add message
 *
 * Closing only works when the trigger sets `manual_close`; `getProblems()`
 * carries that flag so the UI doesn't offer a button Zabbix will reject.
 */

const ACTION_CLOSE = 1;
const ACTION_ACKNOWLEDGE = 2;
const ACTION_MESSAGE = 4;

/** Zabbix caps acknowledge messages at 2048 characters. */
const MAX_MESSAGE = 2048;

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
  app.post('/api/problems/acknowledge', async (req, reply) => {
    if (!config.zbxWriteToken) {
      return reply.code(503).send({
        error: 'zabbix_write_disabled',
        message: 'Write-back is not configured. Set ZABBIX_WRITE_TOKEN in server/.env.',
      });
    }

    const body = (req.body ?? {}) as AckBody;
    const raw = Array.isArray(body.eventids) ? body.eventids : [body.eventids];
    const eventids = raw.filter((id): id is string => typeof id === 'string' && id.length > 0);

    if (!eventids.length) {
      return reply
        .code(400)
        .send({ error: 'bad_request', message: 'eventids is required — one or more Zabbix event ids.' });
    }
    // Ids go straight into a write against Zabbix; refuse anything that is not one.
    if (eventids.some((id) => !/^\d+$/.test(id))) {
      return reply.code(400).send({ error: 'bad_request', message: 'eventids must be numeric Zabbix event ids.' });
    }

    const message = (body.message ?? '').trim().slice(0, MAX_MESSAGE);
    const acknowledge = body.acknowledge ?? true;
    const close = body.close === true;

    let action = 0;
    if (acknowledge) action |= ACTION_ACKNOWLEDGE;
    if (close) action |= ACTION_CLOSE;
    if (message) action |= ACTION_MESSAGE;

    if (action === 0) {
      return reply.code(400).send({
        error: 'bad_request',
        message: 'Nothing to do — supply acknowledge, close, or a message.',
      });
    }

    const result = await zbxWrite<{ eventids: string[] }>('event.acknowledge', {
      eventids,
      action,
      ...(message ? { message } : {}),
    });

    // Without this the change wouldn't surface until the 5s cache expired, and
    // the click would look like it did nothing.
    for (const key of STALE_AFTER_WRITE) invalidate(key, { holdMs: WRITE_HOLD_MS });
    // Live screens get the new list now, not on the stream's next tick.
    void notifyProblemsChanged();

    app.log.info(
      { eventids, action, close, acknowledge, user: (req.user as { sub?: string })?.sub },
      'zabbix write-back',
    );

    return { ok: true, eventids: result?.eventids ?? eventids, action };
  });
}
