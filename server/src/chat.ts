import { createHash } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';
import { cached, invalidate } from './cache.js';
import { getProblems, SEVERITY_NAMES, type ZbxProblem } from './queries.js';
import { getSites, type Site, type SiteHost } from './routes/sites.js';
import { getSlas, getSli, type SlaSli, type ZbxSla } from './routes/sla.js';
import { getServiceTree, type ServiceNode } from './routes/services.js';
import { siteFromHostName, naturalCompare, SITES, type SiteRef } from './naming.js';
import { derivedServiceLines, derivedSlaLines } from './sli/summary.js';
import type { HostState } from './reachability.js';
import {
  acquireModelSlot,
  AiDisabledError,
  AiUpstreamError,
  getAnthropic,
  ollamaChatBody,
  ollamaRoot,
  postModel,
  readOllamaStream,
  thinkingControl,
  usesOllamaNative,
  type OllamaStats,
} from './ai.js';

/**
 * The assistant (chat) behind the sidebar's "Ask the assistant" page.
 *
 * Where `ai.ts` rewrites *one* Zabbix artifact into a fixed schema, this
 * answers free-form questions about the estate. It is still not an agent: the
 * model is handed a read-only SNAPSHOT of what the portal already shows,
 * open problems, sites, unreachable hosts, SLA standing, degraded services,
 * and told to answer from that alone. It has no tools, cannot query Zabbix and
 * cannot change anything, so the worst a bad answer can do is be wrong.
 *
 * Everything in the snapshot comes from the same cached queries the pages use,
 * under the same cache keys, so a busy chat costs Zabbix nothing extra.
 */

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

/** What the model was shown, surfaced to the UI so the reader knows the scope. */
export interface SnapshotMeta {
  generatedAt: number;
  hosts: number;
  sites: number;
  problems: number;
  unacknowledged: number;
  slas: number;
  degradedServices: number;
  /** Some list was cut to fit the model's context window. */
  truncated: boolean;
}

export interface Snapshot {
  text: string;
  meta: SnapshotMeta;
  /** Characters per section, for logging only. */
  sizes: Record<string, number>;
  /** What the text was built from. See `snapshotFingerprint`. */
  fingerprint: string;
  /** False when a derived SLA or services summary was still computing. */
  complete: boolean;
}

/**
 * Budgets. A prompt that overflows the model's context window is cut from the
 * *front*, which silently drops the system prompt and its rules. Native
 * Ollama gets AI_NUM_CTX (8192 tokens); through `/v1` Ollama's default of 4096
 * applies, and a full prompt nearly fills it. So the snapshot is capped in
 * characters (~4 per token) rather than trusted to fit.
 *
 * The cap is met by construction: every section has its own budget and adds
 * whole lines until it is spent, so the facts a question most often needs
 * (estate, sites, what is new, what is down) can never be pushed out by a long
 * problem list, which is how the model once named a host as the "worst site".
 */
export const SNAPSHOT_CHAR_CAP = 5_500;
const ANSWER_MAX_TOKENS = 700;
const BUDGET = {
  estate: 350,
  sites: 900,
  recent: 550,
  unreachable: 850,
  sla: 700,
  services: 400,
  problems: 1_850,
};
const RECENT_CAP = 8;
const PROBLEM_CAP = 20;
const HOSTS_PER_SITE_LINE = 4;
/** Problem names that mean "this host cannot be reached". */
const UNAVAILABLE_PROBLEM = /unavailable by icmp|not available|unreachable|no snmp data/i;
/** How long the snapshot waits for the derived SLA / service summaries. */
const DERIVED_WAIT_MS = 1_500;

export const CHAT_SYSTEM = [
  'You are a colleague in the NOC of HCML, an oil & gas operator (offshore platforms, onshore',
  'plants, corporate offices), answering questions inside its read-only Zabbix monitoring portal.',
  'You are given a SNAPSHOT of the live monitoring data; its first line says when it was taken.',
  '',
  'How to answer:',
  '- Reply in the language of the user\'s latest message: Bahasa Indonesia if they wrote in',
  '  Indonesian, English if they wrote in English. Never translate host names or site names;',
  '  copy them exactly as they appear in the snapshot.',
  '- Put the answer in the first sentence. Then add only the detail that helps: usually 2 to 4',
  '  short sentences in total.',
  '- Talk like a helpful NOC colleague, not a report. Use natural durations ("about 3 hours",',
  '  "since yesterday", "sekitar 2 jam") instead of raw figures like "3h" or "1d 2h".',
  '- Light markdown is fine: **bold** for a key host, site or number, and "- " bullets only',
  '  when you list 3 or more things. No headings, no tables.',
  '- Start straight with the answer: no greeting, no "Based on the snapshot". End when the',
  '  answer is complete: no closing offers and no "check the X page" sign-off.',
  '- Name a portal page (Problems, Sites, Hosts, Services, SLA, Reports) only when the',
  '  snapshot does not contain what was asked, and say so plainly.',
  '',
  'What you may say:',
  '- Use only the snapshot. Never invent hosts, sites, numbers, durations or causes; describe what the',
  '  data shows, not a guessed root cause. A list ending in "…and N more" is incomplete, so',
  '  give the total rather than implying you have seen every item.',
  '- "Worst site" means the site ranked first in SITES, not a single host. "Today", "new" or',
  '  "hari ini" means the NEW IN LAST 24 H section; the ages in OPEN PROBLEMS say how old each is.',
  '- Keep each fact with its own line: a problem belongs to the host on the same line.',
  '- "Down", "unreachable" or "mati" means a host listed under UNREACHABLE HOSTS by site. An open',
  '  problem (temperature, link, SNMP) does not make a host down, and hosts under "Not down, SNMP',
  '  silent" are not down. If a site has no unreachable hosts, say no and mention its worst problem.',
  '- A FOCUS block after the snapshot lists every host of the site the user named, by state, and',
  '  that site\'s worst problems. For that site, answer from it.',
  '- When a line says "All N", give all N items, not a few of them.',
  '- You cannot change anything. If asked to acknowledge, close or fix something, say that',
  '  operators do that from the Problems page.',
  '',
  'Example of the style only. Take every name, number and duration from the snapshot, never from',
  'this example:',
  'User: Ada yang down di <site>?',
  'Assistant: Ya, **2 perangkat** di <site> tidak bisa dijangkau: **<host A>** dan **<host B>**,',
  'sudah sekitar 3 hari. Keduanya belum di-acknowledge.',
].join('\n');

