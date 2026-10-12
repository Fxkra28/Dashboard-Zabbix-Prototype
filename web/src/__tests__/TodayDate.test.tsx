import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import TodayDate from '../components/TodayDate';

afterEach(() => vi.useRealTimers());

describe('TodayDate', () => {
  it('turns over at midnight on a tab that stays open (FR-08)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 7, 23, 59, 30));
    render(<TodayDate />);
    expect(screen.getByText(new Date(2026, 9, 7).toLocaleDateString())).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.getByText(new Date(2026, 9, 8).toLocaleDateString())).toBeInTheDocument();
    expect(screen.queryByText(new Date(2026, 9, 7).toLocaleDateString())).toBeNull();
  });
});
