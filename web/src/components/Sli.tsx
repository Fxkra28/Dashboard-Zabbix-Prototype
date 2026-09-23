import type { DataStatus, SliGap, SliProfile } from '../types';
import { REPORT_TZ, monthLabel, recentMonths } from '../lib/time';
import { formatDuration } from '../lib/units';

/**
 * Small shared pieces for the derived monthly SLA views (SLA, Services,
 * Availability): the month picker, the method toggle, the neutral "no data"
 * pill and the note on hours with no collected data.
 */

export const DERIVED_BANNER =
  'Derived from ICMP availability triggers — Zabbix has no services configured';

export const METHOD_LABEL: Record<SliProfile, string> = {
  availability: 'Strict',
  'hcml-report': 'HCML report method',
};

/** One short sentence on why the two figures differ. */
export const METHOD_NOTE =
  'HCML’s report counts only high ping loss, so a device that is completely down still counts as up; ' +
  'the strict figure counts unreachable devices and leaves out hours with no collected data.';

export const fmtPct = (v: number | null | undefined, digits = 2) =>
  v === null || v === undefined ? '—' : `${v.toFixed(digits)}%`;

export const fmtDur = (seconds: number | null | undefined) =>
  seconds === null || seconds === undefined ? '—' : formatDuration(seconds);

export function NoDataPill({ title }: { title?: string }) {
  return (
    <span className="pill nodata" title={title ?? 'Too little collected data to measure'}>
      No data
    </span>
  );
}

/** A percentage against the target: green met, red missed, grey "No data", never 0%. */
export function SliPill({
  sli,
  target,
  dataStatus,
  digits = 2,
}: {
  sli: number | null;
  target: number;
  dataStatus?: DataStatus;
  digits?: number;
}) {
  if (sli === null || dataStatus === 'nodata') return <NoDataPill />;
  return (
    <span
      className={`pill ${sli >= target ? 'up' : 'down'}`}
      title={dataStatus === 'partial' ? 'Measured on partial data' : undefined}
    >
      {sli.toFixed(digits)}%{dataStatus === 'partial' && <span className="sli-partial">*</span>}
    </span>
  );
}

export function CoverageText({ coverage }: { coverage: number | null | undefined }) {
  if (coverage === null || coverage === undefined) return <span className="muted">—</span>;
  const pct = Math.round(coverage * 100);
  return <span className={pct < 50 ? 'sli-cov low' : 'sli-cov'}>{pct}%</span>;
}

/** The current month (marked "so far") and the 11 before it, Asia/Jakarta. */
export function MonthSelect({
  value,
  onChange,
  label = 'Month',
}: {
  value: string;
  onChange: (m: string) => void;
  label?: string;
}) {
  const months = recentMonths(12);
  return (
    <div className="field">
      <label>{label}</label>
      <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
        {months.map((m, i) => (
          <option key={m} value={m}>
            {monthLabel(m)}
            {i === 0 ? ' (so far)' : ''}
          </option>
        ))}
      </select>
    </div>
  );
}

/** The last closed month: a full month is the natural default for an SLA. */
export const lastClosedMonth = () => recentMonths(2)[1];

export function MethodToggle({
  value,
  onChange,
  label = 'Method',
}: {
  value: SliProfile;
  onChange: (p: SliProfile) => void;
  label?: string;
}) {
  return (
    <div className="field">
      <label>{label}</label>
      <div className="seg" role="group" aria-label="Calculation method">
        {(['availability', 'hcml-report'] as SliProfile[]).map((p) => (
          <button
            key={p}
            type="button"
            className={value === p ? 'on' : ''}
            aria-pressed={value === p}
            onClick={() => onChange(p)}
          >
            {METHOD_LABEL[p]}
          </button>
        ))}
      </div>
    </div>
  );
}

const dayFmt = new Intl.DateTimeFormat('en-GB', { timeZone: REPORT_TZ, day: 'numeric', month: 'short' });
const hourFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: REPORT_TZ,
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function spanText(g: SliGap): string {
  const a = new Date(g.from * 1000);
  const b = new Date((g.to - 1) * 1000);
  const da = dayFmt.format(a);
  const db = dayFmt.format(b);
  if (g.to - g.from < 86400) {
    return da === db
      ? `${da} ${hourFmt.format(a)}–${hourFmt.format(new Date(g.to * 1000))}`
      : `${da} ${hourFmt.format(a)} – ${db} ${hourFmt.format(new Date(g.to * 1000))}`;
  }
  if (da === db) return da;
  const [dA, mA] = da.split(' ');
  const [dB, mB] = db.split(' ');
  return mA === mB ? `${dA}–${dB} ${mA}` : `${da} – ${db}`;
}

/** "Excluded 6.9 days with no collected data: 1–2 Aug, 8–11 Aug …" */
export function gapsSummary(gaps: SliGap[]): string | null {
  if (!gaps.length) return null;
  const seconds = gaps.reduce((s, g) => s + (g.to - g.from), 0);
  const amount =
    seconds >= 172800 ? `${(seconds / 86400).toFixed(1)} days` : `${Math.round(seconds / 3600)} hours`;
  return `${amount} with no collected data: ${gaps.map(spanText).join(', ')}`;
}

export function GapsNote({ gaps, profile }: { gaps: SliGap[] | undefined; profile: SliProfile }) {
  const text = gapsSummary(gaps ?? []);
  if (!text) return null;
  return (
    <div className="notice sli-gaps">
      {profile === 'availability' ? 'Excluded ' : 'Counted as up by the HCML method: '}
      {text}.
    </div>
  );
}
