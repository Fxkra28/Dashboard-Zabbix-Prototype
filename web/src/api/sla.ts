/** The calls behind availability and SLA: the availability report, the derived monthly SLA and its files, the service trees and Zabbix's own SLAs. */

import type { ServicesResponse, DerivedServicesResponse, SliReport, SliProfile, SlaSource, AvailabilityBasis, Sla, SlaSli, AvailabilityReport } from '../types';
import { availabilityGuard, derivedServicesGuard, servicesGuard, slaListGuard, slaSliGuard, slaSourceGuard, sliGuard } from '../guards';
import { currentSignal, fetchOk, qs, request, SLI_TIMEOUT_MS } from './client';

/** The two file types the monthly SLA report comes in. */
export type ReportFormat = 'pdf' | 'xlsx';

/**
 * The file name a Content-Disposition header proposes, or `fallback` when it
 * names none. `filename*` (UTF-8) wins over `filename`. Only the last path
 * segment is kept, so a header can never aim a download at another folder.
 */
export function fileNameFrom(disposition: string | null, fallback: string): string {
  const params = new Map<string, string>();
  // A quoted value is taken whole, so a ";" inside one never starts a parameter.
  const param = /;\s*([\w*-]+)\s*=\s*("(?:[^"\\]|\\.)*"|[^;]*)/g;
  for (const [, key, raw] of (disposition ?? '').matchAll(param)) {
    const quoted = /^"(.*)"$/s.exec(raw);
    params.set(key.toLowerCase(), quoted ? quoted[1].replace(/\\(.)/g, '$1') : raw.trim());
  }
  let name = params.get('filename') ?? '';
  const encoded = /^utf-8'[^']*'(.*)$/i.exec(params.get('filename*') ?? '');
  if (encoded) {
    try {
      name = decodeURIComponent(encoded[1]);
    } catch {
      // A broken escape: the plain name, if there is one, still stands.
    }
  }
  const clean = (name.replace(/\p{Cc}/gu, '').split(/[\\/]/).pop() ?? '').trim();
  return clean && clean !== '.' && clean !== '..' ? clean : fallback;
}

/**
 * The name to save a report under: the one the BFF sent when it ends in the format's own
 * extension and holds no invisible formatting characters, otherwise one made here. The BFF names
 * the file from the month alone, so this only matters if something between it and the browser
 * answers in its place, and then a name such as `report.pdf.exe` must not survive.
 */
export function reportFileName(disposition: string | null, month: string, format: ReportFormat): string {
  const fallback = `HCML_SLA_Report_${month}.${format}`;
  const proposed = fileNameFrom(disposition, fallback);
  return proposed.toLowerCase().endsWith(`.${format}`) && !/\p{Cf}/u.test(proposed) ? proposed : fallback;
}

/** What each format's file is, as the Content-Type header says it. */
const REPORT_TYPES: Record<ReportFormat, { type: string; what: string }> = {
  pdf: { type: 'application/pdf', what: 'a PDF file' },
  xlsx: { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', what: 'an Excel file' },
};

export interface AvailabilityQuery {
  basis?: AvailabilityBasis;
  profile?: SliProfile;
  /** YYYY-MM calendar month (Asia/Jakarta); takes precedence over `days`. */
  month?: string;
  days?: number;
  /** Legacy all-problems basis only. */
  severity?: number;
}

export const slaApi = {
  // Automated reporting
  /** `(days, severity)` is the legacy all-problems form; pass an object for the engine-backed basis. */
  availability: (arg: number | AvailabilityQuery, severity?: number) =>
    request<AvailabilityReport>(
      `/api/reports/availability${qs(
        typeof arg === 'number'
          ? { days: arg, severity }
          : {
              basis: arg.basis,
              profile: arg.basis === 'all-problems' ? undefined : arg.profile,
              month: arg.month,
              days: arg.month ? undefined : arg.days,
              severity: arg.basis === 'all-problems' ? arg.severity : undefined,
            },
      )}`,
      { guard: availabilityGuard },
    ),
  // Services tree with roll-up status: the service-centric view.
  services: () => request<ServicesResponse>('/api/services', { guard: servicesGuard }),
  /** The tree derived from the estate, for a Zabbix with no services configured. */
  servicesDerived: (month?: string, profile?: SliProfile) =>
    request<DerivedServicesResponse>(`/api/services/derived${qs({ month, profile })}`, { guard: derivedServicesGuard }),
  // Derived monthly SLA (portal-computed from ICMP triggers, read-only)
  sli: (month?: string, profile?: SliProfile) =>
    request<SliReport>(`/api/sli${qs({ month, profile })}`, { timeoutMs: SLI_TIMEOUT_MS, guard: sliGuard }),
  /** The month's report as a PDF or Excel file, named by the BFF; `signal` cancels it. */
  sliExport: async (month: string, format: ReportFormat, signal?: AbortSignal) => {
    const res = await fetchOk(`/api/sli/export${qs({ month, format })}`, signal ?? currentSignal);
    const { type, what } = REPORT_TYPES[format];
    // A 200 is not proof of a report: a proxy that answers a lapsed session with a login page gets here too.
    if (!(res.headers.get('Content-Type') ?? '').toLowerCase().startsWith(type)) {
      throw new Error(`The server answered with something that is not ${what}.`);
    }
    const blob = await res.blob();
    if (blob.size === 0) throw new Error('The server sent an empty file.');
    return { blob, fileName: reportFileName(res.headers.get('Content-Disposition'), month, format) };
  },
  // Services → SLA
  slaSource: () => request<SlaSource>('/api/sla/source', { guard: slaSourceGuard }),
  sla: () => request<Sla[]>('/api/sla', { guard: slaListGuard }),
  slaSli: (slaid: string, serviceid?: string) =>
    request<SlaSli[]>(`/api/sla/sli${qs({ slaid, serviceid })}`, { guard: slaSliGuard }),
};
