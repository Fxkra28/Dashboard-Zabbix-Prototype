import { AsyncLocalStorage } from 'node:async_hooks';
import type { FastifyInstance } from 'fastify';

/**
 * Says so, in two response headers, when an answer is an old copy kept because Zabbix failed.
 * cache.ts notes it while a request is being served; the hook below adds the headers on the way
 * out. The JSON body is untouched, and a request answered live carries neither header.
 *
 *   X-Data-Stale: true
 *   X-Data-Age-Seconds: <how old the copy is>
 *
 * Request-scoped, not threaded through the callers: the report that went stale is often several
 * calls below the route handler (availability for a month reads the derived SLI, which reads the
 * cache).
 */

export const STALE_HEADER = 'X-Data-Stale';
export const AGE_HEADER = 'X-Data-Age-Seconds';

interface Served {
  /** The oldest copy this request was answered with, in ms; null while every answer was live. */
  oldestMs: number | null;
}

const current = new AsyncLocalStorage<Served>();
const byRequest = new WeakMap<object, Served>();

/** Called by cache.ts when it answers a failed fetch with an old copy. No-op outside a request. */
export function noteStale(ageMs: number): void {
  const served = current.getStore();
  if (served) served.oldestMs = Math.max(served.oldestMs ?? 0, ageMs);
}

/** Register before the routes: a hook applies only to routes added after it. */
export function registerStaleHeaders(app: FastifyInstance): void {
  app.addHook('onRequest', (req, _reply, done) => {
    const served: Served = { oldestMs: null };
    byRequest.set(req, served);
    current.run(served, done);
  });
  app.addHook('onSend', (req, reply, payload, done) => {
    const oldest = byRequest.get(req)?.oldestMs;
    if (oldest !== null && oldest !== undefined) {
      reply.header(STALE_HEADER, 'true');
      reply.header(AGE_HEADER, String(Math.max(0, Math.round(oldest / 1000))));
    }
    done(null, payload);
  });
}
