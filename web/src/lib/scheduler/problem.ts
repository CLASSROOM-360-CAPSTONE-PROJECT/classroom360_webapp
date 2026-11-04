import { DEFAULT_WEIGHTS, SLOTS_PER_DAY, SLOT_MINUTES } from './types.ts'
import type { Block, FixedBooking, Problem, SchedInstructor, SchedRoom, SchedSection, Unavailable } from './types.ts'

/** Rows as the database returns them. */
export interface RawSection {
  id: string
  code: string
  year_level: number | null
  cohort: string | null
  program_id: string
  enrollment: number
  instructor_id: string | null
  meetings_per_week: number
  minutes_per_meeting: number
  /** 'lecture' or 'lab'. Older rows have none: the course's room type then applies to every meeting. */
  component?: string | null
  course: { code: string; required_facility: string | null; lab_units?: number | null } | null
}
export interface RawRoom {
  id: string
  code: string
  capacity: number
  facilities: string[] | null
  is_active: boolean
}
export interface RawInstructor {
  id: string
  full_name: string
  max_weekly_hours: number
  employment_type?: string | null
}
/** When an instructor works. An instructor with any of these may only be scheduled inside them. */
export interface RawWorkHours {
  instructor_id: string
  day_of_week: number
  start_time: string
  end_time: string
}
/** When the school is open. A weekday with no row is closed. */
export interface RawSchoolHours {
  day_of_week: number
  opens_at: string
  closes_at: string
}
export interface RawUnavailability {
  instructor_id: string
  day_of_week: number
  start_time: string
  end_time: string
}
/** One row of schedule_busy(): everything already booked, in every department, except returned meetings. */
export interface RawBusy {
  entry_id: string
  room_id: string
  instructor_id: string | null
  cohort_key: string | null
  day_of_week: number
  start_time: string
  end_time: string
}
/** The programs' own meetings. */
export interface RawOwnEntry {
  id: string
  section_id: string
  status: string
  day_of_week: number
  /** a pinned draft stays where it is when the schedule is generated again */
  is_pinned?: boolean
}

export interface BuildInput {
  sections: RawSection[]
  rooms: RawRoom[]
  instructors: RawInstructor[]
  unavailability: RawUnavailability[]
  busy: RawBusy[]
  ownEntries: RawOwnEntry[]
  workHours?: RawWorkHours[]
  /** the school's operating hours per weekday. When given they decide the days and hours (weekdays below can only narrow them). */
  schoolHours?: RawSchoolHours[]
  /** ISO weekdays (1 = Monday) classes may be placed on. Default Monday to Saturday. */
  weekdays?: number[]
  /** without schoolHours: first start and last finish, in minutes after midnight. Default 07:00 and 21:00. */
  openMinutes?: number
  closeMinutes?: number
}

const REPLACEABLE = new Set(['draft', 'returned'])

/** Draft and rejected meetings are replaced by a new plan, unless the chair pinned them. */
export const isReplaceable = (e: Pick<RawOwnEntry, 'status' | 'is_pinned'>) => REPLACEABLE.has(e.status) && !e.is_pinned

export function minutesOf(t: string): number {
  const [h, m] = t.split(':')
  return Number(h) * 60 + Number(m)
}
export const slotFloor = (min: number) => Math.floor(min / SLOT_MINUTES)
export const slotCeil = (min: number) => Math.ceil(min / SLOT_MINUTES)

