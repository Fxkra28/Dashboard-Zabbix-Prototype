import type { FastifyInstance } from 'fastify';
import { cached } from '../core/cache.js';
import { getLinks } from '../services/links.js';

export async function linkRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/links', () => cached('links', 20_000, getLinks));
}
