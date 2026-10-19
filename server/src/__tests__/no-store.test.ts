import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import helmet from '@fastify/helmet';
import { registerNoStore } from '../http/noStore.js';

/** Signed-in replies tell a browser and a proxy to keep nothing. */

async function appWithRoutes() {
  const app = Fastify({ logger: false });
  registerNoStore(app);
  app.get('/api/problems', async () => ({ ok: true }));
  app.get('/api/health', async () => ({ ok: true }));
  app.get('/api/sli/export', async (_req, reply) => reply.header('Cache-Control', 'private, no-store').send('x'));
  app.get('/api/stream', async (_req, reply) => reply.header('Cache-Control', 'no-cache').send('x'));
  app.get('/elsewhere', async () => ({ ok: true }));
  app.get('/api/boom', async () => {
    throw new Error('boom');
  });
  await app.ready();
  return app;
}

describe('Cache-Control on /api replies', () => {
  it('sets no-store on a normal reply, with a query string too', async () => {
    const app = await appWithRoutes();
    expect((await app.inject({ url: '/api/problems' })).headers['cache-control']).toBe('no-store');
    expect((await app.inject({ url: '/api/problems?days=7' })).headers['cache-control']).toBe('no-store');
  });

  it('sets it on an error reply as well', async () => {
    const app = await appWithRoutes();
    const res = await app.inject({ url: '/api/boom' });
    expect(res.statusCode).toBe(500);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('leaves the public health check alone', async () => {
    const app = await appWithRoutes();
    expect((await app.inject({ url: '/api/health' })).headers['cache-control']).toBeUndefined();
    expect((await app.inject({ url: '/api/health?x=1' })).headers['cache-control']).toBeUndefined();
  });

  it('keeps a value the route chose', async () => {
    const app = await appWithRoutes();
    expect((await app.inject({ url: '/api/sli/export' })).headers['cache-control']).toBe('private, no-store');
    expect((await app.inject({ url: '/api/stream' })).headers['cache-control']).toBe('no-cache');
  });

  it('does not touch a path outside /api', async () => {
    const app = await appWithRoutes();
    expect((await app.inject({ url: '/elsewhere' })).headers['cache-control']).toBeUndefined();
  });
});

describe('wiring in index.ts', () => {
  const read = async () => {
    const { readFile } = await import('node:fs/promises');
    return readFile(new URL('../index.ts', import.meta.url), 'utf8');
  };

  it('registers the hook before the guard and the routes', async () => {
    const index = await read();
    const hook = index.indexOf('registerNoStore(app)');
    expect(hook).toBeGreaterThan(-1);
    expect(hook).toBeLessThan(index.indexOf('await setupAuth(app)'));
    expect(hook).toBeLessThan(index.indexOf('await app.register(hostRoutes)'));
  });

  it('turns HSTS off in helmet, because the portal is served over plain HTTP', async () => {
    expect(await read()).toMatch(/await app\.register\(helmet, \{[^}]*hsts: false[^}]*\}\)/);
    const off = Fastify({ logger: false });
    await off.register(helmet, { contentSecurityPolicy: false, hsts: false });
    off.get('/api/x', async () => ({}));
    expect((await off.inject({ url: '/api/x' })).headers['strict-transport-security']).toBeUndefined();
    const on = Fastify({ logger: false });
    await on.register(helmet, { contentSecurityPolicy: false });
    on.get('/api/x', async () => ({}));
    expect((await on.inject({ url: '/api/x' })).headers['strict-transport-security']).toBeDefined();
  });
});
