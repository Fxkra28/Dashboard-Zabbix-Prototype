import type { FastifyRequest } from 'fastify';

/**
 * Log hygiene. EventSource cannot send an Authorization header, so the live
 * stream takes its JWT as `?token=` (auth.ts), and Fastify's request log line
 * printed the URL whole, token included, on every connection. A token in a log
 * file works as a login until it expires.
 */

/** The URL with every `token` query value replaced by `[redacted]`. */
export function redactUrl(url: string): string {
  return url.replace(/([?&]token=)[^&#]*/gi, '$1[redacted]');
}

/**
 * Fastify's default `req` log serializer, field for field, except that the
 * URL goes through `redactUrl`. Auth still reads the real query.
 */
export function serializeRequest(req: FastifyRequest) {
  return {
    method: req.method,
    url: redactUrl(req.url),
    version: req.headers['accept-version'] as string | undefined,
    hostname: req.hostname,
    remoteAddress: req.ip,
    remotePort: req.socket?.remotePort,
  };
}
