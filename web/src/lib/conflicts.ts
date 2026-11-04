import { DAY_SHORT, fmtRange, toMinutes } from './time'
import type { BusyRow } from './types'

/** A meeting in the position the user is trying out. Times are minutes after midnight. */
export interface Candidate {
  id: string
  room_id: string
  instructor_id: string | null
  cohort_key: string | null
  day_of_week: number
  start: number
  end: number
}

export type ConflictKind = 'room' | 'instructor' | 'cohort'

export interface Conflict {
  kind: ConflictKind
  other: BusyRow
}

/**
 * The same three rules the database enforces (room, instructor, student block), checked in the browser
 * against every booking the user may see, so a bad drop is caught before it is sent. Ranges are
 * half-open: a class that ends at 9:30 does not clash with one that starts at 9:30.
 */
export function findConflicts(c: Candidate, busy: BusyRow[]): Conflict[] {
  const out: Conflict[] = []
  for (const b of busy) {
    if (b.entry_id === c.id || b.day_of_week !== c.day_of_week) continue
    if (!(toMinutes(b.start_time) < c.end && toMinutes(b.end_time) > c.start)) continue
    if (b.room_id === c.room_id) out.push({ kind: 'room', other: b })
    if (c.instructor_id && b.instructor_id === c.instructor_id) out.push({ kind: 'instructor', other: b })
    if (c.cohort_key && b.cohort_key === c.cohort_key) out.push({ kind: 'cohort', other: b })
  }
  return out
}

export function describeConflict(c: Conflict, roomCode: (id: string) => string, ownDepartmentId: string | null): string {
  const o = c.other
  const who = !o.department_code ? 'another booking' : o.department_id === ownDepartmentId ? 'your department' : o.department_code
  const when = `${DAY_SHORT[o.day_of_week - 1]} ${fmtRange(o.start_time, o.end_time)}`
  if (c.kind === 'room') return `${roomCode(o.room_id)} is already booked ${when} (${who}).`
  if (c.kind === 'instructor') return `The instructor already teaches ${when} (${who}).`
  return `This student block already has a class ${when} (${who}).`
}

/** One line per kind of clash, so a drop onto a crowded slot is explained once, not three times. */
export function summarizeConflicts(
  list: Conflict[],
  roomCode: (id: string) => string,
  ownDepartmentId: string | null,
): string[] {
  const seen = new Set<ConflictKind>()
  const lines: string[] = []
  for (const c of list) {
    if (seen.has(c.kind)) continue
    seen.add(c.kind)
    lines.push(describeConflict(c, roomCode, ownDepartmentId))
  }
  return lines
}
