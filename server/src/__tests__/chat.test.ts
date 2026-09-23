import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invalidate } from '../cache.js';
import {
  age,
  buildFocus,
  buildSnapshot,
  CHAT_SYSTEM,
  cleanAnswer,
  detectLanguage,
  focusBlock,
  getSnapshot,
  languageReminder,
  readOpenAiStream,
  section,
  SNAPSHOT_CHAR_CAP,
  SNAPSHOT_KEY,
  sitesNamed,
} from '../chat.js';
import { getProblems } from '../queries.js';
import { getSites } from '../routes/sites.js';
import { getSlas, getSli } from '../routes/sla.js';
import { getServiceTree } from '../routes/services.js';
import { derivedServiceLines, derivedSlaLines } from '../sli/summary.js';

/**
 * The assistant's pure parts: the snapshot the model is shown, the prompt,
 * the answer clean-up, and the parser that turns the model's stream into text.
 *
 * The snapshot matters because it is the *only* thing the model knows: a
 * host that is missing from it does not exist as far as the answer goes. The
 * parser matters because reasoning models interleave `reasoning` frames with
 * empty `content`; forwarding those would show the reader the model thinking.
 */

vi.mock('../queries.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../queries.js')>();
  return { ...actual, getProblems: vi.fn(), getHostsWithMeta: vi.fn() };
});
vi.mock('../routes/sites.js', () => ({ getSites: vi.fn() }));
vi.mock('../routes/sla.js', () => ({ getSlas: vi.fn(), getSli: vi.fn() }));
vi.mock('../routes/services.js', () => ({ getServiceTree: vi.fn() }));
vi.mock('../sli/summary.js', () => ({ derivedSlaLines: vi.fn(), derivedServiceLines: vi.fn() }));

const NOW = Math.floor(Date.now() / 1000);

const problem = (over: Partial<Record<string, unknown>> = {}) => ({
  eventid: '180',
  objectid: '25249',
  object: '0',
  name: 'High ICMP ping loss',
  severity: '2',
  clock: String(NOW - 3 * 3600),
  r_eventid: '0',
  acknowledged: '1',
  opdata: '',
  tags: [{ tag: 'site', value: 'FPSO KAS3' }],
  host: '4.3.3 FPSO ARUBA 3',
  hostid: '10710',
  ...over,
});

/** A host as getSites returns it: `state` is ping first (reachability.ts), `availability` the interface flags. */
const host = (over: Partial<Record<string, unknown>> = {}) => ({
  hostid: '10710',
  name: '4.3.3 FPSO ARUBA 3',
  status: '0',
  availability: 'available',
  state: 'up',
  reason: 'ping',
  siteSource: 'name',
  problems: { total: 0, bySeverity: {} },
  ...over,
});

const site = (over: Partial<Record<string, unknown>> = {}) => ({
  name: 'FPSO KAS3 & BD-WHP',
  total: 2,
  available: 1,
  unavailable: 1,
  unknown: 0,
  up: 1,
  down: 1,
  degraded: 0,
  nodata: 0,
  maintenance: 0,
  disabled: 0,
  problems: 1,
  unacknowledged: 0,
  bySeverity: { '2': 1 },
  worst: 2,
  hosts: [
    host({ problems: { total: 1, bySeverity: { '2': 1 } } }),
    host({ hostid: '10711', name: '4.3.4 FPSO ARUBA 4', availability: 'unavailable', state: 'down' }),
  ],
  ...over,
});

const realTree = {
  tree: [
    { serviceid: '1', name: 'Platform', status: -1, algorithm: '1', tags: [], problems: [], children: [
      { serviceid: '5', name: 'Voice path', status: 2, algorithm: '1', tags: [], problems: [{ eventid: '180', name: 'High ICMP ping loss', severity: '2' }], children: [], worst: 2, descendants: 0 },
    ], worst: 2, descendants: 1 },
  ],
  total: 2,
  degraded: 1,
  worst: 2,
};

function stream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

async function collect(gen: AsyncGenerator<string>): Promise<string> {
  let out = '';
  for await (const piece of gen) out += piece;
  return out;
}

