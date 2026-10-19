import type { FastifyInstance } from 'fastify';

/**
 * `Cache-Control: no-store` on every `/api` reply, so a browser or proxy on a shared NOC workstation keeps no copy of signed-in data.
 * Left as they are: the public health check, a reply that chose its own value (the SLA download, the two streams), and anything outside `/api`.
 */

const PUBLIC_PATHS = new Set(['/api/health']);

export function registerNoStore(app: FastifyInstance): void {
  app.addHook('onSend', (req, reply, payload, done) => {
    const path = req.url.split('?', 1)[0] ?? '';
    if (path.startsWith('/api/') && !PUBLIC_PATHS.has(path) && !reply.hasHeader('cache-control')) {
      reply.header('cache-control', 'no-store');
    }
    done(null, payload);
  });
}
