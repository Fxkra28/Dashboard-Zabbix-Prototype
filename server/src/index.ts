import Fastify from 'fastify';
import cors from '@fastify/cors';
import { config, assertConfig } from './config.js';
import { ZabbixAuthError, ZabbixWriteDisabledError } from './zabbix.js';
import { AiDisabledError, AiUpstreamError } from './claude.js';
import { setupAuth } from './auth.js';
import { hostRoutes } from './routes/hosts.js';
import { problemRoutes } from './routes/problems.js';
import { historyRoutes } from './routes/history.js';
import { netRoutes } from './routes/net.js';
import { streamRoutes } from './routes/stream.js';
import { reportRoutes } from './routes/reports.js';
import { mapRoutes } from './routes/maps.js';
import { slaRoutes } from './routes/sla.js';
import { explainRoutes } from './routes/explain.js';
import { siteRoutes } from './routes/sites.js';
import { serviceRoutes } from './routes/services.js';
import { inventoryRoutes } from './routes/inventory.js';
import { linkRoutes } from './routes/links.js';
import { analyticsRoutes } from './routes/analytics.js';
import { actionRoutes } from './routes/actions.js';

const app = Fastify({ logger: true });

await app.register(cors, { origin: config.webOrigin, credentials: true });

// `ai` and `writeBack` let the UI hide actions that aren't configured, instead
// of offering a button that can only fail.
app.get('/api/health', async () => ({
  ok: true,
  ts: Date.now(),
  ai: config.ai.enabled,
  writeBack: Boolean(config.zbxWriteToken),
}));

// A rejected Zabbix token is a config problem, not a server fault — surface it
// as an actionable 503 so the UI can tell the operator exactly what to fix.
app.setErrorHandler((err, _req, reply) => {
  if (err instanceof ZabbixAuthError) {
    app.log.error(err.message);
    return reply.code(503).send({ error: 'zabbix_auth', message: err.message });
  }
  // The AI layer is optional garnish — when it fails, say so plainly and leave
  // the rest of the portal alone.
  if (err instanceof ZabbixWriteDisabledError) {
    return reply.code(503).send({ error: 'zabbix_write_disabled', message: err.message });
  }
  if (err instanceof AiDisabledError) {
    return reply.code(503).send({ error: 'ai_disabled', message: err.message });
  }
  if (err instanceof AiUpstreamError) {
    app.log.error(err.message);
    return reply.code(502).send({ error: 'ai_error', message: err.message });
  }
  app.log.error(err);
  return reply.send(err);
});

// Auth first so its onRequest guard covers the routes registered after it.
await setupAuth(app);

await app.register(hostRoutes);
await app.register(problemRoutes);
await app.register(historyRoutes);
await app.register(netRoutes);
await app.register(streamRoutes);
await app.register(reportRoutes);
await app.register(mapRoutes);
await app.register(slaRoutes);
await app.register(explainRoutes);
await app.register(siteRoutes);
await app.register(serviceRoutes);
await app.register(inventoryRoutes);
await app.register(linkRoutes);
await app.register(analyticsRoutes);
await app.register(actionRoutes);

assertConfig((m) => app.log.warn(m));

try {
  await app.listen({ port: config.port, host: '0.0.0.0' });
  app.log.info(`HCML BFF listening on :${config.port}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
