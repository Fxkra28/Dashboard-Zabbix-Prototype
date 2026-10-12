import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { BrowserRouter, MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { api, sessionTiming } from '../api';
import { staleCopyOf } from '../lib/freshness';
import { unreadableMessage } from '../lib/guards';
import { resetAuthProbe } from '../hooks/useAuth';
import Hosts from '../pages/Hosts';
import Overview from '../pages/Overview';
import Problems from '../pages/Problems';
import type { Freshness, HostOverview, Me, Problem, Stats } from '../types';
import { problem } from './problems';

/**
 * The answers that drive the Dashboard, the Problems page and the Hosts page are checked in api.ts.
 * An answer of the wrong shape (a list that was an object has no `.filter`) becomes the page's
 * ordinary error, in plain words, instead of crashing it.
 */

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' }, ...init });

const stats: Stats = { hosts: 24, items: 1000, triggers: 300, groups: 8, problems: 2, unacknowledged: 1, bySeverity: { '4': 2 } };
const fresh: Freshness = { lastCollectedAt: 1_800_000_000, ageSeconds: 30, stale: false, staleAfterSeconds: 600 };
const me: Me = { authEnabled: true, user: { name: 'ana', role: 'operator' }, expiresIn: 3600 };
const host: HostOverview = { hostid: '1', name: 'core-1', status: '0', problems: { total: 0, bySeverity: {} } };
const problems: Problem[] = [problem(1, 4, 600), problem(2, 3, 300)];

/** What the BFF answers per path; a path left out answers a list that is empty. */
let answers: Record<string, () => Response>;
beforeEach(() => {
  window.history.replaceState(null, '', '/');
  resetAuthProbe();
  answers = {
    '/api/health': () => json({ ok: true, ts: 0, ai: false, writeBack: false }),
    '/api/auth/me': () => json(me),
    '/api/stats': () => json(stats),
    '/api/freshness': () => json(fresh),
    '/api/reports/problems-by-group': () => json([]),
    '/api/problems': () => json(problems),
    '/api/hosts/overview': () => json([host]),
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => (answers[url.replace(/^\/bff/, '')] ?? (() => json([])))()),
  );
  FakeEventSource.all = [];
  vi.stubGlobal('EventSource', FakeEventSource);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const WHAT = {
  problems: 'the problem list',
  hostsOverview: 'the host list',
  stats: 'the dashboard counts',
  problemsByGroup: 'the problems by host group',
  freshness: 'the data freshness',
  me: 'your sign-in details',
} as const;

describe('api.ts reads', () => {
  it('hand a whole answer to the page unchanged', async () => {
    await expect(api.problems()).resolves.toEqual(problems);
    await expect(api.hostsOverview()).resolves.toEqual([host]);
    await expect(api.stats()).resolves.toEqual(stats);
    await expect(api.freshness()).resolves.toEqual(fresh);
    await expect(api.problemsByGroup()).resolves.toEqual([]);
  });

  it.each([
    ['problems', '/api/problems', {}],
    ['hostsOverview', '/api/hosts/overview', { hosts: [] }],
    ['stats', '/api/stats', { hosts: '24' }],
    ['problemsByGroup', '/api/reports/problems-by-group', [{ groupid: '1' }]],
    ['freshness', '/api/freshness', null],
    ['me', '/api/auth/me', { user: null }],
  ] as const)('turn a broken answer to %s into a sentence a person can read', async (name, path, body) => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    answers[path] = () => json(body);
    const read = (api[name] as () => Promise<unknown>)();
    await expect(read).rejects.toThrow(unreadableMessage(WHAT[name]));
  });

  it('keep the BFF’s own words for a failure: the check only looks at an answer that came', async () => {
    answers['/api/stats'] = () => json({ message: 'Could not reach Zabbix.' }, { status: 502 });
    await expect(api.stats()).rejects.toThrow('Could not reach Zabbix.');
  });

  it('still notes an old copy kept because Zabbix failed, after the check', async () => {
    answers['/api/problems'] = () => json(problems, { headers: { 'Content-Type': 'application/json', 'X-Data-Stale': 'true', 'X-Data-Age-Seconds': '90' } });
    const list = await api.problems();
    expect(staleCopyOf(list)).not.toBeNull();
  });

  it('record the session from a whole /api/auth/me answer, and not from a broken one', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    answers['/api/auth/me'] = () => json({ authEnabled: true, user: { name: 'bo', role: 7 }, expiresIn: 5 });
    await expect(api.me()).rejects.toThrow();
    expect(sessionTiming()).toBeNull();
    answers['/api/auth/me'] = () => json(me);
    await api.me();
    expect(sessionTiming()?.lifeMs).toBe(3_600_000);
  });
});