const ID_WORDS = new Set(
  ('ada yang di apa apakah tidak nggak gak enggak dan berapa mana mana saja sekarang saat ini itu sudah ' +
    'belum bisa saja kah gimana bagaimana kenapa mengapa dengan untuk dari ke masalah perangkat terburuk ' +
    'paling tolong coba jelaskan ringkas ringkasan hari kemarin lalu jam menit mati putus semua lagi atau ' +
    'siapa kapan kok dong ya yg tdk sdh blm lokasi situs banyak')
    .split(' '),
);
const EN_WORDS = new Set(
  ('the is are was were what which who when where why how any anything there this that right now today ' +
    'yesterday worst best down up and or of in on at to for with from me my show list give tell summarize ' +
    'summary please can could should do does did have has problems problem hosts host sites site last ' +
    'about than more most many much it its be been')
    .split(' '),
);

/**
 * English or Indonesian, from the words of the message. A small model given
 * an Indonesian example tends to answer everything in Indonesian, so the
 * language is decided here and stated outright; `null` when it is unclear.
 */
export function detectLanguage(text: string): 'English' | 'Bahasa Indonesia' | null {
  let id = 0;
  let en = 0;
  for (const word of text.toLowerCase().match(/[a-z]+/g) ?? []) {
    if (ID_WORDS.has(word)) id++;
    else if (EN_WORDS.has(word)) en++;
  }
  if (id > en) return 'Bahasa Indonesia';
  if (en > id) return 'English';
  return null;
}

/** Placed after the snapshot, next to the question, where a small model heeds it. */
export function languageReminder(latestUserMessage: string): string {
  const lang = detectLanguage(latestUserMessage);
  return lang
    ? `The user's latest message is in ${lang}. Reply in ${lang}; keep host and site names exactly as written.`
    : "Reply in the same language as the user's latest message (English or Bahasa Indonesia).";
}

/**
 * The part of the system text that is the same for every question asked of
 * one snapshot, and so the part Ollama can keep in its prompt cache. What is
 * particular to a question, a site focus, the language line, comes after.
 */
export function systemText(snapshot: string): string {
  return `${CHAT_SYSTEM}\n\n${snapshot}`;
}


/**
 * A compact age for the snapshot: "45 min", "3h", "2d", "7d 23h". Whole hours
 * are rounded *before* splitting into days, so 7d 23h 45m reads "8d", never
 * the "7d 24h" the old split produced. Minutes are "min", not "m": the model
 * read a host down for "6m" as down for about 6 months.
 */
export function age(clock: string | number, nowSeconds: number): string {
  const s = Math.max(0, nowSeconds - Number(clock));
  if (s < 3600 - 30) return `${Math.round(s / 60)} min`;
  const hours = Math.max(1, Math.round(s / 3600));
  if (hours < 24) return `${hours}h`;
  const d = Math.floor(hours / 24);
  const h = hours % 24;
  return h ? `${d}d ${h}h` : `${d}d`;
}

/** Whole days past 48 h: "80d" says as much as "80d 20h" in fewer characters. */
function downFor(clock: number, now: number): string {
  return now - clock >= 172_800 ? `${Math.round((now - clock) / 86_400)}d` : age(clock, now);
}

const minutes = (seconds: number) => `${Math.round(seconds / 60)} min`;
const sevName = (sev: string | number) => SEVERITY_NAMES[String(sev)] ?? `severity ${sev}`;

/**
 * One titled block of whole lines, never longer than `budget` characters.
 * Lines are added in order until the next one (plus the "…and N more" tail it
 * would need) no longer fits; the tail then says how much was left out, so the
 * model never mistakes a partial list for the whole.
 */
