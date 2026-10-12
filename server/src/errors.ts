import type { FastifyInstance } from 'fastify';
import {
  ZabbixApiError,
  ZabbixAuthError,
  ZabbixTimeoutError,
  ZabbixWriteDisabledError,
} from './zabbix.js';
import { AiBusyError, AiDisabledError, AiUpstreamError } from './ai.js';
import { BadRequestError } from './validate.js';
import { validationProblem } from './schemas.js';

/**
 * Map the BFF's typed failures onto HTTP, in one response shape.
 *
 * Every error body is `{ error, message }`: `error` a stable code a client can branch on, `message`
 * a sentence for whoever is reading the screen.
 *
 * The distinction that matters: a rejected token, an unreachable Zabbix and a missing write token
 * are all *configuration* states, not server faults. Each gets a 503 with a message naming what to
 * fix, because "the portal is broken" and "ZABBIX_WRITE_TOKEN is unset" need very different
 * responses.
 *
 * Lives in its own module so the tests can exercise it against a bare Fastify instance: index.ts
 * starts a listening server on import.
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof BadRequestError) {
      return reply.code(400).send({ error: 'bad_request', message: err.message });
    }
    // A body schema (schemas.ts) refused the request: the same 400 as the handlers' own checks.
    const invalid = validationProblem(err);
    if (invalid) return reply.code(400).send({ error: 'bad_request', message: invalid });
    if (err instanceof ZabbixAuthError) {
      app.log.error(err.message);
      return reply.code(503).send({ error: 'zabbix_auth', message: err.message });
    }
    // `detail` names ZBX_URL and what Zabbix sent back: the log gets it, the
    // response body never does.
    if (err instanceof ZabbixTimeoutError) {
      app.log.error({ detail: err.detail }, err.message);
      return reply.code(503).send({ error: 'zabbix_timeout', message: err.message });
    }
    if (err instanceof ZabbixWriteDisabledError) {
      return reply.code(503).send({ error: 'zabbix_write_disabled', message: err.message });
    }
    if (err instanceof ZabbixApiError) {
      app.log.error({ detail: err.detail }, err.message);
      return reply.code(502).send({ error: 'zabbix_error', message: err.message });
    }
    // The AI layer is optional garnish: when it fails, say so plainly and
    // leave the rest of the portal alone.
    if (err instanceof AiDisabledError) {
      return reply.code(503).send({ error: 'ai_disabled', message: err.message });
    }
    if (err instanceof AiBusyError) {
      // One local model, one answer at a time: expected under load, not a fault.
      return reply.code(503).header('retry-after', '10').send({ error: 'ai_busy', message: err.message });
    }
    if (err instanceof AiUpstreamError) {
      // `detail` names the model address and what it sent back: the log gets it, the response never does.
      app.log.error({ detail: err.detail }, err.message);
      return reply.code(502).send({ error: 'ai_error', message: err.message });
    }

    // Fastify's own client errors (malformed JSON, wrong content type, body too
    // large) and the rate limiter's 429 carry a 4xx status and a message worth
    // showing. Anything else is a bug: log it in full, and do not hand its
    // internal wording to the browser.
    // Fastify 5 types `err` as unknown (anything can be thrown), so read each field defensively.
    const e = (err ?? {}) as { statusCode?: unknown; error?: unknown; code?: unknown; message?: unknown };
    const status = Number(e.statusCode);
    if (status >= 400 && status < 500) {
      return reply.code(status).send({
        error:
          typeof e.error === 'string' ? e.error : typeof e.code === 'string' ? e.code.toLowerCase() : 'bad_request',
        message: e.message,
      });
    }
    app.log.error(err);
    return reply
      .code(500)
      .send({ error: 'internal', message: 'The portal hit an unexpected error. Details are in the BFF log.' });
  });

  app.setNotFoundHandler((req, reply) =>
    reply
      .code(404)
      .send({ error: 'not_found', message: `No such endpoint: ${req.method} ${req.url.split('?')[0]}` }),
  );
}
