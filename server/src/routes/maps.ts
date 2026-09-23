import type { FastifyInstance } from 'fastify';
import { zbx } from '../zabbix.js';
import { cached } from '../cache.js';
import { requireId } from '../validate.js';
import { getProblems } from '../queries.js';

interface ZSelement {
  selementid: string;
  elementtype: string; // '0' host, '1' map, '2' trigger, '3' host group, '4' image
  label?: string;
  elements?: { hostid?: string }[];
  [key: string]: unknown;
}

interface ZMapDetail {
  selements?: ZSelement[];
  [key: string]: unknown;
}

export interface ZMapHost {
  hostid: string;
  host: string;
  name: string;
  interfaces?: { ip: string; dns: string; useip: string; main: string }[];
}

/**
 * Expand the host macros Zabbix map labels are written in.
 *
 * HCML labels every host element `{HOSTNAME} ({HOST.IP})`. Zabbix fills those
 * in when it draws the map; the API returns them raw. Stripping them, what the
 * page used to do, left every box labelled "()". Unknown macros are still
 * dropped, and a pair of brackets left empty by a missing value goes with them.
 */
export function resolveLabel(label: string, host?: ZMapHost): string {
  const iface = host?.interfaces?.find((i) => i.main === '1') ?? host?.interfaces?.[0];
  const values: Record<string, string | undefined> = {
    '{HOST.NAME}': host?.name,
    '{HOSTNAME}': host?.name,
    '{HOST.HOST}': host?.host,
    '{HOST.IP}': iface?.ip,
    '{IPADDRESS}': iface?.ip,
    '{HOST.DNS}': iface?.dns,
    '{HOST.CONN}': iface ? (iface.useip === '1' ? iface.ip : iface.dns) : undefined,
  };
  return label
    .replace(/\{[^{}]*\}/g, (macro) => values[macro] ?? '')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.replace(/\(\s*\)/g, '').trim())
    .filter(Boolean)
    .join('\n');
}

export async function mapRoutes(app: FastifyInstance): Promise<void> {
  // Monitoring → Maps: list available network maps.
  app.get('/api/maps', () =>
    cached('maps', 60_000, () =>
      zbx('map.get', { output: ['sysmapid', 'name', 'width', 'height'] }),
    ),
  );

  // One map with its elements + links (topology).  ?mapid=
  // Host elements come back with their label resolved and the host's current
  // problem count and worst severity, so the page can colour them.
  app.get('/api/maps/detail', async (req) => {
    const mapid = requireId((req.query as { mapid?: string }).mapid, 'mapid');
    return cached(`map:${mapid}`, 30_000, async () => {
      const maps = await zbx<ZMapDetail[]>('map.get', {
        sysmapids: [mapid],
        selectSelements: 'extend',
        selectLinks: 'extend',
        output: 'extend',
      });

      const hostids = [
        ...new Set(
          maps.flatMap((m) =>
            (m.selements ?? [])
              .filter((s) => s.elementtype === '0')
              .flatMap((s) => (s.elements ?? []).map((e) => e.hostid))
              .filter((id): id is string => Boolean(id)),
          ),
        ),
      ];

      // `problem.get` has no selectHosts, so problems are matched to hosts
      // through the same cached, host-enriched list the Problems page uses.
      const [hosts, problems] = hostids.length
        ? await Promise.all([
            zbx<ZMapHost[]>('host.get', {
              hostids,
              output: ['hostid', 'host', 'name'],
              selectInterfaces: ['ip', 'dns', 'useip', 'main'],
            }),
            cached('problems', 5_000, getProblems),
          ])
        : [[], []];

      const hostById = new Map(hosts.map((h) => [h.hostid, h]));
      const status = new Map<string, { problems: number; maxSeverity: number }>();
      for (const p of problems) {
        if (!p.hostid) continue;
        const s = status.get(p.hostid) ?? { problems: 0, maxSeverity: -1 };
        s.problems += 1;
        s.maxSeverity = Math.max(s.maxSeverity, Number(p.severity));
        status.set(p.hostid, s);
      }

      return maps.map((m) => ({
        ...m,
        selements: (m.selements ?? []).map((s) => {
          const hostid = s.elementtype === '0' ? s.elements?.[0]?.hostid : undefined;
          const host = hostid ? hostById.get(hostid) : undefined;
          return {
            ...s,
            labelText: resolveLabel(s.label ?? '', host),
            ...(hostid
              ? { hostid, hostName: host?.name, ...(status.get(hostid) ?? { problems: 0, maxSeverity: -1 }) }
              : {}),
          };
        }),
      }));
    });
  });
}
