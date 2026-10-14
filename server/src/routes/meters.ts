import type { FastifyInstance } from 'fastify';
import { zbx } from '../zabbix.js';
import { cached } from '../cache.js';
import { config } from '../config.js';
import { createGate } from '../gate.js';
import { isFresh } from '../reachability.js';
import { parseIfKey } from './net.js';
import {
  buildMeter,
  definitionsFrom,
  summarise,
  type Meter,
  type MeterDefinition,
  type MeterItem,
  type MetersSummary,
  type Reading,
  type Siblings,
  type ZDashboard,
} from '../meters.js';

/**
 * Internet traffic meters: reads the gauge widgets of the Zabbix dashboard HCML already keeps (dashboard.get), so nobody keeps a second list of links and capacities.
 * Read-only; the dashboard and the widgets' neighbour items are kept two minutes. Operator and admin only (auth.ts's `/api/net` rule).
 */

export interface MetersResponse {
  /** The dashboard that was looked for (INTERNET_METERS_DASHBOARD). */
  dashboard: string;
  /** False when Zabbix has no dashboard of that name, or the token cannot see it. */
  found: boolean;
  /** Epoch seconds. */
  generatedAt: number;
  meters: Meter[];
  summary: MetersSummary;
}

interface ZMeterItem extends MeterItem {
  value_type: string;
  delay?: string;
  lastvalue?: string;
  lastclock?: string;
}

interface ZSiblingItem {
  itemid: string;
  key_: string;
  delay?: string;
  status?: string;
  state?: string;
  lastvalue?: string;
  lastclock?: string;
}

/** An item known only by its host and key. */
interface Keyed {
  itemid: string;
  hostid: string;
  key_: string;
}

/** The items beside one widget's item: the same interface's status, and the item of the opposite direction. */
export interface SiblingIds {
  statusId: string | null;
  otherId: string | null;
}

const HISTORY_AT_ONCE = 8;

/** The 64-bit (ifHC) and 32-bit counters count the same interface; a neighbour of the same width is the better partner. */
const hc = (key: string) => /\bifHC/.test(key);

/**
 * For each widget item, the status item and the opposite direction of the same interface (same host, same ifIndex) among `found`.
 * With several candidates: operational status over administrative, the same counter width, then the lowest id.
 */
export function pairSiblings(mains: Keyed[], found: Keyed[]): Record<string, SiblingIds> {
  const byHost = new Map<string, { item: Keyed; kind: string; index: number }[]>();
  for (const item of found) {
    const k = parseIfKey(item.key_);
    if (!k) continue;
    const list = byHost.get(item.hostid) ?? [];
    list.push({ item, kind: k.kind, index: k.index });
    byHost.set(item.hostid, list);
  }
  const out: Record<string, SiblingIds> = {};
  for (const main of mains) {
    const k = parseIfKey(main.key_);
    if (!k || (k.kind !== 'in' && k.kind !== 'out')) continue;
    const here = (byHost.get(main.hostid) ?? []).filter((f) => f.index === k.index && f.item.itemid !== main.itemid);
    const best = (kind: string, prefer: (key: string) => number) =>
      here
        .filter((f) => f.kind === kind)
        .sort((a, b) => prefer(b.item.key_) - prefer(a.item.key_) || Number(a.item.itemid) - Number(b.item.itemid))[0]?.item.itemid ?? null;
    out[main.itemid] = {
      statusId: best('status', (key) => (/ifOperStatus/.test(key) ? 1 : 0)),
      otherId: best(k.kind === 'in' ? 'out' : 'in', (key) => (hc(key) === hc(main.key_) ? 1 : 0)),
    };
  }
  return out;
}

/** One read of every neighbour candidate on the widgets' hosts. */
async function findSiblings(items: ZMeterItem[]): Promise<Record<string, SiblingIds>> {
  const mains = items.flatMap((i) => (i.hostid ? [{ itemid: i.itemid, hostid: i.hostid, key_: i.key_ }] : []));
  if (!mains.length) return {};
  const found = await zbx<Keyed[]>('item.get', {
    hostids: [...new Set(mains.map((m) => m.hostid))],
    search: { key_: ['net.if.in[', 'net.if.out[', 'net.if.status['] },
    searchByAny: true,
    startSearch: true,
    output: ['itemid', 'hostid', 'key_'],
  });
  return pairSiblings(mains, found);
}

/** A value that can be drawn: the item is on, it has a number, and the number is recent. */
function currentReading(it: ZSiblingItem | undefined, now: number): Reading | null {
  if (!it || it.status === '1' || it.state === '1' || !it.lastvalue) return null;
  const value = Number(it.lastvalue);
  if (!Number.isFinite(value) || !isFresh(it, now)) return null;
  return { value, clock: Number(it.lastclock) };
}

