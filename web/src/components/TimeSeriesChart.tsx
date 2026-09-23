import { useEffect, useState } from 'react';
import * as echarts from 'echarts/core';
import { LineChart } from 'echarts/charts';
import {
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  TooltipComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import ReactEChartsCore from 'echarts-for-react/lib/core';
import type { GraphRange, GraphResponse, GraphSeries } from '../types';
import { theme } from '../theme';
import { formatAxis, formatValue } from '../lib/units';
import { api } from '../api';
import { useAsync } from '../hooks/useAsync';
import StaleNote from './StaleNote';
import { Async, Loading } from './states';
import { isLiveRange, rangeKey } from './RangePicker';

/**
 * Register only what this chart draws.
 *
 * The convenience import (`echarts-for-react` → the `echarts` barrel) pulls in
 * every chart type, coordinate system and renderer ECharts ships, roughly a
 * megabyte. This registers the pieces actually used and leaves the rest out.
 */
echarts.use([
  LineChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomComponent,
  CanvasRenderer,
]);

const SERIES_TOKENS = ['--series-1', '--series-2', '--series-3', '--series-4'];

/**
 * The four series colours, read out of the stylesheet rather than written here,
 * because ECharts paints to a canvas and a canvas cannot resolve `var()`.
 * Reading them at render means the dark theme gets its own set.
 *
 * A chart is the one place the palette allows a second hue: four shades of the
 * brand blue on one line chart cannot be told apart, which is the whole point
 * of plotting them separately. None of the four sits in severity's warm range,
 * so a plotted line is never mistaken for an alarm.
 */
export function seriesColors(): string[] {
  if (typeof window === 'undefined') return [theme.primary];
  const style = getComputedStyle(document.documentElement);
  return SERIES_TOKENS.map((t) => style.getPropertyValue(t).trim() || theme.primary);
}

/**
 * Axis, gridline and tooltip colours, resolved the same way and for the same
 * reason. Without this the chart keeps its light axes on a dark page, which is
 * the usual way a canvas gets left out of a theme.
 */
function chartInk(): { muted: string; border: string; surface: string; text: string } {
  if (typeof window === 'undefined') {
    return { muted: theme.muted, border: theme.border, surface: theme.surface, text: theme.text };
  }
  const style = getComputedStyle(document.documentElement);
  const read = (token: string, fallback: string) => style.getPropertyValue(token).trim() || fallback;
  return {
    muted: read('--muted', theme.muted),
    border: read('--border', theme.border),
    surface: read('--surface', theme.surface),
    text: read('--text', theme.text),
  };
}

type Meta = { kind: 'line' | 'low' | 'high'; s: GraphSeries; color: string };

/**
 * Line chart for 1–4 /api/graph series.
 *
 * - The x-axis is pinned to the requested window, so a sparse item doesn't
 *   stretch its few points across the whole width.
 * - Straight segments (no smoothing), step lines for 0/1 states, and a break
 *   wherever the BFF marked a collection gap (null), never a line across it.
 * - A single series from trends gets a shaded min–max band.
 * - No `notMerge`: a refresh merges new data and keeps the user's zoom. The
 *   parent remounts the chart (React `key`) when the selection or range changes.
 */
export default function TimeSeriesChart({
  series,
  from,
  to,
  height = 320,
}: {
  series: GraphSeries[];
  from: number;
  to: number;
  height?: number;
}) {
  // Up to two unit families get their own axis (e.g. bps left, % right).
  const unitAxes: string[] = [];
  for (const s of series) if (!unitAxes.includes(s.units) && unitAxes.length < 2) unitAxes.push(s.units);
  const axisOf = (s: GraphSeries) => Math.max(0, unitAxes.indexOf(s.units));

  const band =
    series.length === 1 &&
    !series[0].step &&
    series[0].points.some((p) => p[2] !== null && p[3] !== null);

  const palette = seriesColors();
  const ink = chartInk();
  const metas: Meta[] = [];
  const chartSeries: Record<string, unknown>[] = [];

  series.forEach((s, i) => {
    const color = palette[i % palette.length];
    metas.push({ kind: 'line', s, color });
    chartSeries.push({
      name: seriesLabel(s, series),
      type: 'line',
      yAxisIndex: axisOf(s),
      smooth: false,
      step: s.step ? 'end' : false,
      connectNulls: false,
      showSymbol: s.points.length < 40,
      symbolSize: 4,
      sampling: undefined,
      lineStyle: { width: 1.6, color },
      itemStyle: { color },
      areaStyle: series.length === 1 && !band ? { opacity: 0.07, color } : undefined,
      data: s.points.map((p) => [p[0], p[1]]),
      z: 3,
    });
    if (band && i === 0) {
      metas.push({ kind: 'low', s, color });
      chartSeries.push({
        name: '__low',
        type: 'line',
        stack: 'band',
        symbol: 'none',
        connectNulls: false,
        lineStyle: { opacity: 0 },
        data: s.points.map((p) => [p[0], p[2]]),
        silent: true,
        z: 1,
      });
      metas.push({ kind: 'high', s, color });
      chartSeries.push({
        name: '__high',
        type: 'line',
        stack: 'band',
        symbol: 'none',
        connectNulls: false,
        lineStyle: { opacity: 0 },
        areaStyle: { color, opacity: 0.14 },
        data: s.points.map((p) => [p[0], p[2] !== null && p[3] !== null ? p[3] - p[2] : null]),
        silent: true,
        z: 1,
      });
    }
  });

  const option = {
    animation: false,
    grid: { left: 64, right: unitAxes.length > 1 ? 64 : 20, top: series.length > 1 ? 34 : 16, bottom: 64 },
    legend:
      series.length > 1
        ? {
            top: 0,
            data: metas.filter((m) => m.kind === 'line').map((m) => seriesLabel(m.s, series)),
            textStyle: { color: ink.muted },
          }
        : undefined,
    tooltip: {
      trigger: 'axis',
      confine: true,
      formatter: (params: { seriesIndex: number; dataIndex: number; value: [number, number | null] }[]) => {
        if (!params.length) return '';
        const t = params[0].value[0];
        const rows = params
          .filter((p) => metas[p.seriesIndex]?.kind === 'line')
          .map((p) => {
            const m = metas[p.seriesIndex];
            const point = m.s.points[p.dataIndex];
            const value = point?.[1];
            const range =
              point && point[2] !== null && point[3] !== null && !m.s.step
                ? ` <span style="color:${ink.muted}">(${esc(formatValue(point[2], m.s.units))} – ${esc(
                    formatValue(point[3], m.s.units),
                  )})</span>`
                : '';
            return `<div><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${
              m.color
            };margin-right:6px"></span>${esc(seriesLabel(m.s, series))}: <b>${
              value === null || value === undefined ? 'no data' : esc(formatValue(value, m.s.units))
            }</b>${range}</div>`;
          });
        return `<div style="font-size:12px"><div style="margin-bottom:4px;color:${ink.muted}">${esc(
          new Date(t).toLocaleString(),
        )}</div>${rows.join('')}</div>`;
      },
    },
    dataZoom: [
      { type: 'inside', xAxisIndex: 0, filterMode: 'none' },
      {
        type: 'slider',
        xAxisIndex: 0,
        filterMode: 'none',
        height: 18,
        bottom: 12,
        backgroundColor: ink.surface,
        borderColor: ink.border,
        textStyle: { color: ink.text },
      },
    ],
    xAxis: {
      type: 'time',
      min: from * 1000,
      max: to * 1000,
      axisLabel: { color: ink.muted, hideOverlap: true },
      axisLine: { lineStyle: { color: ink.border } },
    },
    yAxis: (unitAxes.length ? unitAxes : ['']).map((units, i) => ({
      type: 'value',
      position: i === 0 ? 'left' : 'right',
      scale: false,
      axisLabel: { color: ink.muted, formatter: (v: number) => formatAxis(v, units) },
      splitLine: i === 0 ? { lineStyle: { color: ink.border } } : { show: false },
      ...(series.every((s) => s.step) ? { max: (v: { max: number }) => Math.max(1, v.max) } : {}),
    })),
    series: chartSeries,
  };

  return (
    <div className="tsc">
      <ReactEChartsCore echarts={echarts} option={option} style={{ height }} lazyUpdate />
      <div className="chart-summary">
        {series.map((s, i) => (
          <div key={s.itemid} className="chart-summary-row">
            <span className="dot" style={{ background: palette[i % palette.length] }} />
            <span className="chart-summary-name" title={`${s.host} — ${s.name}`}>
              {seriesLabel(s, series)}
            </span>
            {s.stats ? (
              <span className="chart-summary-stats">
                <span>
                  <em>min</em> {formatValue(s.stats.min, s.units)}
                </span>
                <span>
                  <em>avg</em> {formatValue(s.stats.avg, s.units)}
                </span>
                <span>
                  <em>max</em> {formatValue(s.stats.max, s.units)}
                </span>
                <span>
                  <em>last</em> {formatValue(s.stats.last, s.units)}
                </span>
              </span>
            ) : (
              <span className="muted">no data in this range</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Name without the shared "Interface X(alias): " prefix when every series has it. */
function seriesLabel(s: GraphSeries, all: GraphSeries[]): string {
  const prefix = /^(Interface [^:]+:\s*)/.exec(s.name)?.[1];
  if (prefix && all.length > 1 && all.every((o) => o.name.startsWith(prefix))) {
    return s.name.slice(prefix.length);
  }
  const hosts = new Set(all.map((o) => o.host));
  return hosts.size > 1 ? `${s.host}: ${s.name}` : s.name;
}

function esc(text: string): string {
  return text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

const SOURCE_LABEL: Record<GraphResponse['source'], string> = {
  history: 'raw history',
  trend: 'hourly trends',
  'trend+history': 'hourly trends + recent history',
};

/**
 * Fetch + stale note + chart for a set of items over a range. Refreshes only
 * for windows ending now, at the items' own update interval (30 s – 5 min).
 * The chart is keyed on selection + range, so a refresh keeps the zoom.
 */
export function GraphView({
  itemids,
  range,
  height,
  empty = 'No data in this range.',
}: {
  itemids: string[];
  range: GraphRange;
  height?: number;
  empty?: string;
}) {
  const idsKey = itemids.join(',');
  const rk = rangeKey(range);
  const live = isLiveRange(range);
  // Poll at the items' own interval once it is known. useAsync only moves its
  // timer when the interval changes, so learning it doesn't refetch.
  const [pollMs, setPollMs] = useState(30_000);
  const q = useAsync<(GraphResponse & { requestKey: string }) | null>(
    () =>
      itemids.length
        ? api.graph(itemids, range).then((g) => ({ ...g, requestKey: `${idsKey}|${rk}` }))
        : Promise.resolve(null),
    [idsKey, rk],
    live && itemids.length ? pollMs : undefined,
  );
  const delay = Math.max(0, ...(q.data?.series.map((s) => s.delaySeconds) ?? [0]));
  const intervalMs = Math.min(Math.max(delay * 1000, 30_000), 300_000);
  useEffect(() => setPollMs(intervalMs), [intervalMs]);

  if (!itemids.length) return <div className="state">Pick an item to graph.</div>;
  // Data for a previous selection is still in hand while the new one loads.
  const current = q.data?.requestKey === `${idsKey}|${rk}` ? q.data : null;
  if (!current && !q.error) return <Loading label="Loading graph…" />;

  return (
    <Async
      loading={q.loading}
      error={q.error}
      data={current}
      updatedAt={q.updatedAt}
      loadingLabel="Loading graph…"
    >
      {(g) => (
        <>
          <div className="graph-meta">
            <span className="pill">{SOURCE_LABEL[g.source]}</span>
            {g.downsampled && <span className="muted">downsampled</span>}
            {live && <span className="muted">refreshes every {Math.round(intervalMs / 1000)} s</span>}
          </div>
          <StaleNote from={g.from} to={g.to} series={g.series} latestClock={g.latestClock} />
          {g.series.some((s) => s.points.length) ? (
            <TimeSeriesChart key={`${idsKey}|${rk}`} series={g.series} from={g.from} to={g.to} height={height} />
          ) : (
            <div className="state">{empty}</div>
          )}
        </>
      )}
    </Async>
  );
}
