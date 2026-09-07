import type { FastifyInstance } from 'fastify';
import { zbx } from '../zabbix.js';
import { cached } from '../cache.js';
import { config } from '../config.js';

/**
 * Link & WAN health (plan_1.2 Phase 5, HCML Goal 3).
 *
 * HCML runs 12 main + 10 redundant SD-WAN links, 10 P2P radio links, 18
 * internet accesses and Starlink at the offshore sites. Their own topology
 * slide flags *"SD-WAN (to_mda_via_sapudi)(internal4): High packet loss"* —
 * that class of fault deserves a first-class view, not a row buried in Latest
 * data.
 *
 * A "link" here is one ICMP-monitored path: the `icmpping` / `icmppingloss` /
 * `icmppingsec` triplet Zabbix collects per target. The portal never speaks
 * ICMP itself — Zabbix polls, this reads the items.
 */

export type LinkState = 'up' | 'degraded' | 'down' | 'unknown';

export interface Link {
  id: string;
  hostid: string;
  host: string;
  /** The far end, when the item names one; otherwise the host's own interface. */
  target: string;
  label: string;
  up?: boolean;
  /** Packet loss, percent. */
  loss?: number;
  /** Round-trip time, milliseconds (Zabbix stores seconds). */
  latency?: number;
  /** max − min RTT, milliseconds. Only when min/max mode items exist. */
  jitter?: number;
  state: LinkState;
  /** From the item tag `link_group` — pairs a main link with its standby. */
  group?: string;
  /** From the item tag `link_role`, e.g. main / redundant. */
  role?: string;
  lastclock?: string;
}

export interface LinkPath {
  name: string;
  links: Link[];
  /** A redundant path survives one leg failing — up if ANY member is up. */
  state: LinkState;
}

export interface LinksResponse {
  links: Link[];
  paths: LinkPath[];
  summary: { total: number; up: number; degraded: number; down: number; unknown: number };
  thresholds: { lossWarn: number; lossCrit: number };
}

interface ZItem {
  itemid: string;
  name: string;
  key_: string;
  lastvalue?: string;
  lastclock?: string;
  units?: string;
  hosts?: { hostid: string; name: string }[];
  tags?: { tag: string; value: string }[];
}

/** `icmppingsec[10.0.0.1,3,,,,max]` → { name: 'icmppingsec', params: [...] } */
function parseKey(key: string): { name: string; params: string[] } {
  const open = key.indexOf('[');
  if (open < 0) return { name: key, params: [] };
  const inner = key.slice(open + 1, key.lastIndexOf(']'));
  return {
    name: key.slice(0, open),
    params: inner.split(',').map((s) => s.trim().replace(/^"(.*)"$/, '$1')),
  };
}

const num = (v?: string) => {
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

function classify(up: boolean | undefined, loss: number | undefined): LinkState {
  if (up === false) return 'down';
  if (loss !== undefined) {
    if (loss >= config.links.lossCrit) return 'down';
    if (loss >= config.links.lossWarn) return 'degraded';
  }
  if (up === undefined && loss === undefined) return 'unknown';
  return 'up';
}

const RANK: Record<LinkState, number> = { down: 3, degraded: 2, unknown: 1, up: 0 };

export async function getLinks(): Promise<LinksResponse> {
  // `monitored: true` matters: without it Zabbix also returns TEMPLATE items,
  // and the page fills with hundreds of identical unassigned prototypes.
  const items = await zbx<ZItem[]>('item.get', {
    output: ['itemid', 'name', 'key_', 'lastvalue', 'lastclock', 'units'],
    search: { key_: 'icmpping' },
    monitored: true,
    selectHosts: ['hostid', 'name'],
    selectTags: 'extend',
    ...(config.netGroupIds.length ? { groupids: config.netGroupIds } : {}),
  });

  // One link = one (host, ping target) pair; its three metrics arrive as
  // separate items that have to be stitched back together.
  const groups = new Map<string, { host: { hostid: string; name: string }; target: string; items: ZItem[] }>();

  for (const item of items) {
    const host = item.hosts?.[0];
    if (!host) continue;
    const { name, params } = parseKey(item.key_);
    if (!name.startsWith('icmpping')) continue;
    const target = params[0] ?? '';
    const id = `${host.hostid}:${target}`;
    const g = groups.get(id) ?? { host, target, items: [] };
    g.items.push(item);
    groups.set(id, g);
  }

  const links: Link[] = [];
  for (const [id, g] of groups) {
    let up: boolean | undefined;
    let loss: number | undefined;
    let latency: number | undefined;
    let rttMin: number | undefined;
    let rttMax: number | undefined;
    let label = '';
    let lastclock: string | undefined;
    const tags: Record<string, string> = {};

    for (const item of g.items) {
      const { name, params } = parseKey(item.key_);
      const v = num(item.lastvalue);
      for (const t of item.tags ?? []) tags[t.tag] = t.value;
      if (item.lastclock && (!lastclock || item.lastclock > lastclock)) lastclock = item.lastclock;

      if (name === 'icmpping') {
        up = v === undefined ? undefined : v === 1;
        label ||= item.name;
      } else if (name === 'icmppingloss') {
        loss = v;
        // The loss item usually carries the most descriptive name — HCML's own
        // example is "SD-WAN (to_mda_via_sapudi)(internal4)".
        if (item.name) label = item.name;
      } else if (name === 'icmppingsec') {
        const mode = params[5] || 'avg';
        if (mode === 'min') rttMin = v;
        else if (mode === 'max') rttMax = v;
        else latency = v;
      }
    }

    const link: Link = {
      id,
      hostid: g.host.hostid,
      host: g.host.name,
      target: g.target,
      label: label || (g.target ? `${g.host.name} → ${g.target}` : g.host.name),
      up,
      loss,
      // Zabbix stores ICMP response time in seconds; humans read milliseconds.
      latency: latency === undefined ? undefined : latency * 1000,
      jitter:
        rttMin !== undefined && rttMax !== undefined ? (rttMax - rttMin) * 1000 : undefined,
      state: classify(up, loss),
      group: tags['link_group'] || undefined,
      role: tags['link_role'] || undefined,
      lastclock,
    };
    links.push(link);
  }

  // Worst first, then noisiest by loss — a NOC reads the top of this list.
  links.sort(
    (a, b) => RANK[b.state] - RANK[a.state] || (b.loss ?? 0) - (a.loss ?? 0) || a.label.localeCompare(b.label),
  );

  // Paired paths: a main + redundant pair is only really down when BOTH legs
  // are. That distinction is the whole point of paying for redundancy.
  const byGroup = new Map<string, Link[]>();
  for (const l of links) {
    if (!l.group) continue;
    byGroup.set(l.group, [...(byGroup.get(l.group) ?? []), l]);
  }
  const paths: LinkPath[] = [...byGroup.entries()]
    .map(([name, members]) => ({
      name,
      links: members,
      state: members.some((m) => m.state === 'up')
        ? members.every((m) => m.state === 'up')
          ? ('up' as LinkState)
          : ('degraded' as LinkState)
        : members.some((m) => m.state === 'degraded')
          ? ('degraded' as LinkState)
          : members.every((m) => m.state === 'unknown')
            ? ('unknown' as LinkState)
            : ('down' as LinkState),
    }))
    .sort((a, b) => RANK[b.state] - RANK[a.state] || a.name.localeCompare(b.name));

  const summary = { total: links.length, up: 0, degraded: 0, down: 0, unknown: 0 };
  for (const l of links) summary[l.state]++;

  return { links, paths, summary, thresholds: config.links };
}

export async function linkRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/links', () => cached('links', 20_000, getLinks));
}
