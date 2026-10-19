import type { FastifyInstance } from 'fastify';
import { cached } from '../core/cache.js';
import { getDevices } from '../services/devices.js';

export async function deviceRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/devices', () => cached('devices', 30_000, getDevices));
}