/** 'HH:MM' for a slot boundary. */
export function slotTime(slot: number): string {
  const min = slot * SLOT_MINUTES
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`
}

/**
 * The room type a section's meetings need, if any. A course with laboratory hours is split into a
 * lecture part (any room) and a lab part (the course's room type); a course without them keeps the
 * room type for its ordinary meetings.
 */
export function facilityFor(s: Pick<RawSection, 'component' | 'course'>): string | null {
  const f = s.course?.required_facility ?? null
  if (!f) return null
  const hasLab = (s.course?.lab_units ?? 0) > 0
  return s.component === 'lab' || !hasLab ? f : null
}

/** Same key the database builds in schedule_entries_sync(). */
export function cohortKeyOf(s: { program_id: string; year_level: number | null; cohort: string | null }): string | null {
  return s.cohort == null ? null : `${s.program_id}:${s.year_level ?? ''}:${s.cohort}`
}

/**
 * Turns database rows into the problem the solver works on.
 *
 *  - The programs' own draft and returned meetings are about to be replaced, so they do not block anything.
 *  - Their submitted, approved and published meetings stay, and so do pinned drafts: they count towards each
 *    section's weekly total, occupy their days, and block rooms like everyone else's.
 *  - Several programs can be planned together: their sections are placed in one go, so a shared instructor or
 *    room is never promised twice.
 *  - Everything other departments have booked (from schedule_busy) becomes a fixed block.
 */
export function buildProblem(input: BuildInput): Problem {
  // when is the school open? (per weekday; the older single window is the fallback)
  const allowed = new Set((input.weekdays ?? [1, 2, 3, 4, 5, 6, 7]).map((d) => d))
  const dayHours: Record<number, { open: number; close: number }> = {}
  if (input.schoolHours && input.schoolHours.length > 0) {
    for (const h of input.schoolHours) {
      if (!allowed.has(h.day_of_week)) continue
      const o = slotCeil(minutesOf(h.opens_at))
      const c = slotFloor(minutesOf(h.closes_at))
      if (c > o) dayHours[h.day_of_week - 1] = { open: o, close: c }
    }
  } else {
    const o = slotCeil(input.openMinutes ?? 7 * 60)
    const c = slotFloor(input.closeMinutes ?? 21 * 60)
    for (const d of input.weekdays ?? [1, 2, 3, 4, 5, 6]) dayHours[d - 1] = { open: o, close: c }
  }
  const days = Object.keys(dayHours).map(Number).sort((a, b) => a - b)
  const dayOk = new Set(days)
  const open = days.length ? Math.min(...days.map((d) => dayHours[d]!.open)) : 14
  const close = days.length ? Math.max(...days.map((d) => dayHours[d]!.close)) : 42

  const rooms: SchedRoom[] = input.rooms
    .filter((r) => r.is_active)
    .map((r) => ({ id: r.id, code: r.code, capacity: r.capacity, facilities: r.facilities ?? [], special: (r.facilities ?? []).length > 0 }))

  // a day that opens late or closes early is closed for every room during the difference
  const closure: FixedBooking[] = []
  for (const room of rooms) {
    for (const d of days) {
      const h = dayHours[d]!
      if (h.open > open) closure.push({ day: d, start: open, end: h.open, roomId: room.id, instructorId: null, cohortKey: null })
      if (h.close < close) closure.push({ day: d, start: h.close, end: close, roomId: room.id, instructorId: null, cohortKey: null })
    }
  }

  const replaceable = new Set(input.ownEntries.filter(isReplaceable).map((e) => e.id))
  const keptCount = new Map<string, number>()
  const keptDays = new Map<string, Set<number>>()
  for (const e of input.ownEntries) {
    if (isReplaceable(e)) continue
    keptCount.set(e.section_id, (keptCount.get(e.section_id) ?? 0) + 1)
    if (!keptDays.has(e.section_id)) keptDays.set(e.section_id, new Set())
    keptDays.get(e.section_id)!.add(e.day_of_week - 1)
  }

  const fixed: FixedBooking[] = []
  const taught = new Map<string, number>() // slots each instructor already teaches (any day, any department)
  for (const b of input.busy) {
    if (replaceable.has(b.entry_id)) continue
    const start = slotFloor(minutesOf(b.start_time))
    const end = slotCeil(minutesOf(b.end_time))
    if (b.instructor_id) taught.set(b.instructor_id, (taught.get(b.instructor_id) ?? 0) + (end - start))
    const day = b.day_of_week - 1
    if (!dayOk.has(day)) continue
    fixed.push({ day, start, end, roomId: b.room_id, instructorId: b.instructor_id, cohortKey: b.cohort_key })
  }

  const instructors: Record<string, SchedInstructor> = {}
  for (const i of input.instructors) {
    const cap = Math.floor((i.max_weekly_hours * 60) / SLOT_MINUTES) - (taught.get(i.id) ?? 0)
    instructors[i.id] = { id: i.id, name: i.full_name, capSlots: cap, partTime: i.employment_type === 'part_time' }
  }

  const unavailable: Unavailable[] = []
  for (const u of input.unavailability) {
    const day = u.day_of_week - 1
    if (!dayOk.has(day)) continue
    unavailable.push({ instructorId: u.instructor_id, day, start: slotFloor(minutesOf(u.start_time)), end: slotCeil(minutesOf(u.end_time)) })
  }

  // work hours: an instructor with any may only teach inside them, so everything outside is unavailable
  const windows = new Map<string, Map<number, Array<[number, number]>>>()
  for (const w of input.workHours ?? []) {
    const day = w.day_of_week - 1
    if (!instructors[w.instructor_id]) continue
    if (!windows.has(w.instructor_id)) windows.set(w.instructor_id, new Map())
    const byDay = windows.get(w.instructor_id)!
    if (!byDay.has(day)) byDay.set(day, [])
    byDay.get(day)!.push([slotCeil(minutesOf(w.start_time)), slotFloor(minutesOf(w.end_time))])
  }
  for (const [instructorId, byDay] of windows) {
    for (const day of days) {
      let cursor = 0
      for (const [a, b] of mergeBlocks((byDay.get(day) ?? []).filter(([a, b]) => b > a))) {
        if (a > cursor) unavailable.push({ instructorId, day, start: cursor, end: a })
        cursor = Math.max(cursor, b)
      }
      if (cursor < SLOTS_PER_DAY) unavailable.push({ instructorId, day, start: cursor, end: SLOTS_PER_DAY })
    }
  }

  const sections: SchedSection[] = []
  for (const s of input.sections) {
    const toPlace = Math.max(0, s.meetings_per_week - (keptCount.get(s.id) ?? 0))
    if (toPlace === 0) continue
    const facility = facilityFor(s)
    sections.push({
      id: s.id,
      code: s.code,
      courseCode: s.course?.code ?? '',
      cohortKey: cohortKeyOf(s),
      instructorId: s.instructor_id,
      enrollment: s.enrollment,
      requiredFacility: facility,
      toPlace,
      slots: slotCeil(s.minutes_per_meeting),
      minutes: s.minutes_per_meeting,
      lockedDays: [...(keptDays.get(s.id) ?? [])].filter((d) => dayOk.has(d)),
      roomIds: rooms
        .filter((r) => r.capacity >= s.enrollment && (!facility || r.facilities.includes(facility)))
        .map((r) => r.id),
    })
  }

  return { days, open, close, dayHours, closure, rooms, sections, instructors, unavailable, fixed }
}

/** [start, end) pairs merged so touching or overlapping stretches become one. */
export function mergeBlocks(blocks: Array<[number, number]>): Array<[number, number]> {
  const sorted = blocks.slice().sort((a, b) => a[0] - b[0])
  const out: Array<[number, number]> = []
  for (const [s, e] of sorted) {
    const last = out[out.length - 1]
    if (last && s <= last[1]) last[1] = Math.max(last[1], e)
    else out.push([s, e])
  }
  return out
}

export function blockKey(b: Block): string {
  return `${b.day}:${b.start}-${b.end}`
}

export { DEFAULT_WEIGHTS, SLOTS_PER_DAY }
