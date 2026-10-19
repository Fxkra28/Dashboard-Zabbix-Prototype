import type { Tone } from './types.js';

/**
 * The portal's colours, for files that cannot read a stylesheet. Every value
 * is copied from the light-theme token block at the top of web/src/styles/01-tokens.css,
 * and export-theme.test.ts fails if one drifts, so a report and the screen it came
 * from stay the same blue. Reports are printed and attached to email, so they
 * take the light theme whatever the viewer's screen uses.
 */
export const PALETTE = {
  chrome: '#0a2540',
  primary: '#2b5584',
  primaryStrong: '#1e3b5c',
  mid: '#4681c3',
  tint: '#e8eff7',
  tintLine: '#c1d5eb',
  surface: '#ffffff',
  surface2: '#f1f5f9',
  text: '#1b2733',
  muted: '#566577',
  border: '#e2e8f0',
  good: '#2e9e5b',
  goodBg: '#ecfdf3',
  goodLine: '#b7e4c7',
  goodText: '#22794a',
  warn: '#e8a33d',
  warnBg: '#fff7ec',
  warnLine: '#f2ddbb',
  warnText: '#8a5c17',
  danger: '#e45959',
  dangerBg: '#fef2f2',
  dangerLine: '#f5c2c2',
  dangerText: '#c0392f',
  neutralBg: '#eef2f7',
  neutralText: '#475569',
} as const;

/** The CSS custom property each PALETTE entry is copied from. */
export const TOKEN_OF: Record<keyof typeof PALETTE, string> = {
  chrome: '--chrome',
  primary: '--primary',
  primaryStrong: '--primary-strong',
  mid: '--mid',
  tint: '--tint',
  tintLine: '--tint-line',
  surface: '--surface',
  surface2: '--surface-2',
  text: '--text',
  muted: '--muted',
  border: '--border',
  good: '--good',
  goodBg: '--good-bg',
  goodLine: '--good-line',
  goodText: '--good-text',
  warn: '--warn',
  warnBg: '--warn-bg',
  warnLine: '--warn-line',
  warnText: '--warn-text',
  danger: '--danger',
  dangerBg: '--danger-bg',
  dangerLine: '--danger-line',
  dangerText: '--danger-text',
  neutralBg: '--neutral-bg',
  neutralText: '--neutral-text',
};

export interface ToneColours {
  /** Text colour; every one clears 4.5:1 on its own `bg`. */
  text: string;
  /** Fill behind a cell or pill. */
  bg: string;
  /** Edge of a pill, and a bar's fill colour. */
  line: string;
  /** A solid mark: a bar, a dot. */
  solid: string;
}

/** How each tone is drawn, matching the portal's status pills. */
export const TONES: Record<Tone, ToneColours> = {
  good: { text: PALETTE.goodText, bg: PALETTE.goodBg, line: PALETTE.goodLine, solid: PALETTE.good },
  warn: { text: PALETTE.warnText, bg: PALETTE.warnBg, line: PALETTE.warnLine, solid: PALETTE.warn },
  bad: { text: PALETTE.dangerText, bg: PALETTE.dangerBg, line: PALETTE.dangerLine, solid: PALETTE.danger },
  muted: { text: PALETTE.neutralText, bg: PALETTE.neutralBg, line: PALETTE.border, solid: PALETTE.muted },
  none: { text: PALETTE.text, bg: PALETTE.surface, line: PALETTE.border, solid: PALETTE.primary },
};

/** `#rrggbb` to 0 to 255 channels. */
export function rgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
