import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import * as icons from '../components/icons';

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
