import { zbx } from '../clients/zabbix.js';
import { cached } from '../core/cache.js';
import { parseDelay } from '../sli/engine.js';

/**
 * One reachability state per host, ping first.
 *
 * Zabbix's interface flags answer a different question: whether SNMP or the agent responds. On
 * 2026-09-17, 16 of HCML's 23 "unavailable" hosts answered ping, and 43 hosts had no interface at
 * all. ICMP is what "down" means; the interface flags explain what else is wrong and stand in only
 * when there is no recent ping.
 *
 * Read-only. The Network page reads the same ICMP items (net.ts), so both views agree on what "up"
 * is.
 */

export type HostState = 'up' | 'down' | 'degraded' | 'nodata' | 'disabled';

/** Where a host's state came from. */
export type StateReason =
  | 'ping'
  | 'interface'
  | 'snmp-silent'
  | 'agent-silent'
  | 'stale'
  | 'no-interface'
  | 'unsupported'
  | 'disabled';

export type Availability = 'available' | 'unavailable' | 'unknown';

/**
 * Zabbix 7.0 tracks availability per interface. Roll up to a host state the
 * same way the UI does elsewhere: worst wins.
 */
export function rollUpAvailability(interfaces?: { available?: string }[]): Availability {
  if (!interfaces?.length) return 'unknown';
  if (interfaces.some((i) => i.available === '2')) return 'unavailable';
  if (interfaces.some((i) => i.available === '1')) return 'available';
  return 'unknown';
}

/** Below this, a value is never called stale: one slow poller cycle must not flip a host to "no data". */
const MIN_FRESH_SECONDS = 600;

/**
 * A value Zabbix actually collected, from a supported item, recently enough to
 * believe: at most three update intervals old, and never less than ten minutes.
 *
 * `lastclock '0'` means nothing was collected within Zabbix's history display
 * period; an unsupported item keeps its last value, whatever it says. Without
 * the age check, a pinger that stopped hours ago still read as "up". Delays in
 * a macro count as one minute, as elsewhere in the portal.
 */
export function isFresh(
  it: { lastclock?: string; state?: string; delay?: string },
  now: number,
): boolean {
  if (it.state === '1' || !it.lastclock || it.lastclock === '0') return false;
  const age = now - Number(it.lastclock);
  return Number.isFinite(age) && age <= Math.max(3 * parseDelay(it.delay), MIN_FRESH_SECONDS);
}

export interface IcmpItem {
  itemid: string;
  hostid: string;
  key_: string;
  lastvalue: string;
  lastclock: string;
  state: string;
  delay: string;
}

/** One host's ICMP items folded together. */
export interface IcmpReading {
  /** From a fresh `icmpping` value; absent without one. */
  up?: boolean;
  /** `icmppingloss`, percent, when fresh. Operator views only. */
  loss?: number;
  /** `icmppingsec`, seconds, when fresh. Operator views only. */
  latency?: number;
  /** `up`/`down` only from a fresh `icmpping` value. */
  state: 'up' | 'down' | 'unknown';
  /** ICMP items the host has (icmpping, icmppingloss, icmppingsec, …). */
  items: number;
  /** How many of those Zabbix marks unsupported. */
  unsupported: number;
}

/** `icmpping` or `icmpping[,…]` pings the host itself; `icmpping[10.0.0.1]` pings some other target. */
const pingsHost = (key: string) => !key.includes('[') || /^[a-z]+\[\s*(,|\])/.test(key);

/**
 * Fold ICMP items into one reading per host. When a host has more than one
 * item of a kind, the one pinging the host itself wins. Pure; exported for tests.
 */
export function foldIcmp(items: IcmpItem[], now: number): Map<string, IcmpReading> {
  const out = new Map<string, IcmpReading>();
  const ordered = [...items].sort((a, b) => Number(pingsHost(b.key_)) - Number(pingsHost(a.key_)));
  for (const it of ordered) {
    let r = out.get(it.hostid);
    if (!r) {
      r = { state: 'unknown', items: 0, unsupported: 0 };
      out.set(it.hostid, r);
    }
    r.items++;
    if (it.state === '1') r.unsupported++;
    if (!isFresh(it, now)) continue;
    if (it.key_.startsWith('icmppingloss')) r.loss ??= Number(it.lastvalue);
    else if (it.key_.startsWith('icmppingsec')) r.latency ??= Number(it.lastvalue);
    else if (it.key_.startsWith('icmpping') && r.up === undefined) {
      r.up = it.lastvalue === '1';
      r.state = r.up ? 'up' : 'down';
    }
  }
  return out;
}

/**
 * Every monitored ICMP item, in one `item.get`. Cached briefly: the pinger
 * itself runs once a minute. Shared by the host states and the data clock, so
 * asking for both costs Zabbix one call.
 */
