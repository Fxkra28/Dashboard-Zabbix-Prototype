import type { FastifyInstance } from 'fastify';
import jwt from '@fastify/jwt';
import { config } from './config.js';

/**
 * Optional portal auth (instruct §8). The Zabbix token is never exposed — this
 * only gates the portal's own routes with a JWT.
 *
 * When AUTH_ENABLED=false (default) routes are open so the scaffold runs
 * immediately; the /login route still works if you want to test it.
 *
 * Called with the ROOT Fastify instance so the guard hook applies globally.
 */
export async function setupAuth(app: FastifyInstance): Promise<void> {
  await app.register(jwt, { secret: config.auth.jwtSecret });

  app.post('/api/auth/login', async (req, reply) => {
    const { username, password } = (req.body ?? {}) as { username?: string; password?: string };
    if (username === config.auth.user && password === config.auth.pass) {
      const token = app.jwt.sign({ sub: username, role: 'viewer' }, { expiresIn: '12h' });
      return { token, user: { name: username, role: 'viewer' } };
    }
    return reply.code(401).send({ error: 'Invalid credentials' });
  });

  app.get('/api/auth/me', async (req, reply) => {
    if (!config.auth.enabled) return { authEnabled: false, user: null };
    try {
      await req.jwtVerify();
      return { authEnabled: true, user: req.user };
    } catch {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
  });

  if (!config.auth.enabled) return;

  // Guard every /api/* route except health and the auth endpoints. EventSource
  // can't set headers, so the SSE route accepts the token via ?token=.
  app.addHook('onRequest', async (req, reply) => {
    const url = req.raw.url ?? '';
    if (!url.startsWith('/api/')) return;
    if (url.startsWith('/api/auth/') || url.startsWith('/api/health')) return;

    const q = (req.query ?? {}) as { token?: string };
    try {
      if (q.token) await app.jwt.verify(q.token);
      else await req.jwtVerify();
    } catch {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
  });
}
