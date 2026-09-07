import Fastify from 'fastify';
import cors from '@fastify/cors';
import { config, assertConfig } from './config.js';
import { ZabbixAuthError } from './zabbix.js';
import { setupAuth } from './auth.js';
import { hostRoutes } from './routes/hosts.js';
import { problemRoutes } from './routes/problems.js';
import { historyRoutes } from './routes/history.js';
import { netRoutes } from './routes/net.js';
import { streamRoutes } from './routes/stream.js';
import { reportRoutes } from './routes/reports.js';
import { mapRoutes } from './routes/maps.js';

const app = Fastify({ logger: true });

await app.register(cors, { origin: config.webOrigin, credentials: true });

app.get('/api/health', async () => ({ ok: true, ts: Date.now() }));

// A rejected Zabbix token is a config problem, not a server fault — surface it
// as an actionable 503 so the UI can tell the operator exactly what to fix.
app.setErrorHandler((err, _req, reply) => {
  if (err instanceof ZabbixAuthError) {
    app.log.error(err.message);
    return reply.code(503).send({ error: 'zabbix_auth', message: err.message });
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

assertConfig((m) => app.log.warn(m));

try {
  await app.listen({ port: config.port, host: '0.0.0.0' });
  app.log.info(`HCML BFF listening on :${config.port}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