export function section(
  title: string,
  lines: string[],
  budget: number,
  more: (left: number, shown: number) => string = (left) => `- …and ${left} more`,
  total = lines.length,
): { text: string; truncated: boolean } {
  let text = title;
  let shown = 0;
  for (const line of lines) {
    const left = total - shown - 1;
    const tail = left > 0 ? `\n${more(left, shown + 1)}` : '';
    if (text.length + 1 + line.length + tail.length > budget) break;
    text += `\n${line}`;
    shown++;
  }
  const left = total - shown;
  if (left > 0) {
    const tail = more(left, shown);
    // A tail that cannot fit even alone is dropped rather than overflowing.
    if (text.length + 1 + tail.length <= budget) text += `\n${tail}`;
  }
  return { text, truncated: left > 0 };
}

function severityCounts(problems: ZbxProblem[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const p of problems) counts[p.severity] = (counts[p.severity] ?? 0) + 1;
  return counts;
}

/** "Disaster 0, High 10, Average 31, Warning 600", worst first. */
function severityList(counts: Record<string, number>, skipZero = false): string {
  return ['5', '4', '3', '2', '1', '0']
    .filter((s) => !skipZero || counts[s])
    .map((s) => `${sevName(s)} ${counts[s] ?? 0}`)
    .join(', ');
}

function problemLine(p: ZbxProblem, now: number): string {
  const opdata = p.opdata && p.opdata.length <= 30 ? ` (${p.opdata})` : '';
  const ack = p.acknowledged === '1' ? 'acked' : 'not acked';
  return `- [${sevName(p.severity)}] ${p.host || 'unknown host'}: ${p.name}${opdata}; open ${age(p.clock, now)}, ${ack}`;
}

/** Worst first, then newest. */
const worstFirst = (a: ZbxProblem, b: ZbxProblem) =>
  Number(b.severity) - Number(a.severity) || Number(b.clock) - Number(a.clock);

/** Hosts per state (reachability.ts): ping first, the interface flags only without a recent ping. */
function stateCounts(hosts: SiteHost[]): Record<HostState, number> {
  const counts: Record<HostState, number> = { up: 0, down: 0, degraded: 0, nodata: 0, disabled: 0 };
  for (const h of hosts) counts[h.state]++;
  return counts;
}

function siteLine(s: Site): string {
  const c = stateCounts(s.hosts);
  const bits = [`${s.total} host${s.total === 1 ? '' : 's'}`];
  if (c.down) bits.push(`${c.down} unreachable`);
  if (c.degraded) bits.push(`${c.degraded} SNMP silent (no ping alarm)`);
  if (c.nodata) bits.push(`${c.nodata} no data`);
  bits.push(`${s.problems} problems`);
  const high = (s.bySeverity['5'] ?? 0) + (s.bySeverity['4'] ?? 0);
  if (high) bits.push(`${high} High/Disaster`);
  bits.push(`worst ${s.worst >= 0 ? sevName(s.worst) : 'none'}`);
  return `- ${s.name}: ${bits.join(', ')}`;
}

type AvailabilitySince = Map<string, { icmp?: number; other?: number }>;

/**
 * When each host's open availability problems began: the oldest ICMP one and
 * the oldest other one (SNMP, agent). How long a host has been down comes from
 * here, otherwise the model invents a duration.
 */
function availabilitySince(problems: ZbxProblem[]): AvailabilitySince {
  const since: AvailabilitySince = new Map();
  for (const p of problems) {
    if (!p.hostid || !UNAVAILABLE_PROBLEM.test(p.name)) continue;
    const kind = /icmp/i.test(p.name) ? 'icmp' : 'other';
    const clock = Number(p.clock);
    const entry = since.get(p.hostid) ?? {};
    entry[kind] = Math.min(entry[kind] ?? clock, clock);
    since.set(p.hostid, entry);
  }
  return since;
}

/**
 * Since when a host has been in its state. Down: from its ICMP problem, else
 * any availability problem. Degraded: from its SNMP or agent problem only: the
 * host answers ping, so an ICMP problem still open says nothing about it.
 */
function stateSince(h: SiteHost, since: AvailabilitySince): number | undefined {
  const s = since.get(h.hostid);
  if (h.state === 'down') return s?.icmp ?? s?.other;
  if (h.state === 'degraded') return s?.other;
  return undefined;
}

function slaLines(sla: ZbxSla, rows: SlaSli[]): string[] {
  const target = Number(sla.slo);
  if (!rows.length) return [`- ${sla.name} (target ${sla.slo}%): no services attached`];
  return rows.map((r) => {
    const met = r.sli >= target;
    return (
      `- ${sla.name} (target ${sla.slo}%): ${r.name} ${r.sli.toFixed(2)}%, ${met ? 'on target' : 'MISSED'}, ` +
      `error budget ${r.error_budget < 0 ? 'exceeded by ' : 'left '}${minutes(Math.abs(r.error_budget))}`
    );
  });
}

/**
 * Every service once. Zabbix services form a DAG, not a tree (§15): a shared
 * core sits under two parents, so a naive walk lists it, and counts it, twice.
 */
function flatten(nodes: ServiceNode[], seen = new Map<string, ServiceNode>()): ServiceNode[] {
  for (const n of nodes) {
    if (seen.has(n.serviceid)) continue;
    seen.set(n.serviceid, n);
    flatten(n.children, seen);
  }
  return [...seen.values()];
}

