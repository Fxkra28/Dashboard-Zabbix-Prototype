import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { config, assertConfig } from './config.js';
import { registerErrorHandler } from './errors.js';
import { registerCompression } from './compress.js';
import { setCacheLogger } from './cache.js';
import { serializeRequest } from './logging.js';
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
import { chatRoutes } from './routes/chat.js';
import { warmModel } from './ai.js';
import { sliRoutes } from './routes/sli.js';

const app = Fastify({
  // Fastify's own request log line, except that the `?token=` the live stream
  // authenticates with is redacted (logging.ts).
  logger: { level: 'info', serializers: { req: serializeRequest } },
  trustProxy: config.trustProxy,
});

// A slow report answered from an old copy because Zabbix failed is logged,
// not silent (cache.ts).
setCacheLogger(app.log);

// Fail fast on config that is unsafe rather than merely incomplete: better a
// clear refusal at boot than a portal that looks healthy and isn't.
try {
  assertConfig((m) => app.log.warn(m));
} catch (err) {
  app.log.error(err instanceof Error ? err.message : err);
  process.exit(1);
}

// Security headers. `contentSecurityPolicy` is off because this process serves
// JSON only: nginx serves the app, and a CSP here would describe a document
// that never exists while doing nothing for the API.
await app.register(helmet, { contentSecurityPolicy: false });

await app.register(cors, { origin: config.webOrigin, credentials: true });

/**
 * Rate limiting, registered before the auth guard so a flood is rejected
 * before the server spends work verifying JWTs on it. The target that matters
 * is POST /api/auth/login, which is otherwise an unthrottled password oracle.
 *
 * SSE and health are exempt: /api/stream holds one long-lived connection per
 * NOC screen rather than making repeated requests, and /api/health is polled
 * deliberately by every page and by container health checks.
 */
await app.register(rateLimit, {
  max: config.rateLimitPerMinute,
  timeWindow: '1 minute',
  allowList: (req) => {
    const url = (req.raw.url ?? '').split('?')[0];
    return url === '/api/stream' || url === '/api/health';
  },
  // The plugin throws what this returns, so it passes through the error
  // handler: `statusCode` is what keeps it a 429 there rather than a 500.
  errorResponseBuilder: (_req, ctx) => ({
    statusCode: 429,
    error: 'rate_limited',
    message: `Too many requests — the limit is ${ctx.max} per minute. Retry in ${ctx.after}.`,
  }),
});

// Brotli/gzip for JSON bodies (compress.ts). Before every route: a hook only
// reaches the routes registered after it.
registerCompression(app);

// `ai` and `writeBack` let the UI hide actions that aren't configured, instead
// of offering a button that can only fail.
app.get('/api/health', async () => ({
  ok: true,
  ts: Date.now(),
  ai: config.ai.enabled,
  writeBack: Boolean(config.zbxWriteToken),
  // Server-owned defaults the UI should agree with rather than restate. The
  // availability floor in particular is site-specific, HCML alarms at 2,
  // and a hardcoded client default would silently disagree with the server.
  defaults: {
    availabilityMinSeverity: config.reports.availabilityMinSeverity,
  },
}));

registerErrorHandler(app);

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
await app.register(chatRoutes);
await app.register(sliRoutes);

try {
  await app.listen({ port: config.port, host: config.host });
  app.log.info(`HCML BFF listening on ${config.host}:${config.port}`);
  void warmModel(app.log); // load the local model now, not on the first question
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
