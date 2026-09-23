/**
 * Check the design tokens in src/styles.css: that the colour pairs the UI
 * actually renders clear WCAG, and that no rule reaches past the tokens to a
 * raw value.
 *
 *   node scripts/tokens.check.mjs [file.css]   (default: src/styles.css)
 *
 * Why this exists. The stylesheet held 42 distinct padding values, 16 font
 * sizes (including 10.5px, 11.5px, 12.5px and 13.5px, which round differently
 * per browser so baselines drifted between panels on one page), 14 border
 * radii and 90-odd hardcoded colours against 13 tokens. Three of those colours
 * failed WCAG and nobody knew, because nothing measured them: --muted sat at
 * 4.43:1 against the page, 0.07 short of AA, for as long as the file existed.
 *
 * A token system only holds if reaching past it fails. Both halves are checked
 * here: the contrast of every pair the interface puts together, and the
 * absence of raw values outside the token blocks.
 *
 * Contrast is computed, not asserted, so editing a token to an illegible
 * colour fails here instead of shipping. The thresholds are WCAG 2.1: 4.5:1
 * for body text, 3:1 for large text and for the boundary of a user interface
 * component (1.4.11).
 *
 * Read-only. No npm dependency: the relative-luminance formula is six lines,
 * the same trade validate-sli.ts made with its zip reader.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** [r, g, b, a] in 0..255 / 0..1, from #rgb, #rrggbb, rgb() or rgba(). */
export function parseColor(value) {
  const v = value.trim();
  if (HEX.test(v)) {
    const h = v.slice(1);
    const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h;
    return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16), 1];
  }
  const fn = /^rgba?\(([^)]+)\)$/i.exec(v);
  if (fn) {
    const parts = fn[1].split(/[,/]/).map((p) => parseFloat(p));
    if (parts.length >= 3 && parts.slice(0, 3).every((n) => Number.isFinite(n))) {
      return [parts[0], parts[1], parts[2], Number.isFinite(parts[3]) ? parts[3] : 1];
    }
  }
  return null;
}

/** A translucent colour over an opaque one, since contrast needs what the eye gets. */
export function composite(fg, bg) {
  if (fg[3] >= 1) return fg;
  return [0, 1, 2].map((i) => fg[i] * fg[3] + bg[i] * (1 - fg[3])).concat(1);
}

