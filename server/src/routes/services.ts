import type { FastifyInstance } from 'fastify';
import { cached } from '../core/cache.js';
import { config } from '../core/config.js';
import { getDerivedServices } from '../sli/tree.js';
import { currentMonth, parseMonth } from '../sli/time.js';
import { parseProfile } from '../services/sli.js';
import { getServiceTree } from '../services/services.js';

export async function serviceRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/services', () => cached('services:tree', 30_000, getServiceTree));

  // The tree built from the estate itself, for a Zabbix with no services
  // configured (sli/tree.ts). ?month=YYYY-MM&profile=availability|hcml-report
  app.get('/api/services/derived', (req) => {
    const q = req.query as { month?: string; profile?: string };
    const month = q.month ? parseMonth(q.month) : currentMonth(config.sla.timezone);
    return getDerivedServices(month, parseProfile(q.profile));
  });
}
