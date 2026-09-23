import { useCallback, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { GraphRange } from '../types';
import { useSearchPatch } from '../hooks/useUrlState';
import { isMonth, monthBounds, monthLabel, monthOf, recentMonths } from '../lib/time';

export const PRESETS: { label: string; hours: number }[] = [
  { label: '1h', hours: 1 },
  { label: '6h', hours: 6 },
  { label: '24h', hours: 24 },
  { label: '7d', hours: 168 },
  { label: '30d', hours: 720 },
];

const presetLabel = (hours: number) =>
  PRESETS.find((p) => p.hours === hours)?.label ?? (hours % 24 === 0 ? `${hours / 24}d` : `${hours}h`);

function parsePreset(raw: string | null): number | null {
  const m = /^(\d+)([hd])$/.exec(raw ?? '');
  if (!m) return null;
  const hours = Number(m[1]) * (m[2] === 'd' ? 24 : 1);
  return hours >= 1 && hours <= 8760 ? hours : null;
}

/** A stable string for a range. Use it in React keys and hook deps. */
export function rangeKey(r: GraphRange): string {
  return r.kind === 'hours' ? `h${r.hours}` : r.kind === 'month' ? `m${r.month}` : `c${r.from}-${r.to}`;
}

/** Does the window end at "now" (so the graph should refresh)? */
export function isLiveRange(r: GraphRange): boolean {
  const now = Date.now() / 1000;
  if (r.kind === 'hours') return true;
  if (r.kind === 'month') return monthOf(Math.floor(now)) === r.month;
  return r.to >= now - 60;
}

/**
 * The graph range, kept in the URL so a graph can be linked:
 * `range=24h` | `month=2026-08` | `from=<epoch s>&to=<epoch s>`.
 */
export function useUrlRange(defaultHours = 24): [GraphRange, (r: GraphRange) => void] {
  const [params] = useSearchParams();
  const patch = useSearchPatch();
  const range = useMemo<GraphRange>(() => {
    const month = params.get('month');
    if (isMonth(month)) return { kind: 'month', month };
    const from = Number(params.get('from'));
    const to = Number(params.get('to'));
    if (from > 0 && to > from) return { kind: 'custom', from, to };
    return { kind: 'hours', hours: parsePreset(params.get('range')) ?? defaultHours };
  }, [params, defaultHours]);

  const setRange = useCallback(
    (r: GraphRange) =>
      patch({
        range: r.kind === 'hours' ? presetLabel(r.hours) : null,
        month: r.kind === 'month' ? r.month : null,
        from: r.kind === 'custom' ? String(r.from) : null,
        to: r.kind === 'custom' ? String(r.to) : null,
      }),
    [patch],
  );
  return [range, setRange];
}

const toLocalInput = (epoch: number) => {
  const d = new Date(epoch * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const fromLocalInput = (s: string) => Math.floor(new Date(s).getTime() / 1000);

/** Presets ending now, a calendar month (Asia/Jakarta), or a custom from/to. */
export default function RangePicker({ value, onChange }: { value: GraphRange; onChange: (r: GraphRange) => void }) {
  const months = useMemo(() => recentMonths(12), []);
  const [custom, setCustom] = useState(value.kind === 'custom');
  const initial =
    value.kind === 'custom'
      ? value
      : value.kind === 'month'
        ? monthBounds(value.month)
        : { from: Math.floor(Date.now() / 1000) - value.hours * 3600, to: Math.floor(Date.now() / 1000) };
  const [fromText, setFromText] = useState(toLocalInput(initial.from));
  const [toText, setToText] = useState(toLocalInput(initial.to));

  const customValid = (() => {
    const f = fromLocalInput(fromText);
    const t = fromLocalInput(toText);
    return Number.isFinite(f) && Number.isFinite(t) && f < t && t - f <= 400 * 86400;
  })();

  return (
    <div className="range-picker">
      <div className="seg" role="group" aria-label="Time range">
        {PRESETS.map((p) => {
          const on = value.kind === 'hours' && value.hours === p.hours && !custom;
          return (
            <button
              key={p.label}
              type="button"
              className={on ? 'on' : ''}
              aria-pressed={on}
              onClick={() => {
                setCustom(false);
                onChange({ kind: 'hours', hours: p.hours });
              }}
            >
              {p.label}
            </button>
          );
        })}
        <button
          type="button"
          className={custom ? 'on' : ''}
          aria-pressed={custom}
          onClick={() => setCustom((c) => !c)}
        >
          Custom
        </button>
      </div>
      <select
        aria-label="Calendar month"
        className="range-month"
        value={value.kind === 'month' && !custom ? value.month : ''}
        onChange={(e) => {
          if (!e.target.value) return;
          setCustom(false);
          onChange({ kind: 'month', month: e.target.value });
        }}
      >
        <option value="">Month…</option>
        {months.map((m) => (
          <option key={m} value={m}>
            {monthLabel(m)}
          </option>
        ))}
      </select>
      {custom && (
        <div className="range-custom">
          <input
            type="datetime-local"
            aria-label="From"
            value={fromText}
            onChange={(e) => setFromText(e.target.value)}
          />
          <span className="muted">→</span>
          <input type="datetime-local" aria-label="To" value={toText} onChange={(e) => setToText(e.target.value)} />
          <button
            type="button"
            className="btn sm"
            disabled={!customValid}
            onClick={() => onChange({ kind: 'custom', from: fromLocalInput(fromText), to: fromLocalInput(toText) })}
          >
            Apply
          </button>
        </div>
      )}
    </div>
  );
}
