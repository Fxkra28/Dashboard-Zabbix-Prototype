import type { FastifyInstance } from 'fastify';
import { cached } from '../cache.js';
import { getProblems } from '../queries.js';

export async function problemRoutes(app: FastifyInstance): Promise<void> {
  // Current problems, host-enriched. Cached 5s (fast-moving).
  app.get('/api/problems', () => cached('problems', 5_000, getProblems));
}
