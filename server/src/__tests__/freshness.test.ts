import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildTestApp } from './helpers/app.js';
import { COLLECTING_STALE_SECONDS, collectingStatus, getIcmpByHost, newestClock } from '../reachability.js';

/**
 * Whether Zabbix is still collecting, and the
 * Dashboard's host count. A stopped zabbix-server leaves every API call
 * working and every value in place, so the age of the newest value is the
 * only sign.
 */

const { zbxMock } = vi.hoisted(() => ({ zbxMock: vi.fn() }));
vi.mock('../zabbix.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../zabbix.js')>();
  return { ...actual, zbx: zbxMock };
});

const NOW_MS = Date.parse('2026-10-07T09:00:00Z');
const NOW = NOW_MS / 1000;
const MIN = 60;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW_MS);
});
afterEach(() => {
  vi.useRealTimers();
  zbxMock.mockReset();
});

const icmp = (hostid: string, secondsAgo: number, over: Record<string, string> = {}) => ({
  itemid: `${hostid}-1`,
  hostid,
  key_: 'icmpping',
  lastvalue: '1',
  lastclock: String(NOW - secondsAgo),
  state: '0',
  delay: '1m',
  ...over,
});

describe('newestClock', () => {
  it('is the newest lastclock of any supported item', () => {
    expect(newestClock([icmp('1', 900), icmp('2', 30), icmp('3', 4000)])).toBe(NOW - 30);
  });

  it('ignores unsupported items, which keep an old value whatever it says, and clocks of 0', () => {
    expect(newestClock([icmp('1', 5, { state: '1' }), icmp('2', 700)])).toBe(NOW - 700);
    expect(newestClock([icmp('1', 5, { lastclock: '0' }), icmp('2', 700)])).toBe(NOW - 700);
    expect(newestClock([{ lastclock: 'soon' }, { state: '0' }])).toBeNull();
  });

  it('is null when nothing has collected', () => {
    expect(newestClock([])).toBeNull();
    expect(newestClock([icmp('1', 5, { state: '1' })])).toBeNull();
  });
});

describe('collectingStatus', () => {
  it('is stale only past ten minutes, the limit isFresh() applies to a ping', () => {
    expect(COLLECTING_STALE_SECONDS).toBe(10 * MIN);
    expect(collectingStatus(NOW - 45, NOW)).toEqual({
      lastCollectedAt: NOW - 45,
      ageSeconds: 45,
      stale: false,
      staleAfterSeconds: 600,
    });
    expect(collectingStatus(NOW - 600, NOW).stale).toBe(false);
    expect(collectingStatus(NOW - 601, NOW).stale).toBe(true);
  });

  it('does not call an unknown age stale, and never reports a negative one', () => {
    expect(collectingStatus(null, NOW)).toEqual({
      lastCollectedAt: null,
      ageSeconds: null,
      stale: false,
      staleAfterSeconds: 600,
    });
    expect(collectingStatus(NOW + 30, NOW).ageSeconds).toBe(0);
  });
});

