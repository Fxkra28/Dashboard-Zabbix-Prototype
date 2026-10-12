import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { BadRequestError } from '../validate.js';
import { buildPdf } from '../export/pdf.js';
import { buildSlaReportDoc, reportFileBase } from '../export/slaReport.js';
import { PDF_TYPE, XLSX_TYPE } from '../export/types.js';
import { buildXlsx } from '../export/xlsx.js';
import type { SliReport } from '../sli/engine.js';
import { currentMonth, parseMonth } from '../sli/time.js';
import { getMonthlySli } from './sli.js';

/**
 * The monthly SLA as a file, the figures /api/sli shows, on demand.
 *
 *   GET /api/sli/export?month=YYYY-MM&format=pdf|xlsx
 *
 * It reads both methods through getMonthlySli, so a report the page has
 * already loaded is not computed again. Nothing is kept for long: a file is
 * reused for a few seconds and then built again from the cached figures.
 */

const FORMATS = {
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

function fileFor(format: Format, strict: SliReport, hcml: SliReport, now: Date): Buffer {
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

function parseFormat(raw: unknown): Format {
  if (raw === 'pdf' || raw === 'xlsx') return raw;
  throw new BadRequestError('format must be "pdf" or "xlsx".');
}

export async function sliExportRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/sli/export', async (req, reply) => {
    const q = req.query as { month?: string; format?: string };
    // A misspelt or bracketed month would otherwise be ignored, and the current month served in its place.
    if (Object.keys(q).some((key) => key !== 'month' && key !== 'format')) {
      throw new BadRequestError('Only month and format are accepted.');
    }
    const month = q.month ? parseMonth(q.month) : currentMonth(config.sla.timezone);
    // Before the Zabbix reads, so a bad request costs nothing.
    const format = parseFormat(q.format);

    const [strict, hcml] = await Promise.all([
      getMonthlySli(month, 'availability'),
      getMonthlySli(month, 'hcml-report'),
    ]);
    const body = fileFor(format, strict, hcml, new Date());

    // Named from the validated month alone, so no request text reaches a header.
    const fileName = `${reportFileBase(month)}.${format}`;
    return reply
      .header('Content-Type', FORMATS[format].type)
      .header('Content-Disposition', `attachment; filename="${fileName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`)
      .header('Content-Length', body.length)
      // A closed month never changes but the current one does, and the file is for the person who asked.
      .header('Cache-Control', 'private, no-store')
      .send(body);
  });
}
