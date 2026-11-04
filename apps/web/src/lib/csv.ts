/** One CSV field, quoted when it holds a comma, quote or line break (RFC 4180). */
export function csvField(s: string): string {
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Query results as CSV, with readable headings where there are labels. Headings are escaped like cells. */
export function toCsv(vars: string[], rows: Record<string, string>[], labels?: Record<string, string>): string {
  return [vars.map((v) => csvField(labels?.[v] ?? v)).join(','), ...rows.map((r) => vars.map((v) => csvField(r[v] ?? '')).join(','))].join('\n');
}