/** The derived summaries may still be computing; never hold the answer for them. */
async function withinDeadline(fn: () => Promise<string[]>, ms = DERIVED_WAIT_MS): Promise<string[] | null> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([fn().catch(() => null), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

const WIB = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Jakarta',
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/**
 * The estate as compact plain text. Plain text rather than JSON on purpose:
 * it is roughly half the tokens for the same facts, and a small model reads
 * "3 hosts, 1 unreachable" more reliably than nested braces.
 *
 * Built fresh on every call; the assistant answers from `getSnapshot`, which
 * reuses one.
 */
export async function buildSnapshot(): Promise<Snapshot> {
  const now = Math.floor(Date.now() / 1000);

  // Started first so their deadline runs alongside the core queries.
  const derivedSla = withinDeadline(derivedSlaLines);
  const derivedSvc = withinDeadline(derivedServiceLines);

  // Problems and sites are the core of any answer; SLA and services are
  // valuable but optional: a Zabbix without Services configured must not
  // leave the assistant unable to say what is down.
  const [problems, sitesRes] = await Promise.all([
    cached('problems', 5_000, getProblems),
    cached('sites', 15_000, getSites),
  ]);
  const [slaRes, svcRes] = await Promise.allSettled([
    cached('sla', 60_000, getSlas),
    cached('services:tree', 30_000, getServiceTree),
  ]);

  const sections: Record<string, { text: string; truncated: boolean }> = {};
  const since = availabilitySince(problems);

  /* 1. header + estate */
  // Host states come from reachability.ts: "down" means ping fails (or, with
  // no recent ping, the interface is unavailable); "degraded" answers ping
  // while SNMP or the agent is silent, and is not down.
  const hosts = sitesRes.sites.reduce((n, s) => n + s.total, 0);
  const all = stateCounts(sitesRes.sites.flatMap((s) => s.hosts));
  const unacknowledged = problems.filter((p) => p.acknowledged !== '1').length;
  sections.estate = section(
    `SNAPSHOT taken ${WIB.format(new Date(now * 1000))} WIB (Asia/Jakarta)`,
    [
      `ESTATE: ${hosts} hosts at ${sitesRes.sites.length} sites; ${all.up} reachable, ` +
        `${all.down} unreachable${all.degraded ? `, ${all.degraded} SNMP silent without a ping alarm` : ''}, ` +
        `${all.nodata} with no availability data${all.disabled ? `, ${all.disabled} disabled` : ''}.`,
      `Open problems: ${problems.length} (${severityList(severityCounts(problems))}); ` +
        `${unacknowledged} not acknowledged.`,
    ],
    BUDGET.estate,
  );

  /* 5 + 6. SLA and services: Zabbix's own when it has services, else derived */
  let slaCount = 0;
  let degradedCount = 0;
  let complete = true;
  const realServices = svcRes.status === 'fulfilled' && flatten(svcRes.value.tree).length > 0;
  const slaOut: string[] = [];
  const svcOut: string[] = [];

  if (slaRes.status === 'fulfilled') slaCount = slaRes.value.filter((s) => s.status !== '0').length;

  if (realServices && svcRes.status === 'fulfilled') {
    if (slaRes.status !== 'fulfilled') {
      slaOut.push('- Zabbix SLA data unavailable right now');
    } else {
      const enabled = slaRes.value.filter((s) => s.status !== '0');
      const slis = await Promise.all(
        enabled.map((s) => cached(`sli:${s.slaid}:all`, 60_000, () => getSli(s.slaid)).catch(() => [])),
      );
      if (!enabled.length) slaOut.push('- no SLAs defined in Zabbix');
      enabled.forEach((s, i) => slaOut.push(...slaLines(s, slis[i])));
    }
    const degraded = flatten(svcRes.value.tree).filter((n) => n.status >= 0);
    degradedCount = degraded.length;
    if (!degraded.length) svcOut.push('- none, all services OK');
    for (const n of degraded) {
      const causes = n.problems.map((p) => p.name).slice(0, 3).join('; ');
      svcOut.push(`- ${n.name}: ${sevName(n.status)}${causes ? ` — caused by: ${causes}` : ''}`);
    }
  } else {
    const note =
      svcRes.status === 'fulfilled'
        ? 'Zabbix has no services configured, so figures below are derived by the portal.'
        : 'Zabbix service data unavailable right now; figures below are derived by the portal.';
    const [slaLinesDerived, svcLinesDerived] = await Promise.all([derivedSla, derivedSvc]);
    if (slaLinesDerived?.length) slaOut.push(...slaLinesDerived);
    else slaOut.push(`- ${note}`, '- derived SLA not available yet (still computing)');
    // `null` is a summary that missed its deadline or failed; an empty list
    // is one that finished and found nothing degraded.
    if (svcLinesDerived === null) svcOut.push('- derived services not available yet (still computing)');
    else if (!svcLinesDerived.length) svcOut.push('- none, all services OK');
    else svcOut.push(...svcLinesDerived);
    complete = Boolean(slaLinesDerived?.length) && svcLinesDerived !== null;
  }
  sections.sla = section('SLA:', slaOut, BUDGET.sla);
  sections.services = section('DEGRADED SERVICES:', svcOut, BUDGET.services);

  // SLA and services are often a line or two; what they leave unused goes to
  // the site and unreachable lists, which are what most questions are about.
  let slack =
    BUDGET.sla - sections.sla.text.length + (BUDGET.services - sections.services.text.length);
  const siteExtra = Math.min(slack, 500);
  slack -= siteExtra;
  const unreachableExtra = Math.min(slack, 400);


  /* 2. sites, worst first (getSites' order) */
  sections.sites = section(
    `SITES (${sitesRes.sites.length}, worst first: highest open severity, then most hosts down):`,
    sitesRes.sites.length ? sitesRes.sites.map(siteLine) : ['- none'],
    BUDGET.sites + siteExtra,
    (left) => `- …and ${left} more sites`,
  );

  /* 3. new in the last 24 h, newest first */
  const recent = problems
    .filter((p) => now - Number(p.clock) <= 86_400)
    .sort((a, b) => Number(b.clock) - Number(a.clock));
  const recentShown = recent.slice(0, RECENT_CAP).map((p) => problemLine(p, now));
  sections.recent = section(
    `NEW IN LAST 24 H: ${recent.length} problems opened` +
      (recent.length ? ` (${severityList(severityCounts(recent), true)}), newest first:` : '.'),
    recentShown,
    BUDGET.recent,
    (left) => `- …and ${left} older ones from the last 24 h`,
    recent.length,
  );

  /* 4. unreachable hosts, grouped by the site their name says */
  const bySite = new Map<string, string[]>();
  const silent: string[] = [];
  for (const s of sitesRes.sites) {
    for (const h of s.hosts) {
      if (h.state !== 'down' && h.state !== 'degraded') continue;
      const clock = stateSince(h, since);
      const label = clock === undefined ? h.name : `${h.name} (${downFor(clock, now)})`;
      // Answers ping, so not "down": the model otherwise reports these as outages.
      if (h.state === 'degraded') {
        silent.push(label);
        continue;
      }
      const name = siteFromHostName(h.name)?.name ?? s.name;
      const list = bySite.get(name) ?? [];
      list.push(label);
      bySite.set(name, list);
    }
  }
  const unreachableLines = [...bySite.entries()]
    .sort((a, b) => b[1].length - a[1].length || naturalCompare(a[0], b[0]))
    .map(([name, list]) => {
      const sorted = [...list].sort(naturalCompare);
      const shown = sorted.slice(0, HOSTS_PER_SITE_LINE).join(', ');
      const extra = sorted.length > HOSTS_PER_SITE_LINE ? ` +${sorted.length - HOSTS_PER_SITE_LINE} more` : '';
      return `- ${name} (${sorted.length}): ${shown}${extra}`;
    });
  if (silent.length) {
    unreachableLines.push(`- Not down, SNMP silent, no ping alarm (${silent.length}): ${silent.sort(naturalCompare).join(', ')}`);
  }
  sections.unreachable = section(
    `UNREACHABLE HOSTS (${all.down}, by site; how long down in brackets):`,
    unreachableLines.length ? unreachableLines : ['- none'],
    BUDGET.unreachable + unreachableExtra,
    (left) => `- …and ${left} more sites with unreachable hosts`,
  );

  /* 7. open problems, worst first then newest, with whatever budget is left */
  const ordered = [...problems].sort(worstFirst);
  const used = Object.values(sections).reduce((n, s) => n + s.text.length + 2, 0);
  const problemBudget = Math.min(BUDGET.problems, SNAPSHOT_CHAR_CAP - used);
  const listed = ordered.slice(0, PROBLEM_CAP).map((p) => problemLine(p, now));
  const restCounts = (shown: number) => severityList(severityCounts(ordered.slice(shown)), true);
  sections.problems = section(
    `OPEN PROBLEMS (${ordered.length}, worst first):`,
    ordered.length ? listed : ['- none'],
    problemBudget,
    (left, shown) => `- …and ${left} more (${restCounts(shown)})`,
    Math.max(ordered.length, 1),
  );

  const order = ['estate', 'sites', 'recent', 'unreachable', 'sla', 'services', 'problems'];
  const text = order.map((k) => sections[k].text).join('\n\n');
  const truncated = Object.values(sections).some((s) => s.truncated);
  const sizes = Object.fromEntries(order.map((k) => [k, sections[k].text.length]));

  return {
    text,
    sizes: { ...sizes, total: text.length },
    meta: {
      generatedAt: now * 1000,
      hosts,
      sites: sitesRes.sites.length,
      problems: problems.length,
      unacknowledged,
      slas: slaCount,
      degradedServices: degradedCount,
      truncated,
    },
    fingerprint: snapshotFingerprint(problems, sitesRes.sites),
    complete,
  };
}

// the frozen snapshot

export const SNAPSHOT_KEY = 'chat:snapshot';
/** The longest one snapshot is reused while nothing it describes changes. */
const SNAPSHOT_FREEZE_MS = 5 * 60_000;
/**
 * How long a snapshot is kept when only host states changed. FPSO's radio
 * links flip between up and down every ~16 s; rebuilding, and re-reading
 * ~2,400 tokens, on each flip would undo the freeze exactly when the estate
 * is busiest. Problems changing still rebuild at once.
 */
const HOST_STATE_SETTLE_MS = 60_000;

/**
 * What must not change under a frozen snapshot: each open problem's id,
 * severity and acknowledgement (before the dot), and each host's state (after
 * it). The rest of the text, ages, opdata, SLA figures, may lag by up to
 * five minutes.
 */
export function snapshotFingerprint(problems: ZbxProblem[], sites: Site[]): string {
  const problemHash = createHash('sha1');
  for (const p of problems) problemHash.update(`${p.eventid}:${p.severity}:${p.acknowledged}\n`);
  const hostHash = createHash('sha1');
  for (const s of sites) {
    for (const h of s.hosts) hostHash.update(`${h.hostid}:${h.state}\n`);
  }
  return `${problemHash.digest('hex')}.${hostHash.digest('hex')}`;
}

/** Thrown through `cached`, so a snapshot still missing its SLA is answered from once and never stored. */
class IncompleteSnapshot extends Error {
  constructor(readonly snapshot: Snapshot) {
    super('snapshot still computing');
  }
}

/**
 * The snapshot to answer from, reused for up to five minutes.
 *
 * A local model reads every token it has not read before, at ~330 tokens/s. A
 * snapshot rebuilt for each question differed from the previous one in its
 * first line (the time it was taken), so every question re-read ~2,000 tokens
 *: 6–8 s before the first word. Reused, the system text is byte-identical
 * from one question to the next and Ollama serves it from its prompt cache.
 *
 * Reused is not stale where it matters: a problem opening, closing, being
 * acknowledged or re-graded rebuilds it at once, and a host changing state
 * rebuilds it once the snapshot is a minute old (`snapshotFingerprint`,
 * `HOST_STATE_SETTLE_MS`); one built while the derived SLA or services were
 * still computing is never kept; and a write-back invalidates `chat:snapshot`
 * with the other caches that show problem state.
 */
export async function getSnapshot(): Promise<Snapshot & { frozen: boolean }> {
  const [problems, sitesRes] = await Promise.all([
    cached('problems', 5_000, getProblems),
    cached('sites', 15_000, getSites),
  ]);
  const fingerprint = snapshotFingerprint(problems, sitesRes.sites);
  let built = false;
  const build = async () => {
    built = true;
    const snapshot = await buildSnapshot();
    if (!snapshot.complete) throw new IncompleteSnapshot(snapshot);
    return snapshot;
  };
  try {
    let snapshot = await cached(SNAPSHOT_KEY, SNAPSHOT_FREEZE_MS, build);
    if (!built && snapshot.fingerprint !== fingerprint) {
      const problemsChanged = snapshot.fingerprint.split('.')[0] !== fingerprint.split('.')[0];
      const settled = Date.now() - snapshot.meta.generatedAt >= HOST_STATE_SETTLE_MS;
      if (problemsChanged || settled) {
        invalidate(SNAPSHOT_KEY);
        snapshot = await cached(SNAPSHOT_KEY, SNAPSHOT_FREEZE_MS, build);
      }
    }
    return { ...snapshot, frozen: !built };
  } catch (err) {
    if (err instanceof IncompleteSnapshot) return { ...err.snapshot, frozen: false };
    throw err;
  }
}


const FOCUS_BUDGET = 800;
/** A question naming more sites than this is a comparison; SITES covers it. */
const FOCUS_SITES = 2;
const FOCUS_PROBLEMS = 3;

/**
 * A site name as a whole word. Names of three letters or fewer count only in
 * capitals, the way the NOC writes site codes: "pas" is everyday Indonesian,
 * and "mac address" is not MOPU / MAC.
 */
function sitePattern(term: string): RegExp {
  const source = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[\s-]+/g, '[\\s-]*');
  return new RegExp(`\\b${source}\\b`, term.replace(/[^A-Za-z0-9]/g, '').length <= 3 ? '' : 'i');
}

/** Each site with what names it: its aliases and the parts of its display name. */
const SITE_NAMES = SITES.map((site) => {
  const terms = new Map<string, string>();
  for (const raw of [...site.aliases, ...site.name.split(/[/&]/)]) {
    const term = raw.trim();
    if (term && !terms.has(term.toUpperCase())) terms.set(term.toUpperCase(), term);
  }
  return { site: { code: site.code, name: site.name }, patterns: [...terms.values()].map(sitePattern) };
});

/** The sites a message names, in the order it names them. */
export function sitesNamed(text: string): SiteRef[] {
  return SITE_NAMES.map(({ site, patterns }) => ({
    site,
    at: Math.min(...patterns.map((re) => text.search(re)).map((i) => (i < 0 ? Infinity : i))),
  }))
    .filter((m) => m.at < Infinity)
    .sort((a, b) => a.at - b.at)
    .map((m) => m.site);
}

/** Names up to about `chars`, then how many more; never fewer than one. */
function nameList(names: string[], chars: number): string {
  let out = '';
  let shown = 0;
  for (const name of names) {
    const next = shown ? `${out}, ${name}` : name;
    if (shown && next.length > chars) break;
    out = next;
    shown++;
  }
  return shown < names.length ? `${out} +${names.length - shown} more` : out;
}

/** What is silent on a host that answers ping (`degraded`), by reason. */
const SILENT: Partial<Record<SiteHost['reason'], string>> = {
  'snmp-silent': 'SNMP silent',
  'agent-silent': 'agent silent',
  interface: 'an interface unavailable',
};

/**
 * FOCUS: a site the question names, host by host. With the snapshot alone,
 * asked "Ada yang down di MOPU?", qwen3:8b answered "Ya" 6 times out of 6,
 * copying the prompt's example and calling down a FortiGate that answered ping
 * with only its SNMP silent. Here every host of the site is listed under its
 * state, then the site's worst open problems, in ~800 characters, lowest
 * priority last.
 *
 * The wording is measured, not decorative: "none, no host at this site is
 * down", and the duration tied to the silence ("SNMP silent for 2d") rather
 * than to the host. With it, none of 25 answers about MOPU, FPSO and MBH, in
 * both languages, called the wrong host down.
 */
export function focusBlock(site: SiteRef, sites: Site[], problems: ZbxProblem[], now: number): string {
  const hosts = sites.flatMap((s) =>
    s.hosts.filter((h) => s.name === site.name || siteFromHostName(h.name)?.code === site.code),
  );
  const since = availabilitySince(problems);
  const inState = (state: HostState) =>
    hosts.filter((h) => h.state === state).sort((a, b) => naturalCompare(a.name, b.name));
  const withSince = (h: SiteHost) => {
    const clock = stateSince(h, since);
    const age = clock === undefined ? '' : `for ${downFor(clock, now)}`;
    if (h.state !== 'degraded') return age ? `${h.name} (${age})` : h.name;
    return `${h.name} (${[SILENT[h.reason] ?? 'monitoring silent', age].filter(Boolean).join(' ')})`;
  };

  const ids = new Set(hosts.map((h) => h.hostid));
  const open = problems.filter((p) => p.hostid && ids.has(p.hostid)).sort(worstFirst);
  // Shorter than the snapshot's problem lines, no opdata, whole days, so
  // every state still fits beside them.
  const problem = (p: ZbxProblem) =>
    `- [${sevName(p.severity)}] ${p.host || 'unknown host'}: ${p.name}; ` +
    `open ${downFor(Number(p.clock), now)}, ${p.acknowledged === '1' ? 'acked' : 'not acked'}`;
  const down = inState('down');
  const degraded = inState('degraded');
  const snmpOnly = degraded.every((h) => h.reason === 'snmp-silent');
  const lines = [
    `Down (${down.length}): ${down.length ? nameList(down.map(withSince), 200) : 'none, no host at this site is down'}`,
    ...(degraded.length
      ? [
          `Not down: answers ping, only its ${snmpOnly ? 'SNMP' : 'SNMP or agent'} monitoring is silent ` +
            `(${degraded.length}): ${nameList(degraded.map(withSince), 200)}`,
        ]
      : []),
    `Open problems here: ${open.length}${open.length ? ', worst first:' : ''}`,
    ...open.slice(0, FOCUS_PROBLEMS).map(problem),
    ...(
      [
        ['nodata', 'No data'],
        ['up', 'Up'],
        ['disabled', 'Disabled'],
      ] as const
    ).flatMap(([state, label]) => {
      const list = inState(state);
      return list.length ? [`${label} (${list.length}): ${nameList(list.map((h) => h.name), 100)}`] : [];
    }),
  ];

  let text = `FOCUS: ${site.name} (${hosts.length} host${hosts.length === 1 ? '' : 's'})`;
  for (const line of lines) {
    if (text.length + 1 + line.length <= FOCUS_BUDGET) text += `\n${line}`;
  }
  return text;
}

/**
 * FOCUS blocks for the sites a question names, from the snapshot's own cached
 * data; `null` when it names none.
 */
export async function buildFocus(question: string): Promise<{ sites: string[]; text: string } | null> {
  const named = sitesNamed(question).slice(0, FOCUS_SITES);
  if (!named.length) return null;
  const [problems, sitesRes] = await Promise.all([
    cached('problems', 5_000, getProblems),
    cached('sites', 15_000, getSites),
  ]);
  const now = Math.floor(Date.now() / 1000);
  return {
    sites: named.map((s) => s.name),
    text: named.map((s) => focusBlock(s, sitesRes.sites, problems, now)).join('\n\n'),
  };
}

// answer clean-up

/**
 * Sign-offs the model adds out of habit ("For more details, check the Problems
 * page." / "Silakan cek halaman Problems."). Matched against the LAST sentence
 * only, so a page named because the snapshot lacked the data survives.
 */
const BOILERPLATE = [
  /^(for (more|further|full|additional) (details|detail|information|info)[^.!?]*[,:]?\s*)?(you (can|may|could) |please |feel free to )?(also )?(check|see|open|visit|refer to|look at|review|go to)\b[^.!?]*\b(page|pages|dashboard|section|portal|tab)\b[^.!?]*[.!]?$/i,
  /^(untuk (detail|informasi|info)[^.!?]*[,:]?\s*)?(anda |kamu )?(juga )?(silakan|silahkan|dapat|bisa|cek|periksa|lihat|buka|kunjungi)\b[^.!?]*\b(halaman|page|dashboard|menu|bagian|portal)\b[^.!?]*[.!]?$/i,
];

export function cleanAnswer(raw: string): string {
  let text = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/\r\n/g, '\n');
  text = text.replace(/\n{3,}/g, '\n\n').trim();

  // Start of the last sentence: after the last ". " / "! " / "? " or line break.
  const body = text.slice(0, -1);
  const boundary = /[\s\S]*(?:[.!?]\s+|\n)/.exec(body);
  if (boundary) {
    const start = boundary[0].length;
    const last = text.slice(start).replace(/^[-*•]\s+/, '').trim();
    if (last.length <= 160 && BOILERPLATE.some((re) => re.test(last))) {
      text = text.slice(0, start).trim();
    }
  }
  return text;
}


