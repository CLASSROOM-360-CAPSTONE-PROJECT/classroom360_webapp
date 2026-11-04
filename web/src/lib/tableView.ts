/**
 * Small helpers behind the search boxes and sortable column headings on the list pages.
 * Pure functions, so they can be tested without a browser.
 */

export type SortDir = 'asc' | 'desc'
export type SortValue = string | number | boolean | null | undefined

/** Lower case with accents removed, so "Peña" is found by "pena". */
export function fold(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
}

/** True when every word typed appears somewhere in the text (in any order). An empty query matches everything. */
export function matchesQuery(text: string, query: string): boolean {
  const words = fold(query).split(/\s+/).filter(Boolean)
  if (words.length === 0) return true
  const hay = fold(text)
  return words.every((w) => hay.includes(w))
}

const blank = (v: SortValue) => v === null || v === undefined || v === ''

/** Ascending order of two values: numbers by size, text with "Room 2" before "Room 10"; blanks are left to the caller. */
export function compareValues(a: SortValue, b: SortValue): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b)
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' })
}

/** A sorted copy. Blank values go last in either direction, and rows that tie keep their order. */
export function sortRows<T>(rows: readonly T[], get: (row: T) => SortValue, dir: SortDir): T[] {
  const sign = dir === 'asc' ? 1 : -1
  return rows
    .map((row, i) => ({ row, i, v: get(row) }))
    .sort((x, y) => {
      const bx = blank(x.v)
      const by = blank(y.v)
      if (bx || by) return bx === by ? x.i - y.i : bx ? 1 : -1
      return sign * compareValues(x.v, y.v) || x.i - y.i
    })
    .map((x) => x.row)
}