describe('a page whose answer has the wrong shape', () => {
  const quiet = () => vi.spyOn(console, 'warn').mockImplementation(() => undefined);

  it('shows the Hosts page error state, not a crash', async () => {
    quiet();
    answers['/api/hosts/overview'] = () => json({ hosts: [host] });
    render(
      <BrowserRouter>
        <Hosts />
      </BrowserRouter>,
    );
    expect(await screen.findByText(unreadableMessage(WHAT.hostsOverview))).toBeInTheDocument();
    expect(screen.getByText('Couldn’t load data')).toBeInTheDocument();
    // Not the hint for an unreachable Zabbix: the portal answered, and Zabbix is not the fault.
    expect(screen.queryByText(/monitoring server|ZBX_URL|BFF is running/)).toBeNull();
  });

  it('shows the Problems page error state, not a crash', async () => {
    quiet();
    answers['/api/problems'] = () => json([problems[0], null]);
    render(
      <BrowserRouter>
        <Problems />
      </BrowserRouter>,
    );
    expect(await screen.findByText(unreadableMessage(WHAT.problems))).toBeInTheDocument();
  });

  it('says so on the Dashboard counts, and leaves the rest of the page working', async () => {
    quiet();
    answers['/api/stats'] = () => json({ hosts: 24 });
    openDashboard();
    expect(await screen.findByText(`Couldn’t load the counts: ${unreadableMessage(WHAT.stats)}`)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('Open problems').closest('.kpi')?.querySelector('.value')?.textContent).toBe('2'));
  });
});

/** An EventSource the test drives. */
class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static all: FakeEventSource[] = [];
  readyState = FakeEventSource.OPEN;
  onopen: (() => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  private listeners = new Map<string, ((e: { data: string }) => void)[]>();
  constructor(readonly url: string) {
    FakeEventSource.all.push(this);
  }
  addEventListener(type: string, fn: (e: { data: string }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  close() {
    this.readyState = FakeEventSource.CLOSED;
  }
  frame(type: string, data: unknown) {
    for (const fn of this.listeners.get(type) ?? []) fn({ data: JSON.stringify(data) });
  }
}

function openDashboard() {
  return render(
    <MemoryRouter>
      <Routes>
        <Route element={<Outlet context={{ wall: false, exitWall: () => undefined }} />}>
          <Route index element={<Overview />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe('the Dashboard’s live stream', () => {
  beforeEach(() => void vi.spyOn(console, 'warn').mockImplementation(() => undefined));
  const stream = () => FakeEventSource.all[FakeEventSource.all.length - 1];
  const status = () => document.querySelector('.live')?.textContent;

  it('shows a whole frame as live, and the problems in it', async () => {
    answers['/api/problems'] = () => json([]);
    openDashboard();
    act(() => stream().frame('problems', problems));
    await waitFor(() => expect(status()).toBe('Live'));
    expect(screen.getAllByText('Problem 1').length).toBeGreaterThan(0);
  });

  it('keeps off a frame of the wrong shape, falls back to polling, and says the stream erred', async () => {
    openDashboard();
    act(() => stream().frame('problems', { problems }));
    await waitFor(() => expect(status()).toBe('Polling: live stream error'));
    // The poll still fills the page, so the Dashboard is never left empty by a bad frame.
    await waitFor(() => expect(screen.getAllByText('Problem 1').length).toBeGreaterThan(0));
    expect(document.querySelector('.live')).toHaveAttribute('title', unreadableMessage(WHAT.problems));
  });

  it('goes live again at the next whole frame', async () => {
    openDashboard();
    act(() => stream().frame('problems', [null]));
    await waitFor(() => expect(status()).toBe('Polling: live stream error'));
    act(() => stream().frame('problems', problems));
    await waitFor(() => expect(status()).toBe('Live'));
  });
});
