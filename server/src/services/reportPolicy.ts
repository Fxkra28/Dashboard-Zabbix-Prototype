/**
 * What the slow reports (availability, noise and capacity) share: how long an answer is kept, that an old one may be served while a
 * refresh runs or fails, and how many of them may read Zabbix at once. Automated reporting (HCML Goal 6): "hard to see SLA, capacity
 * trends, and recurring issues".
 */

import { createGate } from '../core/gate.js';

/** Cache lifetimes of the slow reports below. */
export const REPORT_TTL = 120_000;

export const CAPACITY_TTL = 300_000;

/**
 * Past its TTL a slow report is answered at once from the previous run for as
 * long again while one refresh runs, and a failed refresh answers with that
 * run too (cache.ts). Only for reports over days of history, never for
 * `aging` or anything else showing live problem state.
 */
export const staleReport = (ttlMs: number) => ({ staleMs: ttlMs, staleIfError: true });

/**
 * How many reports over days of history are read from Zabbix at once: a cold `noise` report over 365 days takes 7 s and thousands of SQL statements,
 * and every new `days` or `severity` is a cold one, so the others wait their turn. A cached answer never waits.
 */
export const HEAVY_REPORTS_AT_ONCE = 2;

export const heavy = createGate(HEAVY_REPORTS_AT_ONCE);
