import type { FastifyInstance } from 'fastify';
import { getProblems } from '../queries.js';
import { cached } from '../cache.js';

/**
 * Live problems via SSE (instruct §6). Pushes the current problem list every
 * 5s plus a keep-alive comment. Upgrade to WebSocket / Redis fan-out later.
 */
export async function streamRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/stream', (req, reply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // let nginx pass SSE straight through
    });

    let closed = false;
    const send = (event: string, data: unknown) => {
      if (!closed) reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    // Share the same cache key as GET /api/problems: N connected NOC screens all
    // read one cached result instead of each polling Zabbix every 5s.
    const tick = async () => {
      try {
        send('problems', await cached('problems', 5_000, getProblems));
      } catch (err) {
        send('error', { message: String(err) });
      }
    };

    const iv = setInterval(tick, 5_000);
    const hb = setInterval(() => {
      if (!closed) reply.raw.write(': keep-alive\n\n');
    }, 15_000);
    void tick();

    req.raw.on('close', () => {
      closed = true;
      clearInterval(iv);
      clearInterval(hb);
    });
  });
}