/**
 * Turn an OpenAI-style `text/event-stream` body into text pieces. Each frame is
 * `data: {json}`; the stream ends with `data: [DONE]`. Reasoning models may
 * send `delta.reasoning` frames with empty `content`: those are dropped, so
 * only what the reader should see is yielded.
 */
export async function* readOpenAiStream(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trimEnd();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') return;
        let frame: { choices?: { delta?: { content?: string | null } }[] };
        try {
          frame = JSON.parse(data);
        } catch {
          continue; // a partial or malformed frame; the next one carries on
        }
        const piece = frame.choices?.[0]?.delta?.content;
        if (piece) yield piece;
      }
    }
  } finally {
    void reader.cancel().catch(() => undefined);
  }
}

type Message = { role: string; content: string };

async function* streamOpenAiCompatible(messages: Message[], signal: AbortSignal): AsyncGenerator<string> {
  const res = await postModel(
    `${config.ai.baseUrl.replace(/\/$/, '')}/chat/completions`,
    {
      model: config.ai.model,
      max_tokens: ANSWER_MAX_TOKENS,
      stream: true,
      ...thinkingControl(config.ai.model),
      messages,
    },
    signal,
  );
  if (!res.body) throw new AiUpstreamError(`${config.ai.model}: HTTP ${res.status} empty response`);
  yield* readOpenAiStream(res.body);
}

