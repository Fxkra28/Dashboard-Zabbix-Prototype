import type { FastifyInstance } from 'fastify';
import { zbx } from '../zabbix.js';
import { cached } from '../cache.js';
import { BadRequestError, intParam, optionalId, requireId } from '../validate.js';
import { getProblems } from '../queries.js';
import { naturalCompare, siteFromHostName } from '../naming.js';
import { getIcmpByHost, hostState } from '../reachability.js';

/** One page of Latest data (legacy, un-paged). Bounds the read and flags when it was hit. */
const LATEST_LIMIT = 500;
/** Paged Latest data: most item ids read in the light first pass. */
const LATEST_ID_LIMIT = 20_000;
/** Most items one /api/items?itemids= request may resolve. */
const MAX_ITEMIDS = 50;

const LATEST_OUTPUT = [
  'itemid',
  'name',
  'key_',
  'lastvalue',
  'lastclock',
  'prevvalue',
  'units',
  'value_type',
  'state',
];

interface ZItem {
  itemid: string;
  value_type: string;
  status?: string;
  state?: string;
}

/** Numeric (float/uint), enabled, supported, what a line chart can draw. */
const isGraphable = (i: ZItem) =>
  (i.value_type === '0' || i.value_type === '3') &&
  (i.status ?? '0') === '0' &&
  (i.state ?? '0') === '0';

interface ZHost {
  hostid: string;
  name: string;
  status: string;
  maintenance_status?: string;
  interfaces?: { ip: string; type?: string; available?: string }[];
}