beforeEach(() => {
  invalidate('');
  vi.mocked(getProblems).mockResolvedValue([problem()] as never);
  vi.mocked(getSites).mockResolvedValue({ sites: [site()], coverage: { hosts: 2, tag: 2, inventory: 0, group: 0 } } as never);
  vi.mocked(getSlas).mockResolvedValue([
    { slaid: '1', name: 'HCML Critical Services — Monthly', slo: '99', period: '2', status: '1' },
  ] as never);
  vi.mocked(getSli).mockResolvedValue([
    { serviceid: '5', name: 'Voice path', sli: 98.2, uptime: 40000, downtime: 700, error_budget: -120, period_from: 0, period_to: 0 },
  ] as never);
  vi.mocked(getServiceTree).mockResolvedValue(realTree as never);
  vi.mocked(derivedSlaLines).mockResolvedValue([]);
  vi.mocked(derivedServiceLines).mockResolvedValue([]);
});

const HEADERS = ['SNAPSHOT taken', 'ESTATE:', 'SITES (', 'NEW IN LAST 24 H:', 'UNREACHABLE HOSTS (', 'SLA:', 'DEGRADED SERVICES:', 'OPEN PROBLEMS ('];

describe('buildSnapshot', () => {
  it('describes the estate in compact sections with the facts a NOC would ask about', async () => {
    const { text, meta } = await buildSnapshot();

    for (const h of HEADERS) expect(text).toContain(h);
    expect(text).toContain('WIB');
    expect(text).toContain('ESTATE: 2 hosts at 1 sites; 1 reachable, 1 unreachable');
    expect(text).toContain('Disaster 0, High 0, Average 0, Warning 1');
    expect(text).toContain('- FPSO KAS3 & BD-WHP: 2 hosts, 1 unreachable, 1 problems, worst Warning');
    expect(text).toContain('- [Warning] 4.3.3 FPSO ARUBA 3: High ICMP ping loss; open 3h, acked');
    // New within 24 h, so it is listed there too.
    expect(text).toContain('NEW IN LAST 24 H: 1 problems opened (Warning 1)');
    // The unreachable host is named, grouped under the site its name says (code 4).
    expect(text).toContain('- FPSO KAS3 & BD-WHP (1): 4.3.4 FPSO ARUBA 4');
    expect(text).not.toContain('4.3.4 FPSO ARUBA 4 (');
    expect(text).toContain('HCML Critical Services — Monthly (target 99%): Voice path 98.20%, MISSED, error budget exceeded by 2 min');
    expect(text).toContain('- Voice path: Warning — caused by: High ICMP ping loss');
    // No tags anywhere: they cost tokens and the model never needed them.
    expect(text).not.toMatch(/tags:/);

    expect(meta).toMatchObject({ hosts: 2, sites: 1, problems: 1, unacknowledged: 0, slas: 1, degradedServices: 1, truncated: false });
  });

  it('lists a service shared by two parents once — services are a DAG, not a tree', async () => {
    const shared = {
      serviceid: '9', name: 'Shared SD-WAN core', status: 3, algorithm: '1', tags: [],
      problems: [{ eventid: '180', name: 'High ICMP ping loss', severity: '3' }],
      children: [], worst: 3, descendants: 0,
    };
    vi.mocked(getServiceTree).mockResolvedValue({
      tree: [
        { serviceid: '1', name: 'Offshore', status: 3, algorithm: '1', tags: [], problems: [], children: [shared], worst: 3, descendants: 1 },
        { serviceid: '2', name: 'Onshore', status: 3, algorithm: '1', tags: [], problems: [], children: [shared], worst: 3, descendants: 1 },
      ],
      total: 3,
      degraded: 3,
      worst: 3,
    } as never);

    const { text, meta } = await buildSnapshot();
    expect(text.match(/Shared SD-WAN core: Average/g)).toHaveLength(1);
    expect(meta.degradedServices).toBe(3);
  });

  it('still answers about problems when the Services and SLA APIs are unavailable', async () => {
    vi.mocked(getServiceTree).mockRejectedValue(new Error('services.get: not supported'));
    vi.mocked(getSlas).mockRejectedValue(new Error('sla.get: not supported'));

    const { text, meta } = await buildSnapshot();
    expect(text).toContain('High ICMP ping loss');
    expect(text).toContain('Zabbix service data unavailable');
    expect(text).toContain('derived SLA not available yet');
    expect(meta.slas).toBe(0);
  });

  it('uses the derived SLA and service lines when Zabbix has no services', async () => {
    vi.mocked(getServiceTree).mockResolvedValue({ tree: [], total: 0, degraded: 0, worst: -1 } as never);
    vi.mocked(derivedSlaLines).mockResolvedValue(['- August 2026 (strict): 96.10% overall, target 99% MISSED']);
    vi.mocked(derivedServiceLines).mockResolvedValue(['- FPSO KAS3 & BD-WHP / Access points: down']);

    const { text } = await buildSnapshot();
    expect(text).toContain('- August 2026 (strict): 96.10% overall, target 99% MISSED');
    expect(text).toContain('- FPSO KAS3 & BD-WHP / Access points: down');
    // Zabbix's own (empty) SLA is not reported as if it measured something.
    expect(text).not.toContain('Voice path 98.20%');
  });

  it('says how long an unreachable host has been down, preferring its ICMP problem', async () => {
    vi.mocked(getProblems).mockResolvedValue([
      problem(),
      problem({ eventid: '1', hostid: '10711', host: '4.3.4 FPSO ARUBA 4', name: 'No SNMP data collection', clock: String(NOW - 30 * 86_400) }),
      problem({ eventid: '2', hostid: '10711', host: '4.3.4 FPSO ARUBA 4', name: 'Unavailable by ICMP ping', severity: '4', clock: String(NOW - 2 * 86_400) }),
    ] as never);
    const { text } = await buildSnapshot();
    expect(text).toContain('- FPSO KAS3 & BD-WHP (1): 4.3.4 FPSO ARUBA 4 (2d)');
  });

  it('lists a host that answers ping while its SNMP is silent as not down', async () => {
    vi.mocked(getProblems).mockResolvedValue([
      problem(),
      problem({ eventid: '1', hostid: '10711', host: '4.3.4 FPSO ARUBA 4', name: 'No SNMP data collection', clock: String(NOW - 3 * 86_400) }),
      // Still open from before ping recovered: says nothing about how long SNMP has been silent.
      problem({ eventid: '2', hostid: '10711', host: '4.3.4 FPSO ARUBA 4', name: 'Unavailable by ICMP ping', clock: String(NOW - 3600) }),
    ] as never);
    vi.mocked(getSites).mockResolvedValue({
      sites: [site({ hosts: [host(), host({ hostid: '10711', name: '4.3.4 FPSO ARUBA 4', availability: 'unavailable', state: 'degraded', reason: 'snmp-silent' })] })],
      coverage: { hosts: 2, tag: 0, name: 2, inventory: 0, group: 0 },
    } as never);
    const { text } = await buildSnapshot();
    expect(text).toContain('- Not down, SNMP silent, no ping alarm (1): 4.3.4 FPSO ARUBA 4 (3d)');
    expect(text).toContain('0 unreachable, 1 SNMP silent without a ping alarm');
    expect(text).toContain('1 SNMP silent (no ping alarm)');
    expect(text).toContain('UNREACHABLE HOSTS (0,');
    expect(text).not.toContain('- FPSO KAS3 & BD-WHP (1):');
  });

  it('counts hosts by state, not by the interface flags: an unavailable interface that pings is up', async () => {
    vi.mocked(getSites).mockResolvedValue({
      sites: [
        site({
          total: 4,
          hosts: [
            host({ availability: 'unavailable', state: 'up', reason: 'ping' }),
            host({ hostid: '10711', name: '4.3.4 FPSO ARUBA 4', state: 'down' }),
            host({ hostid: '10712', name: '4.4.1 FPSO REPEATER DMR 1', availability: 'unknown', state: 'nodata', reason: 'no-interface' }),
            host({ hostid: '10713', name: '4.3.9 FPSO ARUBA 9', status: '1', state: 'disabled', reason: 'disabled' }),
          ],
        }),
      ],
      coverage: { hosts: 4, tag: 0, name: 4, inventory: 0, group: 0 },
    } as never);
    const { text } = await buildSnapshot();
    expect(text).toContain('ESTATE: 4 hosts at 1 sites; 1 reachable, 1 unreachable, 1 with no availability data, 1 disabled.');
    expect(text).toContain('- FPSO KAS3 & BD-WHP: 4 hosts, 1 unreachable, 1 no data, 1 problems');
    expect(text).toContain('UNREACHABLE HOSTS (1, by site');
  });

  it('does not wait more than ~1.5 s for a derived summary that is still computing', async () => {
    vi.mocked(getServiceTree).mockResolvedValue({ tree: [], total: 0, degraded: 0, worst: -1 } as never);
    vi.mocked(derivedSlaLines).mockImplementation(() => new Promise(() => undefined));

    const started = Date.now();
    const { text } = await buildSnapshot();
    expect(Date.now() - started).toBeLessThan(2_500);
    expect(text).toContain('derived SLA not available yet');
  });

  it('keeps every section and stays under the cap with 200 problems and a wide estate', async () => {
    const many = Array.from({ length: 200 }, (_, i) =>
      problem({
        eventid: String(i),
        severity: String(i % 6),
        clock: String(NOW - i * 900),
        host: `${(i % 14) + 1}.2.${i} SOME-LONG-SWITCH-NAME-${i}`,
        name: `Interface Gi1/0/${i}(uplink to somewhere far away): Link down`,
        opdata: 'Current state: down (2)',
        tags: [{ tag: 'component', value: 'network' }],
      }),
    );
    vi.mocked(getProblems).mockResolvedValue(many as never);
    const hosts = Array.from({ length: 40 }, (_, i) => ({
      hostid: String(i), name: `${(i % 14) + 1}.1.${i} FIREWALL-WITH-A-LONG-NAME-${i}`, status: '0',
      availability: 'unavailable', state: 'down', reason: 'ping', siteSource: 'group', problems: { total: 1, bySeverity: { '4': 1 } },
    }));
    const wide = Array.from({ length: 30 }, (_, i) =>
      site({ name: `Site ${i} with a long descriptive name`, hosts: i === 0 ? hosts : [], unavailable: i === 0 ? 40 : 0 }),
    );
    vi.mocked(getSites).mockResolvedValue({ sites: wide, coverage: { hosts: 60, tag: 60, inventory: 0, group: 0 } } as never);
    vi.mocked(getSli).mockResolvedValue(
      Array.from({ length: 40 }, (_, i) => ({ serviceid: String(i), name: `Service ${i}`, sli: 99.5, uptime: 1, downtime: 0, error_budget: 60, period_from: 0, period_to: 0 })) as never,
    );

    const { text, meta } = await buildSnapshot();
    expect(text.length).toBeLessThanOrEqual(SNAPSHOT_CHAR_CAP);
    for (const h of HEADERS) expect(text).toContain(h);
    expect(text).not.toMatch(/tags:/);
    expect(text).toMatch(/- …and \d+ more sites/);
    expect(text).toMatch(/OPEN PROBLEMS \(200, worst first\)/);
    expect(text).toMatch(/- …and \d+ more \((Disaster|High|Average|Warning|Information|Not classified) \d+/);
    const problemLines = text.split('OPEN PROBLEMS')[1].split('\n').filter((l) => l.startsWith('- ['));
    expect(problemLines.length).toBeGreaterThan(0);
    expect(problemLines.length).toBeLessThanOrEqual(20);
    expect(problemLines[0]).toContain('[Disaster]');
    expect(meta.truncated).toBe(true);
  });
});

describe('getSnapshot — one snapshot reused while nothing it describes changes', () => {
  afterEach(() => vi.useRealTimers());

  it('answers with byte-identical text minutes later, so the model can reuse its prompt cache', async () => {
    vi.mocked(getProblems).mockClear();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-17T08:00:00Z'));
    const first = await getSnapshot();

    // Two minutes on: the problems and sites caches have expired and been
    // refetched, but nothing in them changed.
    vi.setSystemTime(new Date('2026-09-17T08:02:00Z'));
    const second = await getSnapshot();

    expect(first.frozen).toBe(false);
    expect(second.frozen).toBe(true);
    expect(second.text).toBe(first.text);
    expect(second.text).toContain('15:00 WIB');
    expect(vi.mocked(getProblems)).toHaveBeenCalledTimes(2);
  });

  it('rebuilds at once when a problem is acknowledged', async () => {
    const first = await getSnapshot();
    expect(first.text).toContain('0 not acknowledged');

    vi.mocked(getProblems).mockResolvedValue([problem({ acknowledged: '0' })] as never);
    invalidate('problems'); // the 5 s TTL, passed
    const second = await getSnapshot();
    expect(second.frozen).toBe(false);
    expect(second.text).toContain('1 not acknowledged');
  });

  it('rebuilds for a host changing state once the snapshot is a minute old, not on every flap', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-17T08:00:00Z'));
    await getSnapshot();
    vi.mocked(getSites).mockResolvedValue({
      sites: [site({ hosts: [host(), host({ hostid: '10711', name: '4.3.4 FPSO ARUBA 4', state: 'degraded', reason: 'snmp-silent' })] })],
      coverage: { hosts: 2, tag: 0, name: 2, inventory: 0, group: 0 },
    } as never);

    // 20 s on (the sites cache has expired): a flap this young keeps the snapshot.
    vi.setSystemTime(new Date('2026-09-17T08:00:20Z'));
    const young = await getSnapshot();
    expect(young.frozen).toBe(true);
    expect(young.text).not.toContain('SNMP silent, no ping alarm');

    // A minute on, the change has held: rebuilt.
    vi.setSystemTime(new Date('2026-09-17T08:01:05Z'));
    const { text, frozen } = await getSnapshot();
    expect(frozen).toBe(false);
    expect(text).toContain('Not down, SNMP silent, no ping alarm (1): 4.3.4 FPSO ARUBA 4');
  });

  it('never keeps a snapshot whose derived SLA was still computing', async () => {
    vi.mocked(getServiceTree).mockResolvedValue({ tree: [], total: 0, degraded: 0, worst: -1 } as never);
    vi.mocked(derivedSlaLines).mockRejectedValueOnce(new Error('still computing'));
    vi.mocked(derivedServiceLines).mockResolvedValue(['- 9 · MBH: 51.07% this month']);
    const provisional = await getSnapshot();
    expect(provisional.text).toContain('derived SLA not available yet (still computing)');

    vi.mocked(derivedSlaLines).mockResolvedValue(['- 2026-08: 89.46% strict, missed']);
    const built = await getSnapshot();
    expect(built.frozen).toBe(false);
    expect(built.text).toContain('- 2026-08: 89.46% strict, missed');
    expect((await getSnapshot()).frozen).toBe(true);
  });

  it('keeps a finished snapshot whose derived services are simply all OK', async () => {
    vi.mocked(getServiceTree).mockResolvedValue({ tree: [], total: 0, degraded: 0, worst: -1 } as never);
    vi.mocked(derivedSlaLines).mockResolvedValue(['- 2026-08: 99.50% strict, met']);
    vi.mocked(derivedServiceLines).mockResolvedValue([]);
    const { text } = await getSnapshot();
    expect(text).toContain('DEGRADED SERVICES:\n- none, all services OK');
    expect((await getSnapshot()).frozen).toBe(true);
  });

  it('is dropped with the other problem caches after a write-back', async () => {
    await getSnapshot();
    invalidate(SNAPSHOT_KEY);
    expect((await getSnapshot()).frozen).toBe(false);
  });
});

