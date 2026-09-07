import { SEVERITIES } from '../theme';

export function severity(level: string | number) {
  const n = Number(level);
  return SEVERITIES[n] ?? SEVERITIES[0];
}

export function fmtTime(clock: string | number | undefined): string {
  const n = Number(clock);
  if (!n) return '—';
  return new Date(n * 1000).toLocaleString();
}

export function ago(clock: string | number): string {
  const s = Math.floor(Date.now() / 1000 - Number(clock));
  return humanizeSeconds(s) + ' ago';
}

/** Problem duration: from onset to recovery (or now if still open). Zabbix "Duration". */
export function duration(clock: string | number, rClock?: string | number): string {
  const start = Number(clock);
  const end = rClock && Number(rClock) > 0 ? Number(rClock) : Math.floor(Date.now() / 1000);
  return humanizeSeconds(end - start);
}

function humanizeSeconds(s: number): string {
  if (s < 0) s = 0;
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}

/** Human-friendly number with an optional unit (bytes/bps → auto-scale). */
export function fmtValue(v: number | string | undefined | null, units?: string): string {
  if (v === undefined || v === '' || v === null) return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  const scaled = ['bps', 'Bps', 'B', 'B/s'].includes(units ?? '');
  if (scaled) return scale(n) + (units ? ` ${units}` : '');
  const rounded = Math.abs(n) >= 100 ? Math.round(n) : Math.round(n * 100) / 100;
  return `${rounded}${units ? ` ${units}` : ''}`;
}

function scale(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return (n / 1e9).toFixed(2) + 'G';
  if (abs >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (abs >= 1e3) return (n / 1e3).toFixed(2) + 'K';
  return String(Math.round(n));
}

/** Interface availability (Zabbix): 0 unknown, 1 available, 2 unavailable. */
export function availability(code: string | undefined) {
  switch (code) {
    case '1':
      return { label: 'Available', kind: 'up' as const };
    case '2':
      return { label: 'Unavailable', kind: 'down' as const };
    default:
      return { label: 'Unknown', kind: 'unknown' as const };
  }
}

/** Roll up per-interface availability to a host-level state (worst wins). */
export function hostAvailability(interfaces?: { available?: string }[]) {
  if (!interfaces?.length) return availability(undefined);
  if (interfaces.some((i) => i.available === '2')) return availability('2');
  if (interfaces.some((i) => i.available === '1')) return availability('1');
  return availability(undefined);
}

const IFACE_TYPES: Record<string, string> = { '1': 'Agent', '2': 'SNMP', '3': 'IPMI', '4': 'JMX' };
export const ifaceType = (t?: string) => IFACE_TYPES[t ?? ''] ?? 'Iface';
