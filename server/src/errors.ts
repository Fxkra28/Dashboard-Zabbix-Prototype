import type { FastifyInstance } from 'fastify';
import {
  ZabbixApiError,
  ZabbixAuthError,
  ZabbixTimeoutError,
  ZabbixWriteDisabledError,
} from './zabbix.js';
import { AiBusyError, AiDisabledError, AiUpstreamError } from './ai.js';
import { BadRequestError } from './validate.js';

/**
 * Map the BFF's typed failures onto HTTP, in one response shape.
 *
 * Every error body is `{ error, message }`: `error` a stable code a client can
 * branch on, `message` a sentence for whoever is reading the screen. Before
 * this, four shapes were in use, Fastify's `{ statusCode, error, message }`
 * for unknown routes and crashes, a bare sentence in `error` for 400s,
 * `{ error }` alone for 401s, and `{ error, message }` everywhere else.
 *
 * The distinction that matters: a rejected token, an unreachable Zabbix and a
 * missing write token are all *configuration* states, not server faults. Each
 * gets a 503 with a message naming what to fix, because "the portal is broken"
 * and "ZABBIX_WRITE_TOKEN is unset" need very different responses.
 *
 * Lives in its own module so the tests can exercise it against a bare Fastify
 * instance: index.ts starts a listening server on import.
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof BadRequestError) {
      return reply.code(400).send({ error: 'bad_request', message: err.message });
    }
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
      app.log.error(err.message);
      return reply.code(502).send({ error: 'ai_error', message: err.message });
    }

    // Fastify's own client errors (malformed JSON, wrong content type, body too
    // large) and the rate limiter's 429 carry a 4xx status and a message worth
    // showing. Anything else is a bug: log it in full, and do not hand its
    // internal wording to the browser.
    const status = Number((err as { statusCode?: unknown }).statusCode);
    if (status >= 400 && status < 500) {
      const code = (err as { error?: unknown }).error;
      return reply.code(status).send({
        error:
          typeof code === 'string' ? code : typeof err.code === 'string' ? err.code.toLowerCase() : 'bad_request',
        message: err.message,
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
