import type { FastifyInstance } from 'fastify';
import { zbx } from '../zabbix.js';
import { cached } from '../cache.js';
import { config } from '../config.js';
import { intParam, requireId } from '../validate.js';
import { naturalCompare, siteFromHostName } from '../naming.js';
import { getIcmpByHost, isFresh } from '../reachability.js';

export type OperStatus =
  | 'up'
  | 'down'
  | 'testing'
  | 'unknown'
  | 'dormant'
  | 'notPresent'
  | 'lowerLayerDown';

/** IF-MIB ifOperStatus. */
const OPER_STATUS: Record<string, OperStatus> = {
  '1': 'up',
  '2': 'down',
  '3': 'testing',
  '4': 'unknown',
  '5': 'dormant',
  '6': 'notPresent',
  '7': 'lowerLayerDown',
};

interface ZIfItem {
  itemid: string;
  name: string;
  key_: string;
  lastvalue: string;
  lastclock: string;
  units: string;
  value_type: string;
  state: string;
  status: string;
}

export interface InterfaceRow {
  index: number;
  name: string;
  alias: string;
  operStatus: OperStatus;
  speed: number | null;
  inBps: number | null;
  outBps: number | null;
  utilisation: number | null;
  inErrors: number | null;
  outErrors: number | null;
  inDiscards: number | null;
  outDiscards: number | null;
  lastclock: number | null;
  itemids: Partial<Record<'in' | 'out' | 'status' | 'speed' | 'inErrors' | 'outErrors', string>>;
}

/** `net.if.in[ifHCInOctets.33]` → { kind: 'in', index: 33 }. Walk/master items → null. */
export function parseIfKey(key: string): { kind: string; index: number } | null {
  const m = /^net\.if\.([a-z.]+?)\[([^,\]]*)/.exec(key);
  if (!m || m[1].endsWith('walk')) return null;
  const idx = /\.(\d+)$/.exec(m[2].trim());
  if (!idx) return null;
  return { kind: m[1], index: Number(idx[1]) };
}

