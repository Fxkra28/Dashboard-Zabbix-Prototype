import { zbx } from '../clients/zabbix.js';
import { cached } from '../core/cache.js';
import { getProblems, openProblems } from '../domain/queries.js';
import { collectingStatus, getLastCollected } from '../domain/reachability.js';

/** One page of event history. Bounds the read and flags when it was hit. */
const EVENT_LIMIT = 10_000;

/**
 * Reports → Top 100 triggers: count problem events per trigger over a window.
 * The window is clamped by the caller and the fetch bounded, against real event history a
 * 20k unbounded read is slow and grows without limit.
 */
export function getTopTriggers(days: number) {
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

    // Say so when the window was busier than one page, otherwise the counts
    // silently understate and look authoritative.
    return { triggers: top, truncated: events.length >= EVENT_LIMIT, days };
  });
}

/** Reports → System information: high-level counts for the dashboard. */
export function getStats() {
  return cached('stats', 30_000, async () => {
    const [hosts, items, triggers, groups, problems] = await Promise.all([
      // Monitored only, on all three cards: disabled hosts are left out, and so are templates' triggers, which watch no host.
      zbx<string>('host.get', { countOutput: true, monitored_hosts: true }),
      zbx<string>('item.get', { countOutput: true, monitored: true }),
      zbx<string>('trigger.get', { countOutput: true, monitored: true }),
      // `with_hosts`: its older name was deprecated in Zabbix 6.2.
      zbx<string>('hostgroup.get', { countOutput: true, with_hosts: true }),
      // The entry /api/problems and the stream already share, not another read.
      cached('problems', 5_000, getProblems).then(openProblems),
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
  });
}

/** When Zabbix last collected a value, so the Dashboard can say it has stopped (reachability.ts). */
export async function getFreshness() {
  return collectingStatus(await getLastCollected(), Math.floor(Date.now() / 1000));
}

/** Dashboard widget: problem severity breakdown per host group. */
export function getProblemsByGroup() {
  return cached('probsByGroup', 15_000, async () => {
    const [groups, problems] = await Promise.all([
      zbx<{ groupid: string; name: string; hosts?: { hostid: string }[] }[]>('hostgroup.get', {
        output: ['groupid', 'name'],
        selectHosts: ['hostid'],
        with_hosts: true,
        sortfield: 'name',
      }),
      cached('problems', 5_000, getProblems).then(openProblems),
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
  });
}
