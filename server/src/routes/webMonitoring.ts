import type { FastifyInstance } from 'fastify';
import { cached } from '../core/cache.js';
import { intParam } from '../core/validate.js';
import { WEB_FAILURES_ROWS, getWebMonitoring } from '../services/webMonitoring.js';

export async function webMonitoringRoutes(app: FastifyInstance): Promise<void> {
  // ?limit= failed scenarios to list, 1 to 50.
  app.get('/api/reports/web-monitoring', (req) => {
    const limit = intParam((req.query as { limit?: string }).limit, WEB_FAILURES_ROWS, 1, 50);
    return cached(`web-monitoring:${limit}`, 30_000, () => getWebMonitoring(limit));
  });
}