/** Ollama's own /api/chat, with the options every native request shares (ai.ts `ollamaChatBody`). */
async function* streamOllama(
  messages: Message[],
  signal: AbortSignal,
  onStats?: (stats: OllamaStats) => void,
): AsyncGenerator<string> {
  const res = await postModel(
    `${ollamaRoot()}/api/chat`,
    ollamaChatBody(messages, { numPredict: ANSWER_MAX_TOKENS, stream: true }),
    signal,
  );
  if (!res.body) throw new AiUpstreamError(`${config.ai.model}: HTTP ${res.status} empty response`);
  yield* readOllamaStream(res.body, onStats);
}

async function* streamAnthropic(
  system: string,
  turns: ChatTurn[],
  signal: AbortSignal,
): AsyncGenerator<string> {
  try {
    const stream = getAnthropic().messages.stream(
      { model: config.ai.model, max_tokens: ANSWER_MAX_TOKENS, system, messages: turns },
      { signal },
    );
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        yield event.delta.text;
      }
    }
  } catch (err) {
    if (err instanceof Anthropic.APIError) {
      throw new AiUpstreamError(`${config.ai.model}: ${err.message}`);
    }
    throw err;
  }
}

export interface AnswerOptions {
  /** FOCUS blocks for the sites the question names (`buildFocus`). */
  focus?: string | null;
  /** Ollama's token counts once the answer is done, native API only. */
  onStats?: (stats: OllamaStats) => void;
}