describe('GET /api/freshness', () => {
  async function app() {
    const { reportRoutes } = await import('../routes/reports.js');
    return buildTestApp(reportRoutes);
  }

  it('says when Zabbix last collected and that it has stopped, for data frozen since September', async () => {
    const frozen = NOW - 20 * 86_400;
    zbxMock.mockResolvedValue([icmp('1', 20 * 86_400), icmp('2', 20 * 86_400 + 90)]);
    const server = await app();
    const res = await server.inject({ url: '/api/freshness' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      lastCollectedAt: frozen,
      ageSeconds: 20 * 86_400,
      stale: true,
      staleAfterSeconds: 600,
    });
    await server.close();
  });

  it('says Zabbix is collecting when a value is recent', async () => {
    zbxMock.mockResolvedValue([icmp('1', 40), icmp('2', 2 * 86_400)]);
    const server = await app();
    expect(await server.inject({ url: '/api/freshness' }).then((r) => r.json())).toMatchObject({
      ageSeconds: 40,
      stale: false,
    });
    await server.close();
  });

  it('works the age out per request from one cached read, so it keeps growing while the cache holds', async () => {
    zbxMock.mockResolvedValue([icmp('1', 540)]);
    const server = await app();
    const first = (await server.inject({ url: '/api/freshness' })).json();
    expect(first).toMatchObject({ ageSeconds: 540, stale: false });

    vi.setSystemTime(NOW_MS + 20_000);
    const second = (await server.inject({ url: '/api/freshness' })).json();
    expect(second).toMatchObject({ ageSeconds: 560, stale: false });
    vi.setSystemTime(NOW_MS + 29_000);
    expect((await server.inject({ url: '/api/freshness' })).json()).toMatchObject({ ageSeconds: 569 });
    expect(zbxMock).toHaveBeenCalledTimes(1);
    await server.close();
  });

  it('keeps its read for 30 seconds and then asks Zabbix again, so a collector that starts again is noticed', async () => {
    zbxMock.mockResolvedValue([icmp('1', 20 * 86_400)]);
    const server = await app();
    expect((await server.inject({ url: '/api/freshness' })).json()).toMatchObject({ stale: true });

    // Zabbix collects again. Within the 30 seconds the old read still stands, and Zabbix is not asked.
    zbxMock.mockResolvedValue([icmp('1', -30)]);
    vi.setSystemTime(NOW_MS + 29_000);
    expect((await server.inject({ url: '/api/freshness' })).json()).toMatchObject({ stale: true });
    expect(zbxMock).toHaveBeenCalledTimes(1);

    vi.setSystemTime(NOW_MS + 31_000);
    expect((await server.inject({ url: '/api/freshness' })).json()).toEqual({
      lastCollectedAt: NOW + 30,
      ageSeconds: 1,
      stale: false,
      staleAfterSeconds: 600,
    });
    expect(zbxMock).toHaveBeenCalledTimes(2);
    await server.close();
  });

  it('has no age to give without an ICMP item, and does not call that stopped', async () => {
    zbxMock.mockResolvedValue([]);
    const server = await app();
    expect((await server.inject({ url: '/api/freshness' })).json()).toMatchObject({
      lastCollectedAt: null,
      ageSeconds: null,
      stale: false,
    });
    await server.close();
  });

  it('shares its one item.get with the host states, so asking for both costs Zabbix one call', async () => {
    zbxMock.mockResolvedValue([icmp('7', 30)]);
    const server = await app();
    expect(await getIcmpByHost().then((m) => m.get('7')?.state)).toBe('up');
    expect((await server.inject({ url: '/api/freshness' })).statusCode).toBe(200);
    expect(zbxMock).toHaveBeenCalledTimes(1);
    expect(zbxMock).toHaveBeenCalledWith('item.get', expect.objectContaining({ search: { key_: 'icmpping' } }));
    await server.close();
  });

  it('is an error, not a made-up age, when Zabbix cannot be read', async () => {
    zbxMock.mockRejectedValue(new Error('zabbix down'));
    const server = await app();
    expect((await server.inject({ url: '/api/freshness' })).statusCode).toBeGreaterThanOrEqual(500);
    await server.close();
  });
});

describe('GET /api/stats host count', () => {
  it('counts monitored hosts only, as the Dashboard card is labelled', async () => {
    zbxMock.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method === 'host.get') return params.monitored_hosts ? '24' : '31';
      if (method === 'problem.get') return [];
      return '0';
    });
    const { reportRoutes } = await import('../routes/reports.js');
    const server = await buildTestApp(reportRoutes);
    expect((await server.inject({ url: '/api/stats' })).json()).toMatchObject({ hosts: 24 });
    expect(zbxMock).toHaveBeenCalledWith('host.get', { countOutput: true, monitored_hosts: true });
    await server.close();
  });
});
