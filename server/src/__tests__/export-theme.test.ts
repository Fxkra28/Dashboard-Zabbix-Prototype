import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PALETTE, TOKEN_OF, TONES, rgb } from '../export/theme.js';

/**
 * The report palette is a copy of the light-theme tokens in web/src/styles.css.
 * A copy can drift, so this reads the stylesheet and compares.
 */
const css = readFileSync(new URL('../../../web/src/styles.css', import.meta.url), 'utf8');
const light = css.slice(css.indexOf(':root {'), css.indexOf(":root[data-theme='dark']"));

const token = (name: string) =>
  new RegExp(`${name.replace(/[-]/g, '\\-')}:\\s*(#[0-9a-fA-F]{6})\\s*;`).exec(light)?.[1]?.toLowerCase();

const luminance = (hex: string) => {
  const [r, g, b] = rgb(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

describe('report palette', () => {
  it.each(Object.entries(TOKEN_OF))('%s equals %s in styles.css', (key, name) => {
    expect(token(name), `${name} not found in the light token block`).toBeDefined();
    expect(PALETTE[key as keyof typeof PALETTE]).toBe(token(name));
  });

  it('draws every tone legibly: text on its own fill clears 4.5:1', () => {
    for (const [tone, c] of Object.entries(TONES)) {
      expect(contrast(c.text, c.bg), tone).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('parses a hex colour into channels', () => {
    expect(rgb('#2b5584')).toEqual([43, 85, 132]);
  });
});
