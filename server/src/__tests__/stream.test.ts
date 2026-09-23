import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import http, { type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import Fastify from 'fastify';
import type { ZbxProblem } from '../queries.js';
import { invalidate } from '../cache.js';
import { ZabbixApiError } from '../zabbix.js';
import {
  MAX_QUIET_MS,
  TICK_MS,
  connectedClients,
  fingerprint,
  notifyProblemsChanged,
  shouldSend,
  streamRoutes,
  subscribe,
} from '../routes/stream.js';

/**
 * The shared SSE ticker: one read per tick however many screens listen, a
 * frame only when something shown changed (or every 30 s), and no frames
 * stacked behind a socket that is not keeping up.
 */
const { getProblemsMock } = vi.hoisted(() => ({ getProblemsMock: vi.fn() }));
vi.mock('../queries.js', () => ({ getProblems: getProblemsMock }));

const problem = (over: Partial<ZbxProblem> = {}): ZbxProblem => ({
  eventid: '109',
  objectid: '25238',
  object: '0',
  name: 'High ICMP ping loss',
  severity: '2',
  clock: '1788838236',
  r_eventid: '0',
  acknowledged: '0',
  suppressed: '0',
  opdata: 'Loss: 20 %',
  host: '4.3.3 FPSO ARUBA 3',
  hostid: '10697',
  manualClose: false,
  ...over,
});

/** Enough of a ServerResponse to watch what the stream writes, with a buffer that can fill up. */
class FakeResponse extends EventEmitter {
  written: string[] = [];
  /** While true, write() reports a full buffer, as a slow socket does. */
  full = false;
  destroyed = false;
  writableEnded = false;
  write(text: string): boolean {
    this.written.push(text);
    return !this.full;
  }
  frames(): string[] {
    return this.written.filter((w) => w.startsWith('event: '));
  }
  lastList(): ZbxProblem[] {
    const frame = this.frames().filter((f) => f.startsWith('event: problems')).at(-1) ?? '';
    return JSON.parse(frame.slice(frame.indexOf('data: ') + 6)) as ZbxProblem[];
  }
}

function screen(): { res: FakeResponse; close: () => void } {
  const res = new FakeResponse();
  return { res, close: subscribe(res as unknown as ServerResponse) };
}

/** Let the read the ticker started land and be broadcast. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

async function tick(ms = 5_000): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await settle();
}

function useClock(): void {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-17T08:00:00Z'));
  invalidate('');
  getProblemsMock.mockReset();
}

afterEach(() => {
  vi.useRealTimers();
  expect(connectedClients()).toBe(0); // every test closes its screens, so the ticker stops
});

describe('fingerprint', () => {
  it('ignores order and the fields the 30 s resend covers', () => {
    const a = problem({ eventid: '1' });
    const b = problem({ eventid: '2', severity: '4' });
    expect(fingerprint([a, b])).toBe(fingerprint([b, a]));
    expect(fingerprint([a])).toBe(fingerprint([{ ...a, opdata: 'Loss: 80 %', name: 'renamed', clock: '1' }]));
  });

  it('changes with anything a screen shows about a problem', () => {
    const base = fingerprint([problem()]);
    for (const over of [
      { acknowledged: '1' },
      { severity: '4' },
      { suppressed: '1' },
      { r_eventid: '110' },
      { eventid: '111' },
    ]) {
      expect(fingerprint([problem(over)]), JSON.stringify(over)).not.toBe(base);
    }
    expect(fingerprint([problem(), problem({ eventid: '200' })])).not.toBe(base);
    expect(fingerprint([])).not.toBe(base);
  });
});

describe('shouldSend', () => {
  const now = 1_000_000;
  it('sends the first list, any change, and an unchanged list before it is 30 s old', () => {
    expect(shouldSend(null, 'x', now)).toBe(true);
    expect(shouldSend({ fingerprint: 'x', at: now - 5_000 }, 'y', now)).toBe(true);
    // The next tick would be past 30 s, so this one sends.
    expect(shouldSend({ fingerprint: 'x', at: now - (MAX_QUIET_MS - TICK_MS) - 1 }, 'x', now)).toBe(true);
    expect(shouldSend({ fingerprint: 'x', at: now - MAX_QUIET_MS }, 'x', now)).toBe(true);
  });

  it('holds back an unchanged list while the next tick is still in time', () => {
    expect(shouldSend({ fingerprint: 'x', at: now - 5_000 }, 'x', now)).toBe(false);
    expect(shouldSend({ fingerprint: 'x', at: now - (MAX_QUIET_MS - TICK_MS) }, 'x', now)).toBe(false);
  });
});

describe('shared ticker', () => {
  it('sends on connect, then only changes, keep-alives and the 30 s resend', async () => {
    useClock();
    getProblemsMock.mockResolvedValue([problem()]);
    const a = screen();
    await settle();
    expect(a.res.frames()).toHaveLength(1);

    // Unchanged for 10 s: read again, nothing sent.
    await tick();
    await tick();
    expect(getProblemsMock).toHaveBeenCalledTimes(3);
    expect(a.res.written).toHaveLength(1);

    // 15 s since the last write: a keep-alive, still no frame.
    await tick();
    expect(a.res.written.at(-1)).toBe(': keep-alive\n\n');
    expect(a.res.frames()).toHaveLength(1);

    // A second screen gets the current list at once, without another read.
    const b = screen();
    expect(b.res.frames()).toHaveLength(1);
    expect(getProblemsMock).toHaveBeenCalledTimes(4);

    // Acknowledged: both screens get it on the next tick, from one read.
    getProblemsMock.mockResolvedValue([problem({ acknowledged: '1' })]);
    await tick();
    expect(getProblemsMock).toHaveBeenCalledTimes(5);
    expect(a.res.lastList()[0].acknowledged).toBe('1');
    expect(b.res.lastList()[0].acknowledged).toBe('1');

    // Only opdata moves: held back until the list is 30 s old.
    getProblemsMock.mockResolvedValue([problem({ acknowledged: '1', opdata: 'Loss: 60 %' })]);
    await tick(25_000);
    expect(a.res.frames()).toHaveLength(2);
    await tick();
    expect(a.res.frames()).toHaveLength(3);
    expect(a.res.lastList()[0].opdata).toBe('Loss: 60 %');

    a.close();
    b.close();
  });

  it('skips frames for a screen whose socket is full, then catches it up with the latest only', async () => {
    useClock();
    getProblemsMock.mockResolvedValue([problem()]);
    const slow = screen();
    await settle();
    const fast = screen();

    slow.res.full = true;
    getProblemsMock.mockResolvedValue([problem({ severity: '4' })]);
    await tick(); // written, but the buffer is now full
    getProblemsMock.mockResolvedValue([problem({ severity: '5' })]);
    await tick(); // skipped for the slow screen
    expect(slow.res.frames()).toHaveLength(2);
    expect(fast.res.frames()).toHaveLength(3);

    slow.res.full = false;
    slow.res.emit('drain');
    expect(slow.res.frames()).toHaveLength(3);
    expect(slow.res.lastList()[0].severity).toBe('5');

    slow.close();
    fast.close();
  });

  it('pushes a frame straight after a write, and stops reading once nobody listens', async () => {
    useClock();
    getProblemsMock.mockResolvedValue([problem()]);
    const a = screen();
    await settle();

    invalidate('problems'); // what actions.ts does first
    getProblemsMock.mockResolvedValue([problem({ acknowledged: '1' })]);
    await notifyProblemsChanged();
    expect(a.res.frames()).toHaveLength(2);
    expect(a.res.lastList()[0].acknowledged).toBe('1');

    // Pushed even when Zabbix has not applied the change yet.
    await notifyProblemsChanged();
    expect(a.res.frames()).toHaveLength(3);

    a.close();
    const reads = getProblemsMock.mock.calls.length;
    await tick(60_000);
    await notifyProblemsChanged();
    expect(getProblemsMock).toHaveBeenCalledTimes(reads);
  });

  it('does not let a read from before the write land after the pushed list', async () => {
    useClock();
    getProblemsMock.mockResolvedValue([problem()]);
    const a = screen();
    await settle();

    // A tick's read is still in flight when the acknowledge arrives…
    let releaseOld: (list: ZbxProblem[]) => void = () => {};
    getProblemsMock.mockImplementationOnce(() => new Promise<ZbxProblem[]>((resolve) => (releaseOld = resolve)));
    await tick();

    invalidate('problems');
    getProblemsMock.mockResolvedValue([problem({ acknowledged: '1' })]);
    await notifyProblemsChanged();
    expect(a.res.lastList()[0].acknowledged).toBe('1');

    // …and lands afterwards with the old state: dropped, not sent.
    releaseOld([problem()]);
    await settle();
    expect(a.res.frames()).toHaveLength(2);
    expect(a.res.lastList()[0].acknowledged).toBe('1');

    a.close();
  });

  it('reports a failed read without internal detail, and resends the list once Zabbix is back', async () => {
    useClock();
    getProblemsMock.mockResolvedValue([problem()]);
    const a = screen();
    await settle();

    getProblemsMock.mockRejectedValue(
      new ZabbixApiError('problem.get: HTTP 500 Internal Server Error', 'ZBX_URL=http://zabbix.internal:8080'),
    );
    await tick();
    expect(a.res.frames()[1]).toMatch(/^event: error\n/);
    expect(a.res.frames()[1]).toContain('HTTP 500');
    expect(a.res.frames()[1]).not.toContain('zabbix.internal');

    getProblemsMock.mockRejectedValue(new TypeError("Cannot read properties of undefined (reading 'hosts')"));
    await tick();
    expect(a.res.frames()[2]).toContain('unexpected error');
    expect(a.res.frames()[2]).not.toContain('hosts');

    // The same list as before the outage: sent anyway, which clears the error on screen.
    getProblemsMock.mockResolvedValue([problem()]);
    await tick();
    expect(a.res.frames()).toHaveLength(4);
    expect(a.res.frames()[3]).toMatch(/^event: problems\n/);

    a.close();
  });
});

describe('GET /api/stream', () => {
  it('streams over a real socket and forgets the screen when it disconnects', async () => {
    invalidate('');
    getProblemsMock.mockReset().mockResolvedValue([problem()]);
    const app = Fastify({ logger: false });
    await app.register(streamRoutes);
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as AddressInfo;

    const first = await new Promise<{ type: string; body: string; req: http.ClientRequest }>((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port, path: '/api/stream' }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
          if (body.includes('\n\n')) resolve({ type: String(res.headers['content-type']), body, req });
        });
      });
      req.on('error', reject);
    });
    expect(first.type).toBe('text/event-stream');
    expect(first.body).toMatch(/^event: problems\ndata: \[\{"eventid":"109"/);
    expect(connectedClients()).toBe(1);

    first.req.destroy();
    await vi.waitFor(() => expect(connectedClients()).toBe(0));
    await app.close();
  });
});
