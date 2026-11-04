/**
 * One CSV field, quoted when it holds a comma, quote or line break (RFC 4180).
 * Text a spreadsheet would run as a formula (starting with =, +, -, @, tab or
 * carriage return) gets a leading apostrophe so it opens as text, following
 * OWASP's CSV injection advice. Plain numbers such as -5 are left alone.
 */
export function csvField(s: string): string {
  // Importers may trim leading spaces before deciding what's a formula, so look past them too.
  const trimmed = s.replace(/^[ \t\r\n]+/, '');
  const risky = /^[=+\-@\t\r]/.test(s) || /^[=+\-@]/.test(trimmed);
  const safe = risky && !/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(trimmed) ? `'${s}` : s;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** Query results as CSV, with readable headings where there are labels. Headings are escaped like cells. */
export function toCsv(vars: string[], rows: Record<string, string>[], labels?: Record<string, string>): string {
  return [vars.map((v) => csvField(labels?.[v] ?? v)).join(','), ...rows.map((r) => vars.map((v) => csvField(r[v] ?? '')).join(','))].join('\n');
}
