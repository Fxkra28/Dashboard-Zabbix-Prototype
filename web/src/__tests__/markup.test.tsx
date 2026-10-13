import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import * as icons from '../components/icons';
import styles from '../styles.css?raw';

/** The parts of the markup a screen reader meets, kept right by looking at all of it. */

describe('icons', () => {
  const all = Object.entries(icons).filter(([, v]) => typeof v === 'function') as [string, (p: { size?: number }) => JSX.Element][];

  it('has the set to look at', () => {
    expect(all.length).toBeGreaterThanOrEqual(15);
  });

  it.each(all)('%s is hidden from a screen reader and takes no focus: the label beside it names the control', (_name, Icon) => {
    const { container } = render(<Icon />);
    const svg = container.querySelector('svg');
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(svg).toHaveAttribute('focusable', 'false');
  });
});

describe('table headers', () => {
  // Every page and component, as text.
  const sources = import.meta.glob(['../**/*.tsx', '!../__tests__/**'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

  it('looks at the pages', () => {
    expect(Object.keys(sources).length).toBeGreaterThan(20);
  });

  it('leaves no header cell empty: a column of buttons is named "Actions"', () => {
    const empty = Object.entries(sources)
      .filter(([, text]) => /<th\s*\/>|<th>\s*<\/th>/.test(text))
      .map(([file]) => file);
    expect(empty).toEqual([]);
  });
});

describe('wide tables and grids on a narrow screen (UX-14)', () => {
  const sources = import.meta.glob(['../**/*.tsx', '!../__tests__/**'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

  it('puts every table in a box that scrolls sideways, so a wide one cannot push the page', () => {
    const loose = Object.entries(sources)
      .filter(([, text]) => (text.match(/<table\b/g) ?? []).length > (text.match(/className="[^"]*\btable-wrap\b[^"]*"/g) ?? []).length)
      .map(([file]) => file);
    expect(loose).toEqual([]);
  });

  it('lets the two-column grid shrink below its widest content, in both of its layouts', () => {
    const rules = [...styles.matchAll(/(?:^|\n)\s*\.two-col\s*\{([^}]*)\}/g)].map((m) => /grid-template-columns:\s*([^;]+);/.exec(m[1])?.[1]);
    expect(rules).toEqual(['minmax(0, 1.4fr) minmax(0, 1fr)', 'minmax(0, 1fr)']);
  });

  it('keeps the Actions column of a table in view while the rest scrolls', () => {
    const missing = Object.entries(sources)
      .flatMap(([file, text]) => [...text.matchAll(/<th([^>]*)>\s*<span className="sr-only">Actions<\/span>/g)].map((m) => [file, m[1]] as const))
      .filter(([, attrs]) => !attrs.includes('sticky-end'))
      .map(([file]) => file);
    expect(missing).toEqual([]);
    expect(styles).toMatch(/table\.data td\.sticky-end\s*\{[^}]*position:\s*sticky;[^}]*right:\s*0;/);
  });
});