describe('site focus', () => {
  const mopu = { code: 11, name: 'MOPU / MAC' };
  const mopuSite = site({
    name: 'MOPU / MAC',
    total: 5,
    hosts: [
      host({ hostid: '1', name: '11.1 FG-60F-MAC-MOPU-1', availability: 'unavailable', state: 'degraded', reason: 'snmp-silent' }),
      host({ hostid: '2', name: '11.2.1 MAC MOPU ACS 01' }),
      host({ hostid: '3', name: '11.3.1 MOPU ARUBA 1' }),
      host({ hostid: '4', name: '11.4.1 MOPU REPEATER DMR 1', availability: 'unknown', state: 'nodata', reason: 'no-interface' }),
      host({ hostid: '5', name: 'INET : MOPU WAN 1', availability: 'unknown', state: 'nodata', reason: 'no-interface' }),
    ],
  });
  const mopuProblems = [
    problem({ eventid: '10', hostid: '1', host: '11.1 FG-60F-MAC-MOPU-1', name: 'No SNMP data collection', severity: '2', acknowledged: '0', clock: String(NOW - 48 * 3600) }),
    problem({ eventid: '11', hostid: '2', host: '11.2.1 MAC MOPU ACS 01', name: 'Switch 1 - HotSpot Temp Sensor: Temperature is above critical threshold: >60', severity: '4', acknowledged: '0', clock: String(NOW - 20 * 86_400) }),
    problem({ eventid: '12', hostid: '2', host: '11.2.1 MAC MOPU ACS 01', name: 'Interface Gi1/0/22(Server SCADA): Link down', severity: '3', acknowledged: '0', clock: String(NOW - 270 * 86_400) }),
    problem({ eventid: '13', hostid: '2', host: '11.2.1 MAC MOPU ACS 01', name: 'Interface Gi1/0/19(): Ethernet has changed to lower speed than it was before', severity: '1', clock: String(NOW - 270 * 86_400) }),
    problem(), // another site's
  ];

  it('finds the sites a question names, by alias or name, in the order it names them', () => {
    expect(sitesNamed('Ada yang down di MOPU?')).toEqual([mopu]);
    expect(sitesNamed('anything wrong at mopu today')).toEqual([mopu]);
    expect(sitesNamed('Compare SSB with Pasuruan').map((s) => s.name)).toEqual(['SSB / Sampang', 'Pasuruan / GMS']);
    expect(sitesNamed('Is BD-WHP reachable?').map((s) => s.name)).toEqual(['FPSO KAS3 & BD-WHP']);
    expect(sitesNamed('Status 11.1 FG-60F-MAC-MOPU-1?')).toEqual([mopu]);
  });

  it('does not read everyday words or networking terms as short site codes', () => {
    // "pas" is Indonesian for "exactly" or "when"; MAC and STP are three letters too.
    expect(sitesNamed('Pas jam 3 tadi ada yang mati?')).toEqual([]);
    expect(sitesNamed('which switch has this mac address?')).toEqual([]);
    expect(sitesNamed('is stp blocking a port?')).toEqual([]);
    expect(sitesNamed('Why is the compass sam por mda odd')).toEqual([]);
    expect(sitesNamed('What needs attention right now?')).toEqual([]);
  });

  it('lists every host of the site under its state, with an SNMP-silent FortiGate as not down', () => {
    const text = focusBlock(mopu, [mopuSite, site()] as never, mopuProblems as never, NOW);

    expect(text.length).toBeLessThanOrEqual(800);
    expect(text).toContain('FOCUS: MOPU / MAC (5 hosts)');
    // Measured wording: see focusBlock. Without it the model answered "Ya" and named the FortiGate.
    expect(text).toContain('Down (0): none, no host at this site is down');
    expect(text).toContain('Not down: answers ping, only its SNMP monitoring is silent (1): 11.1 FG-60F-MAC-MOPU-1 (SNMP silent for 2d)');
    expect(text).toContain('No data (2): 11.4.1 MOPU REPEATER DMR 1, INET : MOPU WAN 1');
    expect(text).toContain('Up (2): 11.2.1 MAC MOPU ACS 01, 11.3.1 MOPU ARUBA 1');
    // The site's three worst problems, worst first; nothing from another site.
    expect(text).toContain('Open problems here: 4, worst first:');
    const listed = text.split('\n').filter((l) => l.startsWith('- ['));
    expect(listed).toHaveLength(3);
    expect(listed[0]).toContain('[High] 11.2.1 MAC MOPU ACS 01: Switch 1 - HotSpot Temp Sensor');
    expect(listed[2]).toContain('[Warning] 11.1 FG-60F-MAC-MOPU-1: No SNMP data collection; open 2d, not acked');
    expect(text).not.toContain('FPSO');
  });

  it('says how long a down host has been down, and stays within ~800 characters for a large site', () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      host({ hostid: String(100 + i), name: `1.2.${i} IDX-ACCESS-SWITCH-WITH-A-LONG-NAME-${i}`, state: i < 6 ? 'down' : 'up' }),
    );
    const problems = [
      problem({ hostid: '100', host: many[0].name, name: 'Unavailable by ICMP ping', severity: '4', clock: String(NOW - 5 * 86_400) }),
      ...Array.from({ length: 10 }, (_, i) =>
        problem({ eventid: String(i), hostid: '101', host: many[1].name, name: `Interface Gi1/0/${i}(uplink to a far away building): Link down`, severity: '3' }),
      ),
    ];
    const text = focusBlock({ code: 1, name: 'Jakarta' }, [site({ name: 'Jakarta', hosts: many })] as never, problems as never, NOW);

    expect(text.length).toBeLessThanOrEqual(800);
    expect(text).toMatch(/^Down \(6\): 1\.2\.0 IDX-ACCESS-SWITCH-WITH-A-LONG-NAME-0 \(for 5d\), .* \+\d more$/m);
    expect(text).toContain('Open problems here: 11, worst first:');
  });

  it('adds no focus when the question names no site', async () => {
    vi.mocked(getSites).mockClear();
    await expect(buildFocus('Which sites missed SLA last month?')).resolves.toBeNull();
    await expect(buildFocus('Kenapa?')).resolves.toBeNull();
    expect(getSites).not.toHaveBeenCalled();
  });

  it('builds the focus from the same cached data as the snapshot', async () => {
    const focus = await buildFocus('Ada yang down di FPSO?');
    expect(focus?.sites).toEqual(['FPSO KAS3 & BD-WHP']);
    expect(focus?.text).toContain('FOCUS: FPSO KAS3 & BD-WHP (2 hosts)');
    expect(focus?.text).toContain('Down (1): 4.3.4 FPSO ARUBA 4');
  });
});

