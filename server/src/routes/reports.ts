import type { FastifyInstance } from 'fastify';
import { zbx } from '../zabbix.js';
import { cached } from '../cache.js';
import { getProblems } from '../queries.js';

/** One page of event history. Bounds the read and flags when it was hit. */
const EVENT_LIMIT = 10_000;

export async function reportRoutes(app: FastifyInstance): Promise<void> {
  // Reports → Top 100 triggers: count problem events per trigger over a window.
  // The window is clamped and the fetch bounded — against real event history a
  // 20k unbounded read is slow and grows without limit (plan_1.2 defect #4).
  app.get('/api/reports/top-triggers', (req) => {
    const days = Math.min(Math.max(Number((req.query as { days?: string }).days ?? 7), 1), 365);
    const from = Math.floor(Date.now() / 1000) - days * 86400;
    return cached(`toptrig:${days}`, 60_000, async () => {
      const events = await zbx<
        {
          objectid: string;
          name: string;
          severity: string;
          hosts?: { hostid: string; name: string }[];
        }[]
      >('event.get', {
        source: 0, // triggers
        object: 0,
        value: 1, // PROBLEM events only
        time_from: from,
        output: ['objectid', 'name', 'severity'],
        selectHosts: ['hostid', 'name'],
        sortfield: ['clock'],
        sortorder: 'DESC',
        limit: EVENT_LIMIT,
      });

      const map: Record<
        string,
        { objectid: string; name: string; severity: string; host: string; count: number }
      > = {};
      for (const e of events) {
        const m = (map[e.objectid] ??= {
          objectid: e.objectid,
          name: e.name,
          severity: e.severity,
          host: e.hosts?.[0]?.name ?? '',
          count: 0,
        });
        m.count++;
      }
      const top = Object.values(map)
        .sort((a, b) => b.count - a.count)
        .slice(0, 100);

      // Say so when the window was busier than one page — otherwise the counts
      // silently understate and look authoritative.
      return { triggers: top, truncated: events.length >= EVENT_LIMIT, days };
    });
  });

  // Reports → System information: high-level counts for the dashboard.
  app.get('/api/stats', () =>
    cached('stats', 30_000, async () => {
      const [hosts, items, triggers, groups, problems] = await Promise.all([
        zbx<string>('host.get', { countOutput: true }),
        zbx<string>('item.get', { countOutput: true, monitored: true }),
        zbx<string>('trigger.get', { countOutput: true }),
        zbx<string>('hostgroup.get', { countOutput: true, real_hosts: true }),
        getProblems(),
      ]);

      const bySeverity: Record<string, number> = {};
      for (const p of problems) bySeverity[p.severity] = (bySeverity[p.severity] ?? 0) + 1;

      return {
        hosts: Number(hosts),
        items: Number(items),
        triggers: Number(triggers),
        groups: Number(groups),
        problems: problems.length,
        unacknowledged: problems.filter((p) => p.acknowledged !== '1').length,
        bySeverity,
      };
    }),
  );

  // Dashboard widget: problem severity breakdown per host group.
  app.get('/api/reports/problems-by-group', () =>
    cached('probsByGroup', 15_000, async () => {
      const [groups, problems] = await Promise.all([
        zbx<{ groupid: string; name: string; hosts?: { hostid: string }[] }[]>('hostgroup.get', {
          output: ['groupid', 'name'],
          selectHosts: ['hostid'],
          real_hosts: true,
          sortfield: 'name',
        }),
        getProblems(),
      ]);

      const sevByHost: Record<string, string[]> = {};
      for (const p of problems) {
        if (!p.hostid) continue;
        (sevByHost[p.hostid] ??= []).push(p.severity);
      }

      return groups
        .map((g) => {
          const bySeverity: Record<string, number> = {};
          let total = 0;
          for (const h of g.hosts ?? []) {
            for (const sev of sevByHost[h.hostid] ?? []) {
              bySeverity[sev] = (bySeverity[sev] ?? 0) + 1;
              total++;
            }
          }
          return { groupid: g.groupid, name: g.name, total, bySeverity };
        })
        .filter((g) => g.total > 0)
        .sort((a, b) => b.total - a.total);
    }),
  );
}
