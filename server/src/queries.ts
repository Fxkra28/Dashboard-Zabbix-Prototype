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
  /** Whether the trigger permits manual close, gates the Close button (§20). */
  manualClose?: boolean;
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
  const byTrigger: Record<string, { hostid: string; name: string; manualClose: boolean }> = {};

  if (triggerIds.length) {
    // `manual_close` rides along on the call we already make, no extra request.
    const triggers = await zbx<
      {
        triggerid: string;
        manual_close?: string;
        hosts?: { hostid: string; name: string }[];
      }[]
    >('trigger.get', {
      triggerids: triggerIds,
      output: ['triggerid', 'manual_close'],
      selectHosts: ['hostid', 'name'],
    });
    for (const t of triggers) {
      const h = t.hosts?.[0];
      if (h) {
        byTrigger[t.triggerid] = {
          hostid: h.hostid,
          name: h.name,
          manualClose: t.manual_close === '1',
        };
      }
    }
  }

  return problems.map((p) => {
    const t = byTrigger[p.objectid];
    return {
      ...p,
      host: t?.name ?? '',
      hostid: t?.hostid ?? '',
      manualClose: t?.manualClose ?? false,
    };
  });
}

/**
 * A host with everything the governance-facing views need: groups, tags and
 * the inventory fields that carry site and owner.
 *
 * Zabbix has no `site_name` inventory field, `site_city` and `location` are
 * the real ones, and asking for a field that doesn't exist is silently ignored.
 */
export interface ZHostMeta {
  hostid: string;
  name: string;
  status: string;
  maintenance_status?: string;
  description?: string;
  interfaces?: { ip: string; type?: string; available?: string }[];
  hostgroups?: { groupid: string; name: string }[];
  tags?: { tag: string; value: string }[];
  inventory?:
    | {
        site_city?: string;
        location?: string;
        poc_1_name?: string;
        poc_1_email?: string;
        notes?: string;
      }
    | [];
}

/**
 * Shared by the Sites board and the inventory scorecard, both need the same
 * enriched host list, so they share one cache entry rather than each paying
 * for their own `host.get`.
 */
export async function getHostsWithMeta(): Promise<ZHostMeta[]> {
  return zbx<ZHostMeta[]>('host.get', {
    output: ['hostid', 'name', 'status', 'maintenance_status', 'description'],
    selectInterfaces: ['ip', 'type', 'available'],
    selectHostGroups: ['groupid', 'name'],
    selectTags: 'extend',
    selectInventory: ['site_city', 'location', 'poc_1_name', 'poc_1_email', 'notes'],
    sortfield: 'name',
  });
}

/** Zabbix trigger severities, as the UI and the plain-language layer name them. */
export const SEVERITY_NAMES: Record<string, string> = {
  '0': 'Not classified',
  '1': 'Information',
  '2': 'Warning',
  '3': 'Average',
  '4': 'High',
  '5': 'Disaster',
};
