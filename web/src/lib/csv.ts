/** Writing CSV files that open correctly in Excel and cannot run formulas. */

export type CsvCell = string | number | boolean | null | undefined

/**
 * One cell. A text that starts with = + - @ or a control character would be run as a formula by
 * Excel (a reason typed into the audit log could be "=HYPERLINK(...)"), so it gets a leading
 * apostrophe. Numbers are written as numbers and are never touched.
 */
export function csvCell(v: CsvCell): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'boolean') return v ? 'Yes' : 'No'
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : ''
  let s = v
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** Rows to a CSV text: CRLF line ends and, unless told otherwise, a byte-order mark so Excel reads UTF-8. */
export function toCsv(rows: CsvCell[][], options: { bom?: boolean } = {}): string {
  const body = rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + (rows.length ? '\r\n' : '')
  return (options.bom === false ? '' : '﻿') + body
}
