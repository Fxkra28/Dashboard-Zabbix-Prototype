import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as icons from '../components/icons';
import { MethodToggle, MonthSelect } from '../components/Sli';
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

describe('form fields (UX-26)', () => {
  const sources = import.meta.glob(['../**/*.tsx', '!../__tests__/**'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

  /** The attributes of every <input>, <select> and <textarea>, found by walking to the tag's own closing `>` past any `{ ... }`. */
  function fields(text: string): { line: number; attrs: string }[] {
    const out: { line: number; attrs: string }[] = [];
    for (const m of text.matchAll(/<(input|select|textarea)\b/g)) {
      let depth = 0;
      let i = (m.index ?? 0) + m[0].length;
      const start = i;
      for (; i < text.length; i++) {
        const c = text[i];
        if (c === '{') depth++;
        else if (c === '}') depth--;
        else if (c === '>' && depth === 0) break;
      }
      out.push({ line: text.slice(0, m.index).split('\n').length, attrs: text.slice(start, i) });
    }
    return out;
  }

  it('finds the fields to look at', () => {
    const count = Object.values(sources).reduce((n, text) => n + fields(text).length, 0);
    expect(count).toBeGreaterThan(30);
  });

  it('gives every filter, search box and menu an id or a name, which Chrome asks for and autofill needs', () => {
    const bare = Object.entries(sources).flatMap(([file, text]) =>
      fields(text)
        .filter((f) => !/\b(id|name)=/.test(f.attrs))
        .map((f) => `${file}:${f.line}`),
    );
    expect(bare).toEqual([]);
  });

  it('ties the Month label to its menu, so a click on the word focuses it', async () => {
    render(<MonthSelect value="2026-08" onChange={() => undefined} />);
    const label = screen.getByText('Month');
    expect(label.tagName).toBe('LABEL');
    expect(label).toHaveAttribute('for', screen.getByRole('combobox', { name: 'Month' }).id);
    await userEvent.setup().click(label);
    expect(screen.getByRole('combobox', { name: 'Month' })).toHaveFocus();
  });

  it('gives each Month menu an id of its own, so two on a page do not share a label', () => {
    render(
      <>
        <MonthSelect value="2026-08" onChange={() => undefined} />
        <MonthSelect value="2026-08" onChange={() => undefined} label="Compare with" />
      </>,
    );
    const ids = screen.getAllByRole('combobox').map((c) => c.id);
    expect(new Set(ids).size).toBe(2);
    expect(ids.every(Boolean)).toBe(true);
  });

  it('writes the Method heading as plain text, not as a label that points at nothing', () => {
    const { container } = render(<MethodToggle value="availability" onChange={() => undefined} />);
    expect(container.querySelector('label')).toBeNull();
    expect(container.querySelector('.field-label')).toHaveTextContent('Method');
    expect(screen.getByRole('group', { name: 'Calculation method' })).toBeInTheDocument();
  });
});

describe('placeholders and small targets in the stylesheet (UX-25, UX-27)', () => {
  const rule = (selector: string) => {
    const at = styles.indexOf(`${selector} {`);
    return at < 0 ? '' : styles.slice(at, styles.indexOf('}', at));
  };

  it('paints a placeholder in the muted colour of the theme at full strength, so the dark theme is not left to the default grey', () => {
    const text = styles.slice(styles.indexOf('input::placeholder'), styles.indexOf('select:focus'));
    expect(text).toContain('textarea::placeholder');
    expect(text).toMatch(/color:\s*var\(--muted\)/);
    expect(text).toMatch(/opacity:\s*1/);
  });

  it.each([
    ['table.data.ports button.port-open', ['min-width: 24px', 'min-height: 24px']],
    ['.th-sort', ['min-height: 24px']],
    ['.svc-toggle:not(.placeholder)', ['width: 24px', 'height: 24px']],
    ['.sli-unmeasured summary', ['min-height: 24px']],
    ['.chip button', ['min-width: 24px', 'min-height: 24px']],
  ])('keeps %s at 24 px or more, the WCAG 2.2 minimum', (selector, needs) => {
    const body = rule(selector);
    expect(body, `a rule for ${selector}`).not.toBe('');
    for (const need of needs) expect(body).toContain(need);
  });
});
