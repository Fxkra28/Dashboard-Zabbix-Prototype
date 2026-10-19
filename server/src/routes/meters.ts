import type { FastifyInstance } from 'fastify';
import { cached } from '../core/cache.js';
import { getMeters } from '../services/meters.js';

export async function meterRoutes(app: FastifyInstance): Promise<void> {
  // /api/net: operator and up (auth.ts).
  app.get('/api/net/meters', () => cached('net:meters', 30_000, getMeters));
}
