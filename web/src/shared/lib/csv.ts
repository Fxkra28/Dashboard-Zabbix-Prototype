/** The one CSV writer behind every download button, so a new export cannot skip the formula guard. */

// Excel and Sheets run a cell starting with one of these as a formula, quotes or
// not; tab and carriage return are skipped before the formula is read.
const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(value: unknown): string {
  // A finite number is never a formula, and its leading minus is a real sign.
  const text = String(value ?? '');
  const safe = typeof value === 'number' && Number.isFinite(value) ? text : text.replace(FORMULA_START, "'$&");
  return `"${safe.replace(/"/g, '""')}"`;
}

export function toCsv(rows: unknown[][]): string {
  return rows.map((row) => row.map(csvCell).join(',')).join('\n');
}

/** Save `rows` as a CSV file. Callers pass what the page lists, not what the server sent. */
export function downloadCsv(fileName: string, rows: unknown[][]): void {
  const blob = new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}
