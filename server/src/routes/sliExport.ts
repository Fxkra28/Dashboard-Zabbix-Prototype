import type { FastifyInstance } from 'fastify';
import { config } from '../core/config.js';
import { BadRequestError } from '../core/validate.js';
import { reportFileBase } from '../export/slaReport.js';
import { currentMonth, parseMonth } from '../sli/time.js';
import { getMonthlySli } from '../services/sli.js';
import { FORMATS, fileFor, parseFormat } from '../services/sliExport.js';

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