async function loadDefinitions(name: string): Promise<MeterDefinition[] | null> {
  const found = await zbx<ZDashboard[]>('dashboard.get', {
    filter: { name: [name] },
    output: ['dashboardid', 'name'],
    selectPages: 'extend',
  });
  return found.length ? definitionsFrom(found[0]) : null;
}

/**
 * The newest value of each item. Zabbix keeps a last value only for a day (the history display period), so a silent item or a
 * stopped copy of Zabbix has none: those are read from history, one newest row each, so a silent link shows when it last spoke.
 */
async function readings(items: ZMeterItem[]): Promise<Map<string, Reading | null>> {
  const out = new Map<string, Reading | null>();
  const fromHistory: ZMeterItem[] = [];
  for (const it of items) {
    const clock = Number(it.lastclock);
    const value = Number(it.lastvalue);
    if (it.status === '1' || it.state === '1') out.set(it.itemid, null);
    else if (clock > 0 && it.lastvalue !== undefined && it.lastvalue !== '' && Number.isFinite(value)) {
      out.set(it.itemid, { value, clock });
    } else fromHistory.push(it);
  }
  const gate = createGate(HISTORY_AT_ONCE);
  await Promise.all(
    fromHistory.map((it) =>
      gate.run(async () => {
        const type = Number(it.value_type);
        if (type !== 0 && type !== 3) return void out.set(it.itemid, null); // text and log items have no number to draw
        const [row] = await zbx<{ clock: string; value: string }[]>('history.get', {
          history: type,
          itemids: [it.itemid],
          sortfield: 'clock',
          sortorder: 'DESC',
          limit: 1,
          output: ['clock', 'value'],
        });
        const value = Number(row?.value);
        out.set(it.itemid, row && Number.isFinite(value) ? { value, clock: Number(row.clock) } : null);
      }),
    ),
  );
  return out;
}

export async function getMeters(): Promise<MetersResponse> {
  const name = config.meters.dashboard;
  const now = Math.floor(Date.now() / 1000);
  const defs = await cached(`meters:definitions:${name}`, 120_000, () => loadDefinitions(name));
  if (!defs) return { dashboard: name, found: false, generatedAt: now, meters: [], summary: summarise([]) };

  const itemids = [...new Set(defs.flatMap((d) => (d.itemid ? [d.itemid] : [])))];
  const items = itemids.length
    ? await zbx<ZMeterItem[]>('item.get', {
        itemids,
        output: ['itemid', 'hostid', 'name', 'key_', 'units', 'value_type', 'delay', 'status', 'state', 'lastvalue', 'lastclock'],
        selectHosts: ['name'],
      })
    : [];
  const byId = new Map(items.map((i) => [i.itemid, i]));
  const found = await readings(items);

  // Neighbours are read from the item only: a status or a figure from days ago says nothing about the link today.
  const pairs = items.length ? await cached(`meters:siblings:${name}:${itemids.join(',')}`, 120_000, () => findSiblings(items)) : {};
  const neighbourIds = [...new Set(Object.values(pairs).flatMap((p) => [p.statusId, p.otherId].filter((id): id is string => id !== null)))];
  const neighbours = neighbourIds.length
    ? await zbx<ZSiblingItem[]>('item.get', {
        itemids: neighbourIds,
        output: ['itemid', 'key_', 'delay', 'status', 'state', 'lastvalue', 'lastclock'],
      })
    : [];
  const neighbourById = new Map(neighbours.map((i) => [i.itemid, i]));

  const meters = defs.map((d) => {
    const item = d.itemid ? byId.get(d.itemid) : undefined;
    const reading = item ? (found.get(item.itemid) ?? null) : null;
    const fresh =
      item !== undefined &&
      reading !== null &&
      isFresh({ lastclock: String(reading.clock), state: item.state, delay: item.delay }, now);
    const ids = item ? pairs[item.itemid] : undefined;
    const otherItem = ids?.otherId ? neighbourById.get(ids.otherId) : undefined;
    const siblings: Siblings = {
      status: currentReading(ids?.statusId ? neighbourById.get(ids.statusId) : undefined, now)?.value ?? null,
      ...(otherItem ? { other: { itemid: otherItem.itemid, reading: currentReading(otherItem, now) } } : {}),
    };
    return buildMeter(d, item, reading, fresh, siblings);
  });
  return { dashboard: name, found: true, generatedAt: now, meters, summary: summarise(meters) };
}

export async function meterRoutes(app: FastifyInstance): Promise<void> {
  // /api/net: operator and up (auth.ts).
  app.get('/api/net/meters', () => cached('net:meters', 30_000, getMeters));
}
