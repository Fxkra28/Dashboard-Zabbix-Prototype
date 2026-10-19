import type { FastifyInstance } from 'fastify';
import { cached } from '../core/cache.js';
import { getSites } from '../services/sites.js';

export async function siteRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/sites', () => cached('sites', 15_000, getSites));
}