describe('section', () => {
  it('adds whole lines until the budget, then says how many were left out', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `- line number ${i}`);
    const { text, truncated } = section('TITLE:', lines, 80);
    expect(text.length).toBeLessThanOrEqual(80);
    expect(truncated).toBe(true);
    const shown = text.split('\n').filter((l) => l.startsWith('- line'));
    expect(text).toContain(`- …and ${10 - shown.length} more`);
    // Never a cut-off line.
    for (const l of shown) expect(lines).toContain(l);
  });

  it('is untouched when everything fits', () => {
    expect(section('T:', ['- a', '- b'], 100)).toEqual({ text: 'T:\n- a\n- b', truncated: false });
  });
});

describe('age', () => {
  const now = 1_800_000_000;
  it('never rounds the hours part up to "24h"', () => {
    expect(age(now - (7 * 86_400 + 23 * 3600 + 45 * 60), now)).toBe('8d');
    expect(age(now - (86_400 - 20 * 60), now)).toBe('1d');
    for (let s = 0; s < 30 * 86_400; s += 997) expect(age(now - s, now)).not.toMatch(/24h/);
  });
  it('reads naturally at each scale', () => {
    // "min", never "m": qwen3 read a host down for "6m" as down for 6 months.
    expect(age(now - 45 * 60, now)).toBe('45 min');
    expect(age(now - 3 * 3600, now)).toBe('3h');
    expect(age(now - 2 * 86_400, now)).toBe('2d');
    expect(age(now - (7 * 86_400 + 23 * 3600), now)).toBe('7d 23h');
    expect(age(now + 60, now)).toBe('0 min');
  });
});

