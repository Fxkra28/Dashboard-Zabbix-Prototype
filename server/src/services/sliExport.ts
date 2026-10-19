import { BadRequestError } from '../core/validate.js';
import { buildPdf } from '../export/pdf.js';
import { buildSlaReportDoc } from '../export/slaReport.js';
import { PDF_TYPE, XLSX_TYPE } from '../export/types.js';
import { buildXlsx } from '../export/xlsx.js';
import type { SliReport } from '../sli/engine.js';

/**
 * The monthly SLA as a file, the figures /api/sli shows, on demand.
 *
 *   GET /api/sli/export?month=YYYY-MM&format=pdf|xlsx
 *
 * It reads both methods through getMonthlySli, so a report the page has
 * already loaded is not computed again. Nothing is kept for long: a file is
 * reused for a few seconds and then built again from the cached figures.
 */

export const FORMATS = {
  pdf: { type: PDF_TYPE, build: buildPdf },
  xlsx: { type: XLSX_TYPE, build: buildXlsx },
} as const;

type Format = keyof typeof FORMATS;

/**
 * A build costs about 10 ms of CPU, and a burst of requests would run them back to back with
 * the whole BFF waiting, so repeats inside this window share one file. It is keyed on the two
 * cached reports themselves: a refreshed report starts a new file, and nothing outlives them.
 */
const REUSE_MS = 10_000;
const built = new WeakMap<SliReport, WeakMap<SliReport, Partial<Record<Format, { at: number; body: Buffer }>>>>();

export function fileFor(format: Format, strict: SliReport, hcml: SliReport, now: Date): Buffer {
  let byHcml = built.get(strict);
  if (!byHcml) built.set(strict, (byHcml = new WeakMap()));
  let byFormat = byHcml.get(hcml);
  if (!byFormat) byHcml.set(hcml, (byFormat = {}));
  const kept = byFormat[format];
  if (kept && now.getTime() - kept.at < REUSE_MS) return kept.body;
  const body = FORMATS[format].build(buildSlaReportDoc(strict, hcml, now), now);
  byFormat[format] = { at: now.getTime(), body };
  return body;
}

export function parseFormat(raw: unknown): Format {
  if (raw === 'pdf' || raw === 'xlsx') return raw;
  throw new BadRequestError('format must be "pdf" or "xlsx".');
}
