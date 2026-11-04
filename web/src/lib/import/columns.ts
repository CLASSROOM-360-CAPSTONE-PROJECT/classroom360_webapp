/**
 * Finding the title line of a pasted-in table and matching its column titles loosely, shared by the
 * room and course importers. ("Seats", "Capacity" and "No. of seats" all mean the same column.)
 */
import { cellText, type Issue } from './teachingLoad.ts'

/** a column title in one spelling: lower case, everything but letters and digits turned into single spaces */
export const normTitle = (s: unknown): string => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

export interface Located<F extends string> {
  /** the table row the titles were found on (0-based) */
  headerIdx: number
  col: Map<F, number>
  /** titles in the file that mean nothing to the importer */
  ignored: string[]
}

export function aliasIndex<F extends string>(aliases: Record<F, string[]>): Map<string, F> {
  const index = new Map<string, F>()
  for (const [field, names] of Object.entries(aliases) as Array<[F, string[]]>) for (const n of names) index.set(n, field)
  return index
}

/** The title line is whichever of the top lines has the most recognisable titles (at least `minHits`). */
export function locateColumns<F extends string>(table: unknown[][], aliases: Record<F, string[]>, minHits = 2): Located<F> | null {
  const index = aliasIndex(aliases)
  let best = -1
  let bestHits = 0
  for (let i = 0; i < Math.min(table.length, 15); i++) {
    const hits = new Set((table[i] ?? []).map((c) => index.get(normTitle(c))).filter((f): f is F => Boolean(f))).size
    if (hits >= minHits && hits > bestHits) {
      best = i
      bestHits = hits
    }
  }
  if (best < 0) return null
  const col = new Map<F, number>()
  const ignored: string[] = []
  ;(table[best] ?? []).forEach((cell, i) => {
    const title = cellText(cell)
    if (!title) return
    const field = index.get(normTitle(title))
    if (!field) ignored.push(title)
    else if (!col.has(field)) col.set(field, i)
    else ignored.push(`${title} (a second column for the same thing)`)
  })
  return { headerIdx: best, col, ignored }
}

/** "line 4", "lines 4 and 9", "lines 4, 9 and 12", "lines 4, 9, 12 and 5 more" */
export function lineList(rows: number[]): string {
  const sorted = [...new Set(rows)].sort((a, b) => a - b)
  if (sorted.length === 1) return `line ${sorted[0]}`
  const shown = sorted.slice(0, 6)
  const more = sorted.length - shown.length
  const head = shown.slice(0, -1).join(', ')
  return more > 0 ? `lines ${shown.join(', ')} and ${more} more` : `lines ${head} and ${shown[shown.length - 1]}`
}

/** Collects one message per kind of problem instead of one per line, so a column that is wrong all the way down gives one note. */
export class Grouped {
  private groups = new Map<string, { level: Issue['level']; rows: number[]; make: (rows: number[]) => string }>()
  add(key: string, level: Issue['level'], row: number, make: (rows: number[]) => string) {
    const g = this.groups.get(key)
    if (g) g.rows.push(row)
    else this.groups.set(key, { level, rows: [row], make })
  }
  issues(): Issue[] {
    return [...this.groups.values()].map((g) => ({ row: 0, level: g.level, message: g.make(g.rows) }))
  }
}

export const MAX_ROWS = 1000
