import type { FastifyInstance } from 'fastify';
import { useLogger, refusalFor, subscribe, endStreams, ownerOf, msUntilExpiry } from '../services/stream.js';

export async function streamRoutes(app: FastifyInstance): Promise<void> {
  useLogger(app.log);
  // close() waits for open connections, and a stream never ends by itself.
  app.addHook('preClose', async () => {
    endStreams();
  });

  app.get('/api/stream', (req, reply) => {
    const refusal = refusalFor(ownerOf(req));
    if (refusal) {
      req.log.warn('live stream refused: connection limit reached');
      return reply.code(429).header('retry-after', '30').send({ error: 'too_many_streams', message: refusal });
    }

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // let nginx pass SSE straight through
      'X-Request-Id': req.id, // writeHead bypasses the reply headers requestId.ts sets
    });

    const unsubscribe = subscribe(reply.raw, ownerOf(req));
    // A token is checked when the stream opens only. Ending the stream when it
    // expires makes the browser reconnect with the renewed cookie, or be sent to sign in.
    const left = msUntilExpiry(req);
    const expiry = left === null ? null : setTimeout(() => reply.raw.end(), left);
    expiry?.unref?.();
    const gone = () => {
      if (expiry) clearTimeout(expiry);
      unsubscribe();
    };
    req.raw.on('close', gone);
    reply.raw.on('close', gone);
  });
}