export async function hostRoutes(app: FastifyInstance): Promise<void> {
  // All hosts (+ interfaces w/ availability). Cached 30s.
  // Each host carries `site` read from its name (naming.ts), null when the name doesn't say.
  app.get('/api/hosts', () =>
    cached('hosts', 30_000, async () => {
      const hosts = await zbx<ZHost[]>('host.get', {
        output: ['hostid', 'name', 'status', 'maintenance_status'],
        selectInterfaces: ['ip', 'type', 'available'],
        sortfield: 'name',
      });
      return hosts.map((h) => ({ ...h, site: siteFromHostName(h.name) }));
    }),
  );

  // Monitoring → Hosts: each host + its live problem severity counts, and its
  // reachability `state`/`reason` (ping first; reachability.ts).
  app.get('/api/hosts/overview', () =>
    cached('hosts:overview', 15_000, async () => {
      const [hosts, problems, icmp] = await Promise.all([
        zbx<ZHost[]>('host.get', {
          output: ['hostid', 'name', 'status', 'maintenance_status'],
          selectInterfaces: ['ip', 'type', 'available'],
          sortfield: 'name',
        }),
        cached('problems', 5_000, getProblems),
        getIcmpByHost(),
      ]);

      const counts: Record<string, { total: number; bySeverity: Record<string, number> }> = {};
      for (const p of problems) {
        if (!p.hostid) continue;
        const c = (counts[p.hostid] ??= { total: 0, bySeverity: {} });
        c.total++;
        c.bySeverity[p.severity] = (c.bySeverity[p.severity] ?? 0) + 1;
      }

      return hosts.map((h) => ({
        ...h,
        ...hostState(h, icmp.get(h.hostid)),
        problems: counts[h.hostid] ?? { total: 0, bySeverity: {} },
      }));
    }),
  );

  // Host groups (for filters). `with_hosts`: `real_hosts` is deprecated in Zabbix 7.0.
  app.get('/api/hostgroups', () =>
    cached('hostgroups', 60_000, () =>
      zbx('hostgroup.get', { output: ['groupid', 'name'], sortfield: 'name', with_hosts: true }),
    ),
  );

  // Items for one host, powers the graph item picker.
  //   ?hostid=           every item on the host (webitems included)
  //   &search=           substring of key_
  //   &graphable=1       numeric (float/uint), enabled and supported only
  //   ?itemids=a,b       specific items (any host), resolves a deep link
  // hostid is required unless itemids is given: without it Zabbix received
  // `hostids: [undefined]` and the Graphs page logged a 500 on every load.
  app.get('/api/items', async (req) => {
    const q = req.query as { hostid?: string; search?: string; graphable?: string; itemids?: string };
    const graphable = q.graphable === '1' || q.graphable === 'true';
    const itemids =
      q.itemids !== undefined && q.itemids !== ''
        ? [...new Set(q.itemids.split(',').map((s) => requireId(s.trim(), 'itemids')))]
        : undefined;
    if (itemids && itemids.length > MAX_ITEMIDS) {
      throw new BadRequestError(`At most ${MAX_ITEMIDS} itemids per request.`);
    }
    const hostid = itemids ? optionalId(q.hostid, 'hostid') : requireId(q.hostid, 'hostid');
    const { search } = q;
    const key = `items:${hostid ?? ''}:${search ?? ''}:${graphable ? 1 : 0}:${itemids?.join(',') ?? ''}`;
    return cached(key, 30_000, async () => {
      const items = await zbx<ZItem[]>('item.get', {
        ...(hostid ? { hostids: [hostid] } : {}),
        ...(itemids ? { itemids, selectHosts: ['hostid', 'name'] } : {}),
        output: [
          'itemid',
          'name',
          'key_',
          'value_type',
          'units',
          'lastvalue',
          'lastclock',
          'state',
          'status',
          'delay',
          'flags',
        ],
        selectTags: ['tag', 'value'],
        webitems: true,
        ...(search ? { search: { key_: search } } : {}),
        ...(graphable ? { filter: { value_type: ['0', '3'], status: '0', state: '0' } } : {}),
        sortfield: 'name',
      });
      return graphable ? items.filter(isGraphable) : items;
    });
  });

  // Monitoring → Latest data: items with their latest value/time, filtered by
  // host or group (Zabbix requires a filter here to bound the result set).
  //
  // With `page`, the list is paged server-side: one light read of every
  // matching id+name (search covers name OR key), sorted naturally, then full
  // details for just that page. Without `page` the original first-500 read is
  // kept for older callers.
  app.get('/api/latest', (req) => {
    const q = req.query as {
      hostid?: string;
      groupid?: string;
      search?: string;
      page?: string;
      pageSize?: string;
    };
    const { hostid, groupid, search } = q;
    const paged = q.page !== undefined && q.page !== '';
    if (!hostid && !groupid) {
      return paged
        ? { items: [], truncated: false, total: 0, page: 1, pageSize: intParam(q.pageSize, 100, 25, 500) }
        : { items: [], truncated: false };
    }
    const filter = {
      ...(hostid ? { hostids: [optionalId(hostid, 'hostid')] } : {}),
      ...(groupid ? { groupids: [optionalId(groupid, 'groupid')] } : {}),
    };

    if (paged) {
      const page = intParam(q.page, 1, 1, 1_000_000);
      const pageSize = intParam(q.pageSize, 100, 25, 500);
      const needle = search?.trim() ?? '';
      return cached(`latest:p:${hostid ?? ''}:${groupid ?? ''}:${needle}:${page}:${pageSize}`, 15_000, async () => {
        const ids = await cached(`latest:ids:${hostid ?? ''}:${groupid ?? ''}:${needle}`, 15_000, async () => {
          const rows = await zbx<{ itemid: string; name: string }[]>('item.get', {
            output: ['itemid', 'name'],
            ...filter,
            ...(needle ? { search: { name: needle, key_: needle }, searchByAny: true } : {}),
            monitored: true,
            webitems: true,
            limit: LATEST_ID_LIMIT,
          });
          return rows
            .sort((a, b) => naturalCompare(a.name, b.name) || naturalCompare(a.itemid, b.itemid))
            .map((r) => r.itemid);
        });
        const total = ids.length;
        const slice = ids.slice((page - 1) * pageSize, page * pageSize);
        let items: { itemid: string }[] = [];
        if (slice.length) {
          const details = await zbx<{ itemid: string }[]>('item.get', {
            itemids: slice,
            output: LATEST_OUTPUT,
            selectHosts: ['hostid', 'name'],
            webitems: true,
          });
          const byId = new Map(details.map((d) => [d.itemid, d]));
          items = slice.map((id) => byId.get(id)).filter((d): d is { itemid: string } => !!d);
        }
        return { items, truncated: total >= LATEST_ID_LIMIT, total, page, pageSize };
      });
    }

    const key = `latest:${hostid ?? ''}:${groupid ?? ''}:${search ?? ''}`;
    return cached(key, 15_000, async () => {
      const items = await zbx<unknown[]>('item.get', {
        output: LATEST_OUTPUT,
        selectHosts: ['hostid', 'name'],
        ...filter,
        ...(search ? { search: { name: search } } : {}),
        monitored: true,
        webitems: true,
        sortfield: 'name',
        limit: LATEST_LIMIT,
      });
      // A group at HCML's scale can hold more than one page of items. Say so
      // rather than showing a short list that looks complete: the same
      // contract the report endpoints use.
      return { items, truncated: items.length >= LATEST_LIMIT };
    });
  });
}
