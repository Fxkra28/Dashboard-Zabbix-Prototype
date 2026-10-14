/**
 * A wall cannot be scrolled and a tile's height depends on what it says, so the grid is drawn smaller, all tiles by one factor, until it fits.
 * Never below FIT_MIN, the smallest the wall's text reads from across a room; past that the meters go on more slides (lib/wall.ts).
 */

/** The smallest scale: the wall's text at this factor is about a normal page's. */
export const FIT_MIN = 0.8;
const FIT_STEP = 0.02;

const round = (n: number) => Math.round(n * 100) / 100;

/**
 * The largest scale from 1 to FIT_MIN at which the grid fits `room` pixels; `heightAt(s)` is its height laid out 1/s times as wide,
 * as it is when drawn at scale s. FIT_MIN when nothing fits: a little too tall beats too small to read.
 */
export function fitScale(heightAt: (scale: number) => number, room: number): number {
  if (!(room > 0)) return 1;
  for (let s = 1; s >= FIT_MIN - 1e-9; s = round(s - FIT_STEP)) {
    if (heightAt(s) * s <= room) return s;
  }
  return FIT_MIN;
}