describe('prompt', () => {
  it('tells the model to answer in the language of the question and keep names as written', () => {
    expect(CHAT_SYSTEM).toMatch(/language of the user's latest message/);
    expect(CHAT_SYSTEM).toMatch(/Bahasa Indonesia/);
    expect(CHAT_SYSTEM).toMatch(/Never translate host names or site names/);
    expect(CHAT_SYSTEM).not.toMatch(/No markdown/i);
  });

  it('detects English and Indonesian questions for the reminder after the snapshot', () => {
    expect(detectLanguage('Ada yang down di MOPU?')).toBe('Bahasa Indonesia');
    expect(detectLanguage('Which site is worst right now?')).toBe('English');
    expect(detectLanguage("Summarize today's high severity problems")).toBe('English');
    expect(detectLanguage('MOPU?')).toBeNull();
    expect(languageReminder('Berapa host yang mati hari ini?')).toContain('Reply in Bahasa Indonesia');
    expect(languageReminder('MOPU?')).toContain('same language');
  });
});

describe('cleanAnswer', () => {
  it('strips think blocks and extra blank lines', () => {
    expect(cleanAnswer('<think>\nhmm\n</think>\n\nYes.\n\n\n\nTwo hosts.')).toBe('Yes.\n\nTwo hosts.');
  });

  it('drops a boilerplate page pointer when it is the last sentence', () => {
    expect(cleanAnswer('Three hosts are down at MOPU. For more details, check the Problems page.')).toBe(
      'Three hosts are down at MOPU.',
    );
    expect(cleanAnswer('Ya, 2 perangkat di MOPU down.\n\nSilakan cek halaman Problems.')).toBe(
      'Ya, 2 perangkat di MOPU down.',
    );
    expect(cleanAnswer('Jakarta is fine.\n- a\n- b\n\nYou can check the Sites page for more.')).toBe(
      'Jakarta is fine.\n- a\n- b',
    );
  });

  it('keeps a page pointer that is the whole answer or not at the end', () => {
    expect(cleanAnswer('The snapshot has no interface data; check the Network page.')).toBe(
      'The snapshot has no interface data; check the Network page.',
    );
    expect(cleanAnswer('Check the SLA page first. Then MOPU is the worst site.')).toBe(
      'Check the SLA page first. Then MOPU is the worst site.',
    );
  });
});

describe('readOpenAiStream', () => {
  const frame = (delta: Record<string, unknown>) =>
    `data: ${JSON.stringify({ choices: [{ delta, finish_reason: null }] })}\n`;

  it('concatenates content deltas and stops at [DONE]', async () => {
    const body = stream(frame({ content: 'Hel' }) + frame({ content: 'lo' }) + 'data: [DONE]\n' + frame({ content: 'ignored' }));
    expect(await collect(readOpenAiStream(body))).toBe('Hello');
  });

  it('drops reasoning frames so the reader never sees the model thinking', async () => {
    const body = stream(
      frame({ role: 'assistant', content: '', reasoning: 'Okay, the user' }) +
        frame({ content: '', reasoning: ' asks…' }) +
        frame({ content: 'A NOC is' }) +
        'data: [DONE]\n',
    );
    expect(await collect(readOpenAiStream(body))).toBe('A NOC is');
  });

  it('survives a frame split across two chunks', async () => {
    const whole = frame({ content: 'split' });
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        const bytes = new TextEncoder().encode(whole);
        c.enqueue(bytes.slice(0, 20));
        c.enqueue(bytes.slice(20));
        c.enqueue(new TextEncoder().encode('data: [DONE]\n'));
        c.close();
      },
    });
    expect(await collect(readOpenAiStream(body))).toBe('split');
  });

  it('skips a malformed frame instead of aborting the answer', async () => {
    const body = stream('data: {not json\n' + frame({ content: 'fine' }) + 'data: [DONE]\n');
    expect(await collect(readOpenAiStream(body))).toBe('fine');
  });
});
