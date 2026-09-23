import type { FastifyInstance } from 'fastify';
import { cached } from '../cache.js';
import { config, toSliProfile, type SliProfile } from '../config.js';
import { BadRequestError } from '../validate.js';
import { computeSli, type SliReport } from '../sli/engine.js';
import { currentMonth, monthBounds, parseMonth } from '../sli/time.js';

/**
 * The derived monthly SLA (sli/engine.ts), read-only.
 *
 *   GET /api/sli?month=YYYY-MM&profile=availability|hcml-report
 *
 * A closed month cannot change, so it is cached for a day; the current month
 * moves and is cached for five minutes. A report takes seconds to compute, so
 * for as long again after that the previous one is answered at once while a
 * fresh one is computed in the background.
 */

export function parseProfile(raw: unknown): SliProfile {
  if (raw === undefined || raw === '') return config.sla.defaultProfile;
  const profile = toSliProfile(String(raw));
  if (!profile) throw new BadRequestError('profile must be "availability" or "hcml-report".');
  return profile;
}

/** The report for one calendar month, shared by every caller under one cache key. */
export function getMonthlySli(month: string, profile: SliProfile): Promise<SliReport> {
  const { to } = monthBounds(month, config.sla.timezone);
  const closed = to <= Math.floor(Date.now() / 1000);
  const ttl = closed ? 86_400_000 : 300_000;
  // Keyed by `closed` too: a report computed while the month was still running
  // must not be kept for a day as that month's final figure once it ends.
  const key = `derived-sli:${profile}:${month}:${closed ? 'closed' : 'open'}`;
  return cached(key, ttl, () => computeSli({ month, profile }), { staleMs: ttl, staleIfError: true });
}

export async function sliRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/sli', (req) => {
    const q = req.query as { month?: string; profile?: string };
    const month = q.month ? parseMonth(q.month) : currentMonth(config.sla.timezone);
    return getMonthlySli(month, parseProfile(q.profile));
  });
}
