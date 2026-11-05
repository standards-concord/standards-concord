/**
 * One CSV field, quoted when it holds a comma, quote or line break (RFC 4180).
 * Text a spreadsheet would run as a formula (starting with =, +, -, @, tab or
 * carriage return) gets a leading apostrophe so it opens as text, following
 * OWASP's CSV injection advice. Plain numbers such as -5 are left alone.
 */
export function csvField(s: string): string {
  // Importers may drop leading spaces, a BOM or other invisible characters before deciding
  // what's a formula, so look past all of them: whitespace, control and format characters.
  const trimmed = s.replace(/^[\s\p{Cc}\p{Cf}\p{Z}]+/u, '');
  const risky = /^[=+\-@\t\r]/.test(s) || /^[=+\-@]/.test(trimmed);
  const safe = risky && !/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(trimmed) ? `'${s}` : s;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/**
 * Query results as CSV, with readable headings where there are labels. Headings are escaped like cells.
 * Rows and headings are by position, never by variable name, so a variable called __proto__ is just a name.
 */
export function toCsv(vars: string[], rows: (string | null)[][], headings?: (string | undefined)[]): string {
  return [vars.map((v, i) => csvField(headings?.[i] ?? v)).join(','), ...rows.map((r) => vars.map((_, i) => csvField(r[i] ?? '')).join(','))].join('\n');
}