function getIcmpItems(): Promise<IcmpItem[]> {
  return cached('icmp:items', 15_000, () =>
    zbx<IcmpItem[]>('item.get', {
      output: ['itemid', 'hostid', 'key_', 'lastvalue', 'lastclock', 'state', 'delay'],
      search: { key_: 'icmpping' },
      startSearch: true,
      monitored: true,
    }),
  );
}

/** ICMP readings for every monitored host. Hosts without an ICMP item are absent. */
export function getIcmpByHost(): Promise<Map<string, IcmpReading>> {
  return cached('icmp:hosts', 15_000, async () => foldIcmp(await getIcmpItems(), Math.floor(Date.now() / 1000)));
}

/**
 * Whether Zabbix is still collecting. A stopped `zabbix-server` leaves every API call working and
 * every value in place, so a frozen estate would read `ok` and "Live". The newest value any
 * supported ICMP item holds says when anything was last collected; the pinger runs once a minute,
 * so that is never long ago on a healthy estate.
 */

/** The same ten minutes isFresh() allows before it stops believing a ping. */
export const COLLECTING_STALE_SECONDS = MIN_FRESH_SECONDS;

/** The newest `lastclock` of a supported item, Unix seconds; null when no item has collected. Pure. */
export function newestClock(items: { lastclock?: string; state?: string }[]): number | null {
  let newest = 0;
  for (const it of items) {
    if (it.state === '1') continue;
    const clock = Number(it.lastclock);
    if (Number.isFinite(clock) && clock > newest) newest = clock;
  }
  return newest > 0 ? newest : null;
}

export interface CollectingStatus {
  /** When Zabbix last collected a value, Unix seconds; null when there is no ICMP item to tell. */
  lastCollectedAt: number | null;
  ageSeconds: number | null;
  /** Nothing collected for longer than `staleAfterSeconds`. Never true while the age is unknown. */
  stale: boolean;
  staleAfterSeconds: number;
}

/** Work out the age at the moment of asking. Pure. */
export function collectingStatus(lastCollectedAt: number | null, now: number): CollectingStatus {
  const ageSeconds = lastCollectedAt === null ? null : Math.max(0, now - lastCollectedAt);
  return {
    lastCollectedAt,
    ageSeconds,
    stale: ageSeconds !== null && ageSeconds > COLLECTING_STALE_SECONDS,
    staleAfterSeconds: COLLECTING_STALE_SECONDS,
  };
}

/** When Zabbix last collected a value. Cached; the age is worked out per request, from this. */
export function getLastCollected(): Promise<number | null> {
  return cached('collecting:last', 30_000, async () => newestClock(await getIcmpItems()));
}

/**
 * A host's state, ping first. Pure.
 *
 *   disabled   host status '1'                                   (disabled)
 *   degraded   fresh ping up, but an interface is unavailable:
 *              SNMP (snmp-silent), agent (agent-silent), IPMI/JMX (interface)
 *   up         fresh ping up                                     (ping)
 *   down       fresh ping down                                   (ping)
 *
 * With no fresh ping, the interface flags decide:
 *
 *   up         an interface available, none unavailable          (interface)
 *   down       an interface unavailable                          (interface)
 *   nodata     nothing to go on, and the reason says why:
 *                stale         ICMP items exist and are supported, but none
 *                              has a recent value
 *                no-interface  the host has no interface (at HCML this is also
 *                              why its ICMP items are unsupported)
 *                unsupported   every ICMP item is unsupported
 *                interface     interfaces exist, their availability unknown
 */
export function hostState(
  host: { status: string; interfaces?: { type?: string; available?: string }[] },
  icmp: IcmpReading | undefined,
): { state: HostState; reason: StateReason } {
  if (host.status === '1') return { state: 'disabled', reason: 'disabled' };

  const failed = (host.interfaces ?? []).filter((i) => i.available === '2');
  if (icmp?.state === 'up') {
    if (!failed.length) return { state: 'up', reason: 'ping' };
    if (failed.some((i) => i.type === '2')) return { state: 'degraded', reason: 'snmp-silent' };
    if (failed.some((i) => i.type === '1')) return { state: 'degraded', reason: 'agent-silent' };
    return { state: 'degraded', reason: 'interface' };
  }
  if (icmp?.state === 'down') return { state: 'down', reason: 'ping' };

  const availability = rollUpAvailability(host.interfaces);
  if (availability === 'available') return { state: 'up', reason: 'interface' };
  if (availability === 'unavailable') return { state: 'down', reason: 'interface' };

  if (icmp && icmp.unsupported < icmp.items) return { state: 'nodata', reason: 'stale' };
  if (!host.interfaces?.length) return { state: 'nodata', reason: 'no-interface' };
  if (icmp && icmp.items > 0) return { state: 'nodata', reason: 'unsupported' };
  return { state: 'nodata', reason: 'interface' };
}
