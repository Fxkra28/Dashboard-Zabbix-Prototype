import type { FastifyInstance } from 'fastify';
import { intParam } from '../core/validate.js';
import { getFreshness, getProblemsByGroup, getStats, getTopTriggers } from '../services/reports.js';

export async function reportRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/reports/top-triggers', (req) =>
    getTopTriggers(intParam((req.query as { days?: string }).days, 7, 1, 365)),
  );
  app.get('/api/stats', () => getStats());
  app.get('/api/freshness', () => getFreshness());
  app.get('/api/reports/problems-by-group', () => getProblemsByGroup());
}
