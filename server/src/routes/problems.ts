import type { FastifyInstance } from 'fastify';
import { cached } from '../core/cache.js';
import { getProblems } from '../domain/queries.js';

export async function problemRoutes(app: FastifyInstance): Promise<void> {
  // Current problems, host-enriched. Cached 5s (fast-moving).
  app.get('/api/problems', () => cached('problems', 5_000, getProblems));
}