export function luminance([r, g, b]) {
  const f = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

export function contrast(fg, bg) {
  const a = luminance(composite(fg, bg));
  const b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/**
 * The custom properties declared in each token block, by the selector that
 * opens it. Only blocks whose selector starts with `:root` count, so a rule
 * that happens to set a local custom property is not mistaken for a token.
 */
export function parseTokens(css) {
  const blocks = new Map();

  // Scanned rather than matched in one pass. The regex this replaced anchored
  // each block to the preceding "}" and then consumed it, so two adjacent token
  // blocks could never both match: it silently returned the light theme alone
  // and reported every dark-mode pair as passing because it had never seen one.
  // Advance by one, not by the length of ":root": a following block can begin
  // within a couple of characters of the previous one's closing brace, and
  // stepping over it is how the first version lost the dark theme.
  for (let at = css.indexOf(':root'); at !== -1; at = css.indexOf(':root', at + 1)) {
    // back to the start of the selector, which is the last brace before it
    let from = at;
    while (from > 0 && css[from - 1] !== '{' && css[from - 1] !== '}' && css[from - 1] !== ';') from--;

    const open = css.indexOf('{', at);
    if (open === -1) break;
    const selector = css.slice(from, open).trim().replace(/\s+/g, ' ');
    if (!selector.includes(':root')) continue;

    const close = css.indexOf('}', open);
    if (close === -1) break;
    // A token block holds declarations only; anything nested is not one.
    const body = css.slice(open + 1, close);
    if (body.includes('{')) continue;

    const found = blocks.get(selector) ?? new Map();
    for (const [, name, value] of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
      found.set(name, value.trim());
    }
    if (found.size) blocks.set(selector, found);
    at = close;
  }
  return blocks;
}

/** Follow `var(--x)` chains inside one theme, falling back to the light theme. */
export function resolve(name, theme, base) {
  const seen = new Set();
  let value = theme.get(name) ?? base.get(name);
  while (typeof value === 'string' && value.startsWith('var(')) {
    const next = /var\(\s*(--[\w-]+)/.exec(value)?.[1];
    if (!next || seen.has(next)) return null;
    seen.add(next);
    value = theme.get(next) ?? base.get(next);
  }
  return value ?? null;
}

/**
 * Every pair the interface actually renders. `min` is 4.5 for text, 3 for a
 * component boundary or large text.
 */
const PAIRS = [
  ['--text', '--bg', 4.5],
  ['--text', '--surface', 4.5],
  ['--text', '--surface-2', 4.5],
  ['--text', '--tint', 4.5],
  ['--muted', '--bg', 4.5],
  ['--muted', '--surface', 4.5],
  ['--muted', '--surface-2', 4.5],
  ['--primary', '--surface', 4.5],
  ['--primary', '--bg', 4.5],
  ['--primary', '--tint', 4.5],
  ['--on-primary', '--primary', 4.5],
  ['--on-chrome', '--chrome', 4.5],
  ['--on-chrome-2', '--chrome', 4.5],
  ['--on-chrome-3', '--chrome', 3],
  ['--good-text', '--good-bg', 4.5],
  ['--warn-text', '--warn-bg', 4.5],
  ['--danger-text', '--danger-bg', 4.5],
  ['--neutral-text', '--neutral-bg', 4.5],
  // Boundaries and marks, not text. DESIGN.md R-3 keeps --mid off text.
  ['--border-strong', '--surface', 3],
  ['--focus', '--surface', 3],
  ['--focus', '--bg', 3],
  ['--mid', '--surface', 3],
  // Plotted lines and their legend dots are graphical objects: 3:1 (1.4.11).
  ['--series-1', '--surface', 3],
  ['--series-2', '--surface', 3],
  ['--series-3', '--surface', 3],
  ['--series-4', '--surface', 3],
];

/**
 * Zabbix's six severity hues are fixed upstream and must stay exact, so what
 * is checked is the ink laid on them. All six fail as coloured text on white;
 * all six pass behind --on-severity. DESIGN.md R-4.
 */
const SEVERITY = [
  ['0 Not classified', '#97AAB3', 4.5],
  ['1 Information', '#7499FF', 4.5],
  ['2 Warning', '#FFC859', 4.5],
  ['3 Average', '#FFA059', 4.5],
  ['4 High', '#E97659', 4.5],
  // The tightest of the six, and the reason --on-severity is #08182a rather
  // than the --chrome value it started as: that measured 4.34:1 here.
  ['5 Disaster', '#E45959', 4.5],
];

export function checkContrast(blocks) {
  const problems = [];
  const base = blocks.get(':root') ?? new Map();
  if (!base.size) return ['no :root token block found'];

  for (const [selector, theme] of blocks) {
    const label = selector === ':root' ? 'light' : selector.includes('dark') ? `dark (${selector})` : selector;
    const pairs = [...PAIRS, ...SEVERITY.map(([n, hex, min]) => ['--on-severity', hex, min, n])];

    for (const [fgName, bgName, min, note] of pairs) {
      const fgRaw = resolve(fgName, theme, base);
      const bgRaw = bgName.startsWith('--') ? resolve(bgName, theme, base) : bgName;
      if (!fgRaw || !bgRaw) {
        problems.push(`${label}: ${fgName} on ${bgName} cannot be resolved`);
        continue;
      }
      const fg = parseColor(fgRaw);
      const bg = parseColor(bgRaw);
      if (!fg || !bg) continue; // gradients and keywords are not pairs
      const ratio = contrast(fg, bg);
      if (ratio + 0.005 < min) {
        const where = note ? `${fgName} on severity ${note}` : `${fgName} on ${bgName}`;
        problems.push(`${label}: ${where} is ${ratio.toFixed(2)}:1, needs ${min}:1`);
      }
    }
  }
  return problems;
}

/**
 * A raw colour anywhere but a token block. `currentColor`, `transparent` and
 * `inherit` are not colours in this sense; nor is a colour inside a comment,
 * which the caller has already stripped.
 */
export function checkRawColors(css) {
  const problems = [];
  const lines = css.split('\n');
  let depth = 0;
  let inTokenBlock = false;
  let tokenDepth = 0;

  lines.forEach((line, i) => {
    const opensToken = /:root/.test(line) && line.includes('{');
    if (opensToken && !inTokenBlock) {
      inTokenBlock = true;
      tokenDepth = depth;
    }
    if (!inTokenBlock) {
      const found = line.match(/#[0-9a-fA-F]{3,8}\b|\brgba?\([^)]*\)/g) ?? [];
      for (const hit of found) {
        if (/^rgba?\(/.test(hit) && !/\d/.test(hit)) continue;
        problems.push(`line ${i + 1}: ${hit.trim()} is a raw colour, use a token`);
      }
    }
    depth += (line.match(/\{/g) ?? []).length;
    depth -= (line.match(/\}/g) ?? []).length;
    if (inTokenBlock && depth <= tokenDepth) inTokenBlock = false;
  });
  return problems;
}

/** Sizes that should come from a scale. Reports values not on one. */
export function checkRawSizes(css, tokens) {
  const scales = {
    'border-radius': new Set(),
    'font-size': new Set(),
  };
  for (const [name, value] of tokens) {
    if (name.startsWith('--r-')) scales['border-radius'].add(value);
    if (name.startsWith('--t-')) scales['font-size'].add(value);
  }
  const problems = [];
  css.split('\n').forEach((line, i) => {
    if (/^\s*--/.test(line)) return;
    for (const [prop, allowed] of Object.entries(scales)) {
      const m = new RegExp(`\\b${prop}:\\s*([^;]+);`).exec(line);
      if (!m) continue;
      const value = m[1].trim();
      if (value.includes('var(') || value === 'inherit' || value === '50%' || value === '100%') continue;
      for (const part of value.split(/\s+/)) {
        if (/^\d+(\.\d+)?px$/.test(part) && !allowed.has(part)) {
          problems.push(`line ${i + 1}: ${prop}: ${part} is not on the scale`);
        }
      }
    }
  });
  return problems;
}

/** Fixtures first. A checker that has never failed has never been tested. */
function selfTest() {
  const fail = [];
  const eq = (label, got, want) => {
    if (JSON.stringify(got) !== JSON.stringify(want)) fail.push(`${label}: got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);
  };
  const near = (label, got, want) => {
    if (Math.abs(got - want) > 0.02) fail.push(`${label}: got ${got.toFixed(2)}, wanted ${want}`);
  };

  near('black on white is 21', contrast(parseColor('#000'), parseColor('#fff')), 21);
  near('white on white is 1', contrast(parseColor('#fff'), parseColor('#ffffff')), 1);
  near('the #64748b regression', contrast(parseColor('#64748b'), parseColor('#f4f7fb')), 4.43);
  near('severity 2 as text fails', contrast(parseColor('#FFC859'), parseColor('#ffffff')), 1.54);
  near('severity 2 behind ink passes', contrast(parseColor('#0a2540'), parseColor('#FFC859')), 10.11);
  near('half-alpha black over white', contrast(parseColor('rgba(0,0,0,0.5)'), parseColor('#fff')), 3.98);
  eq('short hex expands', parseColor('#fff'), [255, 255, 255, 1]);

  const css = `
:root {
  --text: #1b2733;
  --bg: #ffffff;
  --r-sm: 6px;
  --t-md: 14px;
  --alias: var(--text);
}
.a { color: #ff0000; border-radius: 7px; font-size: 14px; }
`;
  const blocks = parseTokens(css);
  eq('one token block', [...blocks.keys()], [':root']);
  eq('alias resolves', resolve('--alias', blocks.get(':root'), blocks.get(':root')), '#1b2733');

  /*
   * The regression this fixture exists for. The first parser anchored each
   * block to the preceding "}" and consumed it, so of these three it found
   * only the first, and then reported every dark-mode pair as passing because
   * it had never looked at one. A themed stylesheet must yield every theme.
   */
  const themed = `
:root { --primary: #0067b1; --bg: #ffffff; }
:root[data-theme='dark'] { --primary: #3e93d6; --bg: #0d1b2a; }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme='light']) { --primary: #3e93d6; --bg: #0d1b2a; }
}
.card { --local: 4px; color: red; }
`;
  const three = parseTokens(themed);
  eq('every theme is found', three.size, 3);
  eq('the dark override is read', three.get(":root[data-theme='dark']").get('--primary'), '#3e93d6');
  eq('a nested media theme is read', three.has(":root:not([data-theme='light'])"), true);
  eq('a local custom property is not a theme', [...three.keys()].some((k) => k.includes('.card')), false);
  eq('raw colour caught', checkRawColors(css).length, 1);
  eq('off-scale radius caught', checkRawSizes(css, blocks.get(':root')).length, 1);

  // and it must fail when a token goes illegible
  const bad = parseTokens(css.replace('--text: #1b2733;', '--text: #eeeeee;'));
  const badProblems = checkContrast(bad).filter((p) => p.includes('--text on --bg'));
  eq('an illegible --text is caught', badProblems.length > 0, true);

  return fail;
}

const failures = selfTest();
if (failures.length) {
  console.error(`tokens.check: the checker itself is broken, ${failures.length} self-test failure(s):`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(2);
}

const files = process.argv.slice(2);
if (!files.length) files.push(fileURLToPath(new URL('../src/styles.css', import.meta.url)));

let total = 0;
for (const file of files) {
  const raw = readFileSync(file, 'utf8');
  const css = raw.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
  const blocks = parseTokens(css);
  const problems = [
    ...checkContrast(blocks),
    ...checkRawColors(css),
    ...checkRawSizes(css, blocks.get(':root') ?? new Map()),
  ];
  for (const p of problems) console.error(`${file}: ${p}`);
  total += problems.length;
}

if (total) {
  console.error(`tokens.check: ${total} problem(s)`);
  process.exit(1);
}
console.log(`tokens.check: ${files.length} file(s) OK`);
