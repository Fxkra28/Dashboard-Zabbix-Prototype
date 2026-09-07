import type { FastifyInstance } from 'fastify';
import { zbx } from '../zabbix.js';
import { cached } from '../cache.js';
import { getProblems } from '../queries.js';

interface ZHost {
  hostid: string;
  name: string;
  status: string;
  maintenance_status?: string;
  interfaces?: { ip: string; type?: string; available?: string }[];
}

export async function hostRoutes(app: FastifyInstance): Promise<void> {
  // All hosts (+ interfaces w/ availability). Cached 30s.
  app.get('/api/hosts', () =>
    cached('hosts', 30_000, () =>
      zbx('host.get', {
        output: ['hostid', 'name', 'status', 'maintenance_status'],
        selectInterfaces: ['ip', 'type', 'available'],
        sortfield: 'name',
      }),
    ),
  );

  // Monitoring → Hosts: each host + its live problem severity counts.
  app.get('/api/hosts/overview', () =>
    cached('hosts:overview', 15_000, async () => {
      const [hosts, problems] = await Promise.all([
        zbx<ZHost[]>('host.get', {
          output: ['hostid', 'name', 'status', 'maintenance_status'],
          selectInterfaces: ['ip', 'type', 'available'],
          sortfield: 'name',
        }),
        getProblems(),
      ]);

      const counts: Record<string, { total: number; bySeverity: Record<string, number> }> = {};
      for (const p of problems) {
        if (!p.hostid) continue;
        const c = (counts[p.hostid] ??= { total: 0, bySeverity: {} });
        c.total++;
        c.bySeverity[p.severity] = (c.bySeverity[p.severity] ?? 0) + 1;
      }

      return hosts.map((h) => ({ ...h, problems: counts[h.hostid] ?? { total: 0, bySeverity: {} } }));
    }),
  );

  // Host groups (for filters).
  app.get('/api/hostgroups', () =>
    cached('hostgroups', 60_000, () =>
      zbx('hostgroup.get', { output: ['groupid', 'name'], sortfield: 'name', real_hosts: true }),
    ),
  );

  // Items for one host — powers the graph item picker. Optional ?search= on key_.
  app.get('/api/items', (req) => {
    const { hostid, search } = req.query as { hostid?: string; search?: string };
    return cached(`items:${hostid}:${search ?? ''}`, 30_000, () =>
      zbx('item.get', {
        hostids: [hostid],
        output: ['itemid', 'name', 'key_', 'value_type', 'units', 'lastvalue'],
        ...(search ? { search: { key_: search } } : {}),
        sortfield: 'name',
      }),
    );
  });

  // Monitoring → Latest data: items with their latest value/time, filtered by
  // host or group (Zabbix requires a filter here to bound the result set).
  app.get('/api/latest', (req) => {
    const { hostid, groupid, search } = req.query as {
      hostid?: string;
      groupid?: string;
      search?: string;
    };
    if (!hostid && !groupid) return [];
    const key = `latest:${hostid ?? ''}:${groupid ?? ''}:${search ?? ''}`;
    return cached(key, 15_000, () =>
      zbx('item.get', {
        output: [
          'itemid',
          'name',
          'key_',
          'lastvalue',
          'lastclock',
          'prevvalue',
          'units',
          'value_type',
          'state',
        ],
        selectHosts: ['hostid', 'name'],
        ...(hostid ? { hostids: [hostid] } : {}),
        ...(groupid ? { groupids: [groupid] } : {}),
        ...(search ? { search: { name: search } } : {}),
        monitored: true,
        webitems: true,
        sortfield: 'name',
        limit: 500,
      }),
    );
  });
}
