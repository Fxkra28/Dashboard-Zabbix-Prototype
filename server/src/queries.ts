import { zbx } from './zabbix.js';

/** Shared Zabbix queries reused by REST routes and the SSE stream. */

export interface ZbxProblem {
  eventid: string;
  objectid: string;
  object: string; // '0' = trigger
  name: string;
  severity: string; // '0'..'5'
  clock: string;
  r_eventid?: string; // '0' when still open
  r_clock?: string;
  acknowledged: string; // '0' | '1'
  suppressed?: string; // '0' | '1'
  opdata?: string;
  tags?: { tag: string; value: string }[];
  host?: string; // enriched below
  hostid?: string; // enriched below
}

/**
 * problem.get doesn't carry host names, so we enrich: collect the trigger ids,
 * look them up once via trigger.get, and attach host id + name to each problem.
 */
export async function getProblems(): Promise<ZbxProblem[]> {
  const problems = await zbx<ZbxProblem[]>('problem.get', {
    output: 'extend',
    recent: true,
    sortfield: ['eventid'],
    sortorder: 'DESC',
    selectTags: 'extend',
  });

  const triggerIds = [...new Set(problems.filter((p) => p.object === '0').map((p) => p.objectid))];
  const hostByTrigger: Record<string, { hostid: string; name: string }> = {};

  if (triggerIds.length) {
    const triggers = await zbx<{ triggerid: string; hosts?: { hostid: string; name: string }[] }[]>(
      'trigger.get',
      {
        triggerids: triggerIds,
        output: ['triggerid'],
        selectHosts: ['hostid', 'name'],
      },
    );
    for (const t of triggers) {
      const h = t.hosts?.[0];
      if (h) hostByTrigger[t.triggerid] = { hostid: h.hostid, name: h.name };
    }
  }

  return problems.map((p) => {
    const h = hostByTrigger[p.objectid];
    return { ...p, host: h?.name ?? '', hostid: h?.hostid ?? '' };
  });
}
