import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import type { GraphSeries } from '../types';

// jsdom has no canvas, and the drawing is not what is under test.
vi.mock('echarts-for-react/esm/core', () => ({ default: () => <div data-testid="canvas" /> }));
const { default: TimeSeriesChart } = await import('../components/TimeSeriesChart');

const series = (id: string, name: string, stats: GraphSeries['stats']): GraphSeries => ({
  itemid: id,
  name,
  host: 'core-sw-1',
  units: 'bps',
  value_type: '0',
  delaySeconds: 60,
  step: false,
  points: [[1_800_000_000_000, 1_000_000, null, null]],
  stats,
  coverage: { coveredSeconds: 3600, firstClock: 1_800_000_000, lastClock: 1_800_003_600 },
});

const stats = { min: 1_000_000, avg: 2_000_000, max: 3_000_000, last: 1_500_000, lastClock: 1_800_003_600 };

describe('TimeSeriesChart accessibility (UX-17)', () => {
  it('gives the chart a name that says what it plots and over which window', () => {
    render(<TimeSeriesChart series={[series('1', 'Bits received', stats)]} from={1_800_000_000} to={1_800_003_600} />);
    const chart = screen.getByRole('img');
    expect(chart).toHaveAccessibleName(/^Line chart of Bits received, .+ to .+/);
    expect(chart).toContainElement(screen.getByTestId('canvas'));
  });

  it('names every series when there are several', () => {
    render(
      <TimeSeriesChart
        series={[series('1', 'Bits received', stats), series('2', 'Bits sent', stats)]}
        from={1_800_000_000}
        to={1_800_003_600}
      />,
    );
    expect(screen.getByRole('img')).toHaveAccessibleName(/Bits received; Bits sent/);
  });

  it('describes the chart with the min, average, max and last figures underneath it', () => {
    render(<TimeSeriesChart series={[series('1', 'Bits received', stats)]} from={1_800_000_000} to={1_800_003_600} />);
    const chart = screen.getByRole('img');
    expect(chart).toHaveAccessibleDescription(/Bits received.*min 1 Mbps.*avg 2 Mbps.*max 3 Mbps.*last 1\.5 Mbps/);
  });

  it('keeps the figures outside the img, so a screen reader can still read them as text', () => {
    render(<TimeSeriesChart series={[series('1', 'Bits received', stats)]} from={1_800_000_000} to={1_800_003_600} />);
    const chart = screen.getByRole('img');
    const summary = document.getElementById(chart.getAttribute('aria-describedby') ?? '');
    expect(summary).not.toBeNull();
    expect(chart).not.toContainElement(summary);
    expect(within(summary as HTMLElement).getByText('avg')).toBeInTheDocument();
  });

  it('says so in the description when a series has no data in the range', () => {
    render(<TimeSeriesChart series={[series('1', 'Bits received', null)]} from={1_800_000_000} to={1_800_003_600} />);
    expect(screen.getByRole('img')).toHaveAccessibleDescription(/no data in this range/);
  });
});
