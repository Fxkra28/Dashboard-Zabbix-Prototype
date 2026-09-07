import type { FastifyInstance, FastifyRequest } from 'fastify';
import jwt from '@fastify/jwt';
import { config } from './config.js';

/**
 * Portal auth + RBAC (plan_1.2 Phase 7, HCML Goal 5 + security).
 *
 * Every source slide in HCML's review is stamped *Private and Confidential*,
 * so an open portal is not deployable. This gates the portal's own routes with
 * a JWT and three roles. The Zabbix token is never exposed either way — RBAC
 * here decides who may see which portal view, not what the BFF may ask Zabbix.
 *
 * The portal is read-only today, so the roles divide by **sensitivity and
 * cost**, not by write access:
 *
 *   viewer    — all monitoring, plus the plain-language "Explain" actions.
 *               The AI layer exists precisely for non-engineers, so gating it
 *               above this role would defeat its purpose.
 *   operator  — + the engineering surfaces (network, links) and, when
 *               acknowledge/close write-back lands, the ability to act.
 *   admin     — + governance (the inventory scorecard) and user-facing config.
 */

export const ROLES = ['viewer', 'operator', 'admin'] as const;
export type Role = (typeof ROLES)[number];

const RANK: Record<Role, number> = { viewer: 1, operator: 2, admin: 3 };

export const isRole = (v: unknown): v is Role => ROLES.includes(v as Role);

/**
 * Minimum role per route, first match wins. Anything unmatched needs `viewer`,
 * so a new route is protected by default rather than accidentally public.
 */
const ROUTE_RULES: { pattern: RegExp; role: Role }[] = [
  { pattern: /^\/api\/reports\/inventory/, role: 'admin' },
  { pattern: /^\/api\/(links|net)\b/, role: 'operator' },
  // Reserved for the acknowledge/close write-back described in plan_1.2.
  { pattern: /^\/api\/problems\/(acknowledge|close)/, role: 'operator' },
];

export function requiredRole(url: string): Role {
  return ROUTE_RULES.find((r) => r.pattern.test(url))?.role ?? 'viewer';
}

export const roleAllows = (has: Role, needs: Role) => RANK[has] >= RANK[needs];

interface PortalUser {
  name: string;
  pass: string;
  role: Role;
}

/**
 * Users come from env — there is no database yet (that phase was deferred).
 * `PORTAL_USERS` is `name:password:role` triples, comma-separated;
 * `PORTAL_USER` / `PORTAL_PASS` remain as the single-admin shorthand.
 */
function loadUsers(warn: (m: string) => void): PortalUser[] {
  const raw = (process.env.PORTAL_USERS ?? '').trim();
  if (!raw) return [{ name: config.auth.user, pass: config.auth.pass, role: 'admin' }];

  const users: PortalUser[] = [];
  for (const entry of raw.split(',')) {
    const [name, pass, role] = entry.split(':').map((s) => s.trim());
    if (!name || !pass) {
      warn(`PORTAL_USERS entry "${entry}" is malformed — expected name:password:role. Skipped.`);
      continue;
    }
    if (role && !isRole(role)) {
      warn(`PORTAL_USERS entry "${name}" has unknown role "${role}" — defaulting to viewer.`);
    }
    users.push({ name, pass, role: isRole(role) ? role : 'viewer' });
  }
  return users.length ? users : [{ name: config.auth.user, pass: config.auth.pass, role: 'admin' }];
}

/** The role attached to a request. With auth off everyone is admin. */
export function roleOf(req: FastifyRequest): Role {
  if (!config.auth.enabled) return 'admin';
  const user = req.user as { role?: unknown } | undefined;
  return isRole(user?.role) ? user.role : 'viewer';
}

export async function setupAuth(app: FastifyInstance): Promise<void> {
  await app.register(jwt, { secret: config.auth.jwtSecret });
  const users = loadUsers((m) => app.log.warn(m));

  app.post('/api/auth/login', async (req, reply) => {
    const { username, password } = (req.body ?? {}) as { username?: string; password?: string };
    const found = users.find((u) => u.name === username && u.pass === password);
    if (!found) return reply.code(401).send({ error: 'Invalid credentials' });

    const token = app.jwt.sign({ sub: found.name, role: found.role }, { expiresIn: '12h' });
    return { token, user: { name: found.name, role: found.role } };
  });

  app.get('/api/auth/me', async (req, reply) => {
    // With auth off the UI still needs a role so it knows what to render.
    if (!config.auth.enabled) {
      return { authEnabled: false, user: { name: 'anonymous', role: 'admin' as Role } };
    }
    try {
      await req.jwtVerify();
      const u = req.user as { sub?: string; role?: unknown };
      return {
        authEnabled: true,
        user: { name: u.sub ?? '', role: isRole(u.role) ? u.role : 'viewer' },
      };
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
    let claims: { role?: unknown };
    try {
      claims = q.token ? ((await app.jwt.verify(q.token)) as { role?: unknown }) : ((await req.jwtVerify()) as { role?: unknown });
    } catch {
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    const has = isRole(claims.role) ? claims.role : 'viewer';
    const needs = requiredRole(url.split('?')[0]);
    if (!roleAllows(has, needs)) {
      return reply.code(403).send({
        error: 'forbidden',
        message: `This view needs the "${needs}" role; you are signed in as "${has}".`,
      });
    }
  });
}
