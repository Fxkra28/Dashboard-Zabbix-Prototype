import { describe, expect, it } from 'vitest';
import { FIT_MIN, fitScale } from '../lib/fit';

/** Drawing a grid smaller until it fits a screen that cannot be scrolled. */

/** A grid of `count` tiles `tile` wide and tall in a `width` wide space, laid out as a browser would: as many to a row as fit. */
const grid = (count: number, tile: number, width: number) => (scale: number) => Math.ceil(count / Math.max(1, Math.floor(width / scale / tile))) * tile;

describe('fitScale', () => {
  it('leaves a grid that fits as it is', () => {
    expect(fitScale(grid(20, 100, 1000), 500)).toBe(1);
    expect(fitScale(grid(20, 100, 1000), 200)).toBe(1);
  });

  it('draws a grid that is too tall smaller, by as little as will do', () => {
    // 60 tiles of 100: 6 rows at full size, 600 tall, in 500. A little smaller still gives 6 rows, and only at 0.82 do 12 fit to a row.
    const s = fitScale(grid(60, 100, 1000), 500);
    expect(s).toBe(0.82);
    expect(grid(60, 100, 1000)(s) * s).toBeLessThanOrEqual(500);
    expect(grid(60, 100, 1000)(0.84) * 0.84).toBeGreaterThan(500);
  });

  it('counts the width a smaller grid has: it holds more tiles to a row', () => {
    // At full size 8 to a row and 5 rows. At 0.9 there are 9 to a row and 4 rows, which is what fits.
    const s = fitScale(grid(33, 100, 800), 400);
    expect(s).toBeLessThan(1);
    expect(grid(33, 100, 800)(s)).toBeLessThan(grid(33, 100, 800)(1));
  });

  it('never goes below the smallest scale, whatever the grid', () => {
    expect(fitScale(grid(1000, 100, 1000), 500)).toBe(FIT_MIN);
    expect(fitScale(() => 1e9, 10)).toBe(FIT_MIN);
  });

  it('leaves the grid alone when there is no room to measure against', () => {
    expect(fitScale(() => 1000, 0)).toBe(1);
    expect(fitScale(() => 1000, -40)).toBe(1);
    expect(fitScale(() => 1000, Number.NaN)).toBe(1);
  });

  it('takes the first scale that fits and measures no more than that', () => {
    const asked: number[] = [];
    fitScale((s) => {
      asked.push(s);
      return s <= 0.9 ? 100 : 1000;
    }, 500);
    expect(asked).toEqual([1, 0.98, 0.96, 0.94, 0.92, 0.9]);
  });

  it('steps in whole hundredths, so the scale is a number a person can read', () => {
    for (const rows of [3, 5, 8, 13]) {
      const s = fitScale(grid(rows * 10, 100, 1000), 300);
      expect(Math.round(s * 100) / 100).toBe(s);
      expect(s).toBeGreaterThanOrEqual(FIT_MIN);
      expect(s).toBeLessThanOrEqual(1);
    }
  });
});
