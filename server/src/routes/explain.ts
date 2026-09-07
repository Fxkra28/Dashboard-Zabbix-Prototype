import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { cached } from '../cache.js';
import { humanize } from '../claude.js';
import { getProblems } from '../queries.js';
import { getSlas, getSli } from './sla.js';

/**
 * The plain-language layer (plan_1.1). On-demand only: nothing here runs until
 * someone clicks "Explain", and every answer is cached so repeat clicks — and
 * every other NOC screen showing the same problem — are free.
 */
export async function explainRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Tags *and* notification wording for one problem. The trigger name plus
   * opdata is the notification text as the team receives it, so one call
   * covers both. A given problem's meaning doesn't change — cache for an hour.
   */
  app.get('/api/explain/problem', async (req, reply) => {
    if (!config.ai.enabled) {
      return reply.code(503).send({ error: 'ai_disabled', message: 'AI not configured' });
    }

    const { eventid } = req.query as { eventid?: string };
    if (!eventid) return reply.code(400).send({ error: 'eventid is required' });

    const problem = (await cached('problems', 5_000, getProblems)).find(
      (p) => p.eventid === eventid,
    );
    if (!problem) return reply.code(404).send({ error: 'No current problem with that eventid' });

    return cached(`explain:problem:${eventid}`, 3_600_000, () =>
      humanize('problem', {
        host: problem.host,
        notification: problem.name,
        opdata: problem.opdata || null,
        severity: SEVERITY_NAMES[problem.severity] ?? problem.severity,
        started: new Date(Number(problem.clock) * 1000).toISOString(),
        acknowledged: problem.acknowledged === '1',
        resolved: Boolean(problem.r_eventid && problem.r_eventid !== '0'),
        tags: problem.tags ?? [],
      }),
    );
  });

  /** One SLA's current-period standing, in plain language. */
  app.get('/api/explain/sla', async (req, reply) => {
    if (!config.ai.enabled) {
      return reply.code(503).send({ error: 'ai_disabled', message: 'AI not configured' });
    }

    const { slaid, serviceid } = req.query as { slaid?: string; serviceid?: string };
    if (!slaid) return reply.code(400).send({ error: 'slaid is required' });

    const sla = (await cached('sla', 60_000, getSlas)).find((s) => s.slaid === slaid);
    if (!sla) return reply.code(404).send({ error: 'No SLA with that slaid' });

    const sli = await cached(`sli:${slaid}:${serviceid ?? 'all'}`, 60_000, () =>
      getSli(slaid, serviceid),
    );

    // Shorter TTL than problems: the SLI moves as the period progresses.
    return cached(`explain:sla:${slaid}:${serviceid ?? 'all'}`, 300_000, () =>
      humanize('sla', {
        sla: sla.name,
        slo_target_percent: Number(sla.slo),
        reporting_period: SLA_PERIODS[sla.period] ?? sla.period,
        services: sli.map((s) => ({
          service: s.name,
          achieved_percent: s.sli,
          uptime_minutes: Math.round(s.uptime / 60),
          downtime_minutes: Math.round(s.downtime / 60),
          error_budget_minutes_left: Math.round(s.error_budget / 60),
        })),
      }),
    );
  });
}

const SEVERITY_NAMES: Record<string, string> = {
  '0': 'Not classified',
  '1': 'Information',
  '2': 'Warning',
  '3': 'Average',
  '4': 'High',
  '5': 'Disaster',
};

const SLA_PERIODS: Record<string, string> = {
  '0': 'daily',
  '1': 'weekly',
  '2': 'monthly',
  '3': 'quarterly',
  '4': 'annually',
};
