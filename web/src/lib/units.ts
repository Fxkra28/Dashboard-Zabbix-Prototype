/**
 * Zabbix units → human text. Mirrors what the Zabbix frontend does for the
 * units HCML's SNMP templates use:
 *
 *   bps, b/s          ×1000   Kbps Mbps Gbps
 *   B, Bps, B/s       ×1024   KB MB GB (KB/s …)
 *   %                 2 dp
 *   s                 ms below 1 s, then s / min / h
 *   uptime            3d 4h
 *   unixtime          local date-time
 */

const DECIMAL = ['', 'K', 'M', 'G', 'T', 'P'];

function trim(n: number, dp: number): string {
  const fixed = n.toFixed(dp);
  return fixed.includes('.') ? fixed.replace(/\.?0+$/, '') : fixed;
}

/** A plain number with a sensible number of decimals. */
function plain(n: number): string {
  const abs = Math.abs(n);
  if (abs === 0) return '0';
  if (abs >= 1000) return Math.round(n).toLocaleString('en-US');
  if (abs >= 100) return trim(n, 1);
  if (abs >= 1) return trim(n, 2);
  if (abs >= 0.01) return trim(n, 3);
  return n.toPrecision(2);
}

function scaled(n: number, base: 1000 | 1024, unit: string): string {
  let i = 0;
  let v = n;
  while (Math.abs(v) >= base && i < DECIMAL.length - 1) {
    v /= base;
    i++;
  }
  const dp = Math.abs(v) >= 100 || i === 0 ? (Number.isInteger(v) ? 0 : 1) : 2;
  return `${trim(v, dp)} ${DECIMAL[i]}${unit}`;
}

export function formatDuration(totalSeconds: number): string {
  const s = Math.round(Math.abs(totalSeconds));
  const sign = totalSeconds < 0 ? '-' : '';
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${sign}${d}d${h ? ` ${h}h` : ''}`;
  if (h) return `${sign}${h}h${m ? ` ${m}m` : ''}`;
  if (m) return `${sign}${m}m${s % 60 ? ` ${s % 60}s` : ''}`;
  return `${sign}${s}s`;
}

/**
 * Seconds → the coarsest unit that still reads naturally: 45s, 12m, 3.5h, 2.1d.
 * A negative value keeps its sign (an overspent error budget).
 */
export function dur(totalSeconds: number): string {
  const s = Math.abs(Math.round(totalSeconds));
  const sign = Math.round(totalSeconds) < 0 ? '−' : '';
  if (s < 60) return `${sign}${s}s`;
  if (s < 3600) return `${sign}${Math.round(s / 60)}m`;
  if (s < 86400) return `${sign}${(s / 3600).toFixed(1)}h`;
  return `${sign}${(s / 86400).toFixed(1)}d`;
}

function seconds(n: number): string {
  const abs = Math.abs(n);
  if (abs === 0) return '0 s';
  if (abs < 1) return `${trim(n * 1000, abs * 1000 >= 100 ? 0 : abs * 1000 >= 10 ? 1 : 2)} ms`;
  if (abs < 60) return `${trim(n, 2)} s`;
  if (abs < 3600) return `${trim(n / 60, 1)} min`;
  return `${trim(n / 3600, 1)} h`;
}

export function formatValue(v: number | null | undefined, units?: string): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const u = (units ?? '').trim();
  switch (u) {
    case 'bps':
    case 'b/s':
      return scaled(v, 1000, 'bps');
    case 'B':
      return scaled(v, 1024, 'B');
    case 'Bps':
    case 'B/s':
      return scaled(v, 1024, 'B/s');
    case '%':
      return `${v.toFixed(2)} %`;
    case 's':
      return seconds(v);
    case 'ms':
      return v >= 1000 ? seconds(v / 1000) : `${trim(v, v >= 100 ? 0 : 2)} ms`;
    case 'uptime':
      return formatDuration(v);
    case 'unixtime':
      return v > 0 ? new Date(v * 1000).toLocaleString() : '—';
    case '':
      return plain(v);
    default:
      return `${plain(v)} ${u}`;
  }
}

/** Short axis label: same families, fewer decimals. */
export function formatAxis(v: number, units?: string): string {
  const u = (units ?? '').trim();
  if (u === '%') return `${trim(v, 1)}%`;
  if (u === 'unixtime') return formatValue(v, '');
  return formatValue(v, u);
}