/**
 * Answer the latest turn, streaming text as the model produces it. The whole
 * exchange, snapshot, history and answer, is one request; nothing is kept
 * server-side between calls, which is why the client sends its history back.
 *
 * The system text starts with `systemText(snapshot)`, unchanged while the
 * snapshot is, so the model's prompt cache covers it; the focus and language
 * lines that differ per question follow it.
 */
export async function* streamAnswer(
  turns: ChatTurn[],
  snapshot: string,
  signal?: AbortSignal,
  { focus, onStats }: AnswerOptions = {},
): AsyncGenerator<string> {
  if (!config.ai.enabled) throw new AiDisabledError();

  const latest = [...turns].reverse().find((t) => t.role === 'user')?.content ?? '';
  const system = [systemText(snapshot), focus, languageReminder(latest)].filter(Boolean).join('\n\n');
  const local = config.ai.provider === 'openai-compatible';

  // One model request at a time (ai.ts). Waiting for another answer is not
  // this one being slow, so the timeout starts once the model is ours.
  const release = local ? await acquireModelSlot(signal) : null;
  const timeout = AbortSignal.timeout(config.ai.timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

  try {
    if (!local) {
      yield* streamAnthropic(system, turns, combined);
      return;
    }
    const messages = [{ role: 'system', content: system }, ...turns];
    if (await usesOllamaNative()) yield* streamOllama(messages, combined, onStats);
    else yield* streamOpenAiCompatible(messages, combined);
  } catch (err) {
    // The timeout covers the whole answer, not just the first byte. When it
    // fired mid-stream the body reader threw a bare DOMException, and the chat
    // panel showed "The operation was aborted due to timeout". A reader who
    // pressed Stop is not a failure, so that case is passed through untouched.
    if (timeout.aborted && !signal?.aborted) {
      throw new AiUpstreamError(
        `${config.ai.model} did not finish its answer within ${config.ai.timeoutMs} ms — ` +
          'raise AI_TIMEOUT_MS, or ask a narrower question.',
      );
    }
    throw err;
  } finally {
    release?.();
  }
}
