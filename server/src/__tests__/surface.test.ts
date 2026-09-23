import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { requiredRole } from '../auth.js';
import { toMs } from '../routes/links.js';

vi.mock('../zabbix.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../zabbix.js')>();
  return { ...actual, zbx: vi.fn().mockResolvedValue([]), zbxWrite: vi.fn() };
});

/**
 * The API surface, pinned.
 *
 * Not a style check: the RBAC rules in auth.ts are matched against URL
 * strings, so a route added or renamed without a matching rule silently falls
 * back to `viewer`. This test makes any change to the surface visible in a
 * diff, next to the role each route resolves to.
 */
async function registerAll() {
  // Named explicitly rather than picked out of each module's exports: several
  // modules export helpers alongside their plugin, and registering the wrong
  // one silently produces an empty, passing surface.
  const plugins = await Promise.all([
    import('../routes/hosts.js').then((m) => m.hostRoutes),
    import('../routes/problems.js').then((m) => m.problemRoutes),
    import('../routes/history.js').then((m) => m.historyRoutes),
    import('../routes/net.js').then((m) => m.netRoutes),
    import('../routes/stream.js').then((m) => m.streamRoutes),
    import('../routes/reports.js').then((m) => m.reportRoutes),
    import('../routes/maps.js').then((m) => m.mapRoutes),
    import('../routes/sla.js').then((m) => m.slaRoutes),
    import('../routes/explain.js').then((m) => m.explainRoutes),
    import('../routes/sites.js').then((m) => m.siteRoutes),
    import('../routes/services.js').then((m) => m.serviceRoutes),
    import('../routes/inventory.js').then((m) => m.inventoryRoutes),
    import('../routes/links.js').then((m) => m.linkRoutes),
    import('../routes/analytics.js').then((m) => m.analyticsRoutes),
    import('../routes/actions.js').then((m) => m.actionRoutes),
    import('../routes/chat.js').then((m) => m.chatRoutes),
    import('../routes/sli.js').then((m) => m.sliRoutes),
  ]);

  const app = Fastify({ logger: false });
  const routes: string[] = [];
  app.addHook('onRoute', (r) => {
    const methods = Array.isArray(r.method) ? r.method : [r.method];
    for (const m of methods) {
      if (m === 'HEAD') continue; // Fastify pairs a HEAD with every GET
      routes.push(`${m} ${r.url}`);
    }
  });

  for (const plugin of plugins) await app.register(plugin);
  await app.ready();
  return { app, routes };
}

describe('API surface', () => {
  it('registers exactly the 38 route-module endpoints', async () => {
    // Plus /api/health, POST /api/auth/login and GET /api/auth/me, which live
    // in index.ts and auth.ts, 41 endpoints in total.
    const { app, routes } = await registerAll();
    expect(routes.sort()).toMatchInlineSnapshot(`
      [
        "GET /api/chat/warm",
        "GET /api/explain/problem",
        "GET /api/explain/sla",
        "GET /api/graph",
        "GET /api/history",
        "GET /api/hostgroups",
        "GET /api/hosts",
        "GET /api/hosts/overview",
        "GET /api/items",
        "GET /api/latest",
        "GET /api/links",
        "GET /api/maps",
        "GET /api/maps/detail",
        "GET /api/net/devices",
        "GET /api/net/interfaces",
        "GET /api/net/map",
        "GET /api/net/ports",
        "GET /api/net/status",
        "GET /api/problems",
        "GET /api/reports/aging",
        "GET /api/reports/availability",
        "GET /api/reports/capacity",
        "GET /api/reports/inventory",
        "GET /api/reports/noise",
        "GET /api/reports/problems-by-group",
        "GET /api/reports/top-triggers",
        "GET /api/services",
        "GET /api/services/derived",
        "GET /api/sites",
        "GET /api/sla",
        "GET /api/sla/sli",
        "GET /api/sla/source",
        "GET /api/sli",
        "GET /api/stats",
        "GET /api/stream",
        "GET /api/trend",
        "POST /api/chat",
        "POST /api/problems/acknowledge",
      ]
    `);
    await app.close();
  });

  it('has exactly one endpoint that writes to Zabbix', async () => {
    // The portal is read-only except acknowledge/close (setup.md §20). A new
    // non-GET route appearing here is a design change, not a detail: it is
    // either a Zabbix write (and must then be gated like acknowledge) or,
    // like /api/chat, a POST only because its input (the conversation) travels
    // in the body, and performs no write at all. Both are pinned so neither
    // can drift in unnoticed.
    const { app, routes } = await registerAll();
    expect(routes.filter((r) => !r.startsWith('GET ')).sort()).toEqual([
      'POST /api/chat',
      'POST /api/problems/acknowledge',
    ]);
    await app.close();
  });

  it('gates every privileged route and leaves the rest at viewer', async () => {
    const { app, routes } = await registerAll();
    const byRole = routes.reduce<Record<string, string[]>>((acc, r) => {
      const url = r.split(' ')[1];
      (acc[requiredRole(url)] ??= []).push(url);
      return acc;
    }, {});

    expect(byRole.admin).toEqual(['/api/reports/inventory']);
    expect(byRole.operator?.sort()).toEqual([
      '/api/links',
      '/api/net/devices',
      '/api/net/interfaces',
      '/api/net/map',
      '/api/net/ports',
      '/api/net/status',
      '/api/problems/acknowledge',
    ]);
    await app.close();
  });
});

describe('toMs', () => {
  it('converts seconds to milliseconds without a float tail', () => {
    // The artifact this replaced: (0.0405 - 0.0125) * 1000 = 27.999999999999996
    expect(toMs(0.0405 - 0.0125)).toBe(28);
    expect(toMs(0.0123)).toBe(12.3);
    expect(toMs(0)).toBe(0);
  });

  it('passes undefined through so "no data" stays distinct from zero', () => {
    expect(toMs(undefined)).toBeUndefined();
  });
});
