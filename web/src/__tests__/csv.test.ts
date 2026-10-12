import { afterEach, describe, expect, it, vi } from 'vitest';
import { csvCell, downloadCsv, toCsv } from '../lib/csv';

describe('csvCell', () => {
  it('quotes every cell and doubles the quotes inside it', () => {
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('plain')).toBe('"plain"');
  });

  it.each(['=1+1', '+1', '-1', '@SUM(A1)', '\t=1+1', '\r=1+1'])('prefixes an apostrophe when a text cell starts the way a formula does: %j', (text) => {
    expect(csvCell(text)).toBe(`"'${text}"`);
  });

  it('leaves a cell alone when the formula character is not first', () => {
    expect(csvCell('a=b')).toBe('"a=b"');
    expect(csvCell(' =1')).toBe('" =1"');
  });

  it('keeps a number as it is, minus sign included', () => {
    expect(csvCell(-12)).toBe('"-12"');
    expect(csvCell(0.5)).toBe('"0.5"');
  });

  it('guards a non-finite number like text, and shows a missing value as an empty cell', () => {
    expect(csvCell(-Infinity)).toBe(`"'-Infinity"`);
    expect(csvCell(null)).toBe('""');
    expect(csvCell(undefined)).toBe('""');
  });
});

describe('toCsv', () => {
  it('joins cells with commas and rows with newlines', () => {
    expect(toCsv([['host', 'n'], ['a', 1]])).toBe('"host","n"\n"a","1"');
  });

  it('guards the cells of every row, header included', () => {
    expect(toCsv([['=x'], ['@y', '-3']])).toBe(`"'=x"\n"'@y","'-3"`);
  });
});

describe('downloadCsv', () => {
  afterEach(() => vi.restoreAllMocks());

  it('saves the guarded text as a CSV file under the given name', async () => {
    let saved: Blob | undefined;
    URL.createObjectURL = vi.fn((b: Blob) => ((saved = b), 'blob:csv'));
    URL.revokeObjectURL = vi.fn();
    const clicked: { download: string; href: string }[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push({ download: this.download, href: this.href });
    });

    downloadCsv('x.csv', [['host'], ['=cmd|calc']]);

    expect(clicked).toEqual([{ download: 'x.csv', href: 'blob:csv' }]);
    expect(saved?.type).toBe('text/csv;charset=utf-8');
    expect(await saved?.text()).toBe(`"host"\n"'=cmd|calc"`);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:csv');
  });
});
