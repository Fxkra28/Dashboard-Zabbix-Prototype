import ReactECharts from 'echarts-for-react';
import type { HistoryPoint } from '../types';
import { theme } from '../theme';

export interface Series {
  name: string;
  points: HistoryPoint[];
  color?: string;
}

/** Line chart for one or more Zabbix history series (time on X, value on Y). */
export default function TimeSeriesChart({
  series,
  units,
  height = 320,
}: {
  series: Series[];
  units?: string;
  height?: number;
}) {
  const colors = [theme.primary, theme.primaryLight, '#E97659', '#2E9E5B', '#7C4DFF'];

  const option = {
    grid: { left: 56, right: 20, top: 30, bottom: 40 },
    tooltip: { trigger: 'axis' },
    legend: series.length > 1 ? { top: 0, textStyle: { color: theme.muted } } : undefined,
    xAxis: {
      type: 'time',
      axisLabel: { color: theme.muted },
      axisLine: { lineStyle: { color: theme.border } },
    },
    yAxis: {
      type: 'value',
      name: units,
      nameTextStyle: { color: theme.muted },
      axisLabel: { color: theme.muted },
      splitLine: { lineStyle: { color: theme.border } },
    },
    series: series.map((s, i) => ({
      name: s.name,
      type: 'line',
      smooth: true,
      showSymbol: false,
      lineStyle: { width: 2, color: s.color ?? colors[i % colors.length] },
      areaStyle: series.length === 1 ? { opacity: 0.08, color: s.color ?? colors[0] } : undefined,
      data: s.points.map((p) => [Number(p.clock) * 1000, Number(p.value)]),
    })),
  };

  return <ReactECharts option={option} style={{ height }} notMerge lazyUpdate />;
}