/** `Interface Gi1/0/1(Uplink (core)): Bits received` → name Gi1/0/1, alias `Uplink (core)`. */
export function parseIfName(itemName: string): { name: string; alias: string } | null {
  const m = /^Interface\s+([^(]+?)\s*\((.*)\):\s/.exec(itemName);
  if (m) return { name: m[1].trim(), alias: m[2].trim() };
  const plain = /^Interface\s+(.+?):\s/.exec(itemName);
  return plain ? { name: plain[1].trim(), alias: '' } : null;
}

/**
 * Fold one host's net.if.* items into one row per SNMP ifIndex. A value counts
 * only while fresh (reachability.ts `isFresh`, as of `now` in Unix seconds).
 */
export function groupInterfaces(items: ZIfItem[], now = Math.floor(Date.now() / 1000)): InterfaceRow[] {
  const rows = new Map<number, InterfaceRow>();
  for (const it of items) {
    const k = parseIfKey(it.key_);
    if (!k) continue;
    let row = rows.get(k.index);
    if (!row) {
      row = {
        index: k.index,
        name: '',
        alias: '',
        operStatus: 'unknown',
        speed: null,
        inBps: null,
        outBps: null,
        utilisation: null,
        inErrors: null,
        outErrors: null,
        inDiscards: null,
        outDiscards: null,
        lastclock: null,
        itemids: {},
      };
      rows.set(k.index, row);
    }
    const label = parseIfName(it.name);
    if (label && !row.name) {
      row.name = label.name;
      row.alias = label.alias;
    }
    const fresh = isFresh(it, now);
    const value = fresh && it.lastvalue !== '' ? Number(it.lastvalue) : null;
    const num = value !== null && Number.isFinite(value) ? value : null;
    if (fresh) row.lastclock = Math.max(row.lastclock ?? 0, Number(it.lastclock));

    switch (k.kind) {
      case 'in':
        row.itemids.in = it.itemid;
        row.inBps = num;
        break;
      case 'out':
        row.itemids.out = it.itemid;
        row.outBps = num;
        break;
      case 'status':
        row.itemids.status = it.itemid;
        row.operStatus = fresh ? (OPER_STATUS[it.lastvalue] ?? 'unknown') : 'unknown';
        break;
      case 'speed':
        row.itemids.speed = it.itemid;
        row.speed = num !== null && num > 0 ? num : null;
        break;
      case 'in.errors':
        row.itemids.inErrors = it.itemid;
        row.inErrors = num;
        break;
      case 'out.errors':
        row.itemids.outErrors = it.itemid;
        row.outErrors = num;
        break;
      case 'in.discards':
        row.inDiscards = num;
        break;
      case 'out.discards':
        row.outDiscards = num;
        break;
    }
  }
  const out = [...rows.values()];
  for (const r of out) {
    if (!r.name) r.name = `ifIndex ${r.index}`;
    const peak = Math.max(r.inBps ?? -1, r.outBps ?? -1);
    r.utilisation = r.speed && peak >= 0 ? Math.round((peak / r.speed) * 10_000) / 100 : null;
  }
  return out.sort((a, b) => naturalCompare(a.name, b.name) || a.index - b.index);
}

const statusBucket = (s: OperStatus): 'up' | 'down' | 'other' =>
  s === 'up' ? 'up' : s === 'down' || s === 'lowerLayerDown' ? 'down' : 'other';

/**
 * Network monitoring (setup.md §10). The portal never speaks SNMP: it just
 * reads the ICMP / SNMP-LLD items Zabbix already collects, exactly like any host.
 * These views populate automatically once real devices are onboarded (§13.4).
 */
export async function netRoutes(app: FastifyInstance): Promise<void> {
  // Devices in the network host groups, each enriched with ICMP availability.
  app.get('/api/net/devices', () =>
    cached('net:devices', 30_000, async () => {
      const hostParams: Record<string, unknown> = {
        output: ['hostid', 'name', 'status'],
        selectInterfaces: ['ip', 'type'],
        sortfield: 'name',
      };
      if (config.netGroupIds.length) hostParams.groupids = config.netGroupIds;

      // ICMP items: icmpping (up/down), icmppingloss (%), icmppingsec (latency),
      // read once for every monitored host and shared with Sites and Hosts.
      // A value is only believed while fresh: collected, supported and recent.
      // `lastclock '0'` (never polled / no recent data) used to read as
      // `lastvalue ''` → "down"; it is `unknown`, and so is a value hours old.
      const [hosts, icmp] = await Promise.all([
        zbx<{ hostid: string; name: string; status: string }[]>('host.get', hostParams),
        getIcmpByHost(),
      ]);

      return hosts
        .map((h) => {
          const r = icmp.get(h.hostid);
          // Loss and latency stay on this operator-only route; the viewer
          // routes (Sites, Hosts) carry only the derived state.
          return {
            ...h,
            site: siteFromHostName(h.name),
            icmp: r ? { up: r.up, loss: r.loss, latency: r.latency, state: r.state } : null,
          };
        })
        .sort((a, b) => naturalCompare(a.name, b.name));
    }),
  );

  // Interfaces / ports of one device (SNMP LLD traffic items) with latest values.
  app.get('/api/net/ports', async (req) => {
    const hostid = requireId((req.query as { hostid?: string }).hostid, 'hostid');
    return cached(`net:ports:${hostid}`, 15_000, () =>
      zbx('item.get', {
        hostids: [hostid],
        search: { key_: 'net.if.' },
        startSearch: true,
        output: ['itemid', 'name', 'key_', 'lastvalue', 'units', 'value_type'],
        sortfield: 'name',
      }),
    );
  });

  // One row per physical/logical interface: the ~9 net.if.* items Zabbix
  // discovers per SNMP ifIndex folded together (1,119 items → ~122 rows on
  // the core switch).  ?hostid=&search=&status=up|down|other&page=&pageSize=
  app.get('/api/net/interfaces', async (req) => {
    const q = req.query as {
      hostid?: string;
      search?: string;
      status?: string;
      page?: string;
      pageSize?: string;
    };
    const hostid = requireId(q.hostid, 'hostid');
    const page = intParam(q.page, 1, 1, 100_000);
    const pageSize = intParam(q.pageSize, 200, 10, 1000);
    const rows = await cached(`net:interfaces:${hostid}`, 15_000, async () =>
      groupInterfaces(
        await zbx<ZIfItem[]>('item.get', {
          hostids: [hostid],
          search: { key_: 'net.if.' },
          startSearch: true,
          output: ['itemid', 'name', 'key_', 'lastvalue', 'lastclock', 'units', 'value_type', 'state', 'status'],
        }),
      ),
    );

    const needle = q.search?.trim().toLowerCase() ?? '';
    const searched = needle
      ? rows.filter((r) => r.name.toLowerCase().includes(needle) || r.alias.toLowerCase().includes(needle))
      : rows;
    const summary = { up: 0, down: 0, other: 0 };
    for (const r of searched) summary[statusBucket(r.operStatus)]++;
    const status = q.status === 'up' || q.status === 'down' || q.status === 'other' ? q.status : undefined;
    const filtered = status ? searched.filter((r) => statusBucket(r.operStatus) === status) : searched;

    return {
      rows: filtered.slice((page - 1) * pageSize, page * pageSize),
      total: filtered.length,
      summary,
      page,
      pageSize,
    };
  });

  // Oper status (up/down) items per port. Not called by the web app today.
  app.get('/api/net/status', async (req) => {
    const hostid = requireId((req.query as { hostid?: string }).hostid, 'hostid');
    return cached(`net:status:${hostid}`, 15_000, () =>
      zbx('item.get', {
        hostids: [hostid],
        search: { key_: 'ifOperStatus' },
        startSearch: true,
        output: ['itemid', 'name', 'key_', 'lastvalue'],
        sortfield: 'name',
      }),
    );
  });

  // Topology map.  ?mapid=  Not called by the web app: the Maps page uses
  // /api/maps/detail, which also resolves labels and host status.
  app.get('/api/net/map', async (req) => {
    const mapid = requireId((req.query as { mapid?: string }).mapid, 'mapid');
    return zbx('map.get', {
      sysmapids: [mapid],
      selectSelements: 'extend',
      selectLinks: 'extend',
    });
  });
}
