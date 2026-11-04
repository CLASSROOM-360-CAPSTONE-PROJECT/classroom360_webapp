/**
 * Changing a generated plan by hand, before it is saved: move one meeting, place one that the scheduler could not
 * place, or take one off the timetable.
 *
 * Every change is checked against the same hard rules the scheduler and the independent checker use (room size and
 * type, school hours, a room, an instructor and a student block that are free, the instructor's work hours and weekly
 * limit, one meeting of a section per day). A change that would break one is refused with the reasons in plain words,
 * so a plan that has been edited is as safe to save as one that has not.
 */
import { finalize } from './finalize.ts'
import { baseOccupancy, Occupancy } from './occupancy.ts'
import type { Placement, Problem, SolveResult, Weights } from './types.ts'

const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

/** "8:00 AM" for a slot boundary (slots are half hours after midnight). */
export function clock(slot: number): string {
  const min = slot * 30
  const h = Math.floor(min / 60)
  const m = min % 60
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`
}

export interface Target {
  roomId: string
  /** weekday, 0 = Monday */
  day: number
  /** first slot of the meeting */
  start: number
}

// what is booked before this plan starts never changes for a problem, so it is worked out once (picking a free time asks hundreds of times)
const baseCache = new WeakMap<Problem, ReturnType<typeof baseOccupancy>>()
function baseOf(problem: Problem): ReturnType<typeof baseOccupancy> {
  let b = baseCache.get(problem)
  if (!b) {
    b = baseOccupancy(problem)
    baseCache.set(problem, b)
  }
  return b
}

const same = (p: Placement, sectionId: string, index: number) => p.sectionId === sectionId && p.index === index

const overlaps = (p: Placement, day: number, start: number, end: number) => p.day === day && p.start < end && start < p.end

/**
 * Why the meeting cannot go there; an empty list means it can. `ignoreIndex` is the meeting being moved (its present
 * place does not count against it); it is null for a meeting that is not on the timetable yet.
 */
export function placementProblems(
  problem: Problem,
  placements: Placement[],
  sectionId: string,
  ignoreIndex: number | null,
  to: Target,
): string[] {
  const s = problem.sections.find((x) => x.id === sectionId)
  if (!s) return ['That class is not part of this plan.']
  const room = problem.rooms.find((r) => r.id === to.roomId)
  if (!room) return ['That room is not available.']
  const end = to.start + s.slots
  const others = placements.filter((p) => !(ignoreIndex !== null && same(p, sectionId, ignoreIndex)))
  const out: string[] = []
  const day = DAY_NAMES[to.day] ?? 'that day'
  const when = `${day} ${clock(to.start)} to ${clock(end)}`

  // the room itself
  if (room.capacity < s.enrollment) out.push(`${room.code} seats ${room.capacity} but this class has ${s.enrollment} students.`)
  if (s.requiredFacility && !room.facilities.includes(s.requiredFacility)) {
    out.push(`${room.code} is not a ${s.requiredFacility.replace(/_/g, ' ')} room, which this class needs.`)
  }

  // the school's opening hours
  const hours = problem.dayHours[to.day]
  if (!hours || !problem.days.includes(to.day)) {
    out.push(`The school is closed on ${day}.`)
  } else if (to.start < hours.open || end > hours.close) {
    out.push(`${when} is outside school hours (${clock(hours.open)} to ${clock(hours.close)} on ${day}).`)
  }

  // other bookings, work hours and unavailable times (everything that is fixed), then this plan's own meetings
  const base = baseOf(problem)
  const mine = new Occupancy(problem)
  const bySection = new Map(problem.sections.map((x) => [x.id, x]))
  for (const p of others) {
    const ps = bySection.get(p.sectionId)
    if (ps) mine.take(p.roomId, ps.instructorId, ps.cohortKey, p.day, p.start, p.end)
  }
  const inPlan = (test: (ps: (typeof problem.sections)[number]) => boolean): Placement | undefined =>
    others.find((p) => {
      const ps = bySection.get(p.sectionId)
      return ps && overlaps(p, to.day, to.start, end) && test(ps)
    })
  const codeOf = (p: Placement | undefined) => (p ? (bySection.get(p.sectionId)?.code ?? p.sectionId) : '')

  const inHours = Boolean(hours) && to.start >= hours!.open && end <= hours!.close
  if (inHours) {
    if (!base.roomFree(to.roomId, to.day, to.start, end)) out.push(`${room.code} is booked by another department on ${when}.`)
    else if (!mine.roomFree(to.roomId, to.day, to.start, end)) {
      const clash = others.find((p) => p.roomId === to.roomId && overlaps(p, to.day, to.start, end))
      out.push(`${room.code} already has ${codeOf(clash)} on ${when}.`)
    }
    if (s.instructorId) {
      const name = problem.instructors[s.instructorId]?.name ?? 'The instructor'
      if (!base.instructorFree(s.instructorId, to.day, to.start, end)) {
        out.push(`${name} cannot teach on ${when}: outside their working hours, marked unavailable, or teaching another class.`)
      } else if (!mine.instructorFree(s.instructorId, to.day, to.start, end)) {
        out.push(`${name} already teaches ${codeOf(inPlan((ps) => ps.instructorId === s.instructorId))} on ${when}.`)
      }
    }
    if (s.cohortKey) {
      if (!base.cohortFree(s.cohortKey, to.day, to.start, end)) out.push(`This student block already has another class on ${when} (another program or department).`)
      else if (!mine.cohortFree(s.cohortKey, to.day, to.start, end)) {
        out.push(`This student block already has ${codeOf(inPlan((ps) => ps.cohortKey === s.cohortKey))} on ${when}.`)
      }
    }
  }

  // one meeting of a section per day
  if (s.lockedDays.includes(to.day) || others.some((p) => p.sectionId === sectionId && p.day === to.day)) {
    out.push(`${s.code} already meets on ${day}; each meeting of a class needs its own day.`)
  }

  // the instructor's weekly limit
  if (s.instructorId) {
    const inst = problem.instructors[s.instructorId]
    if (inst) {
      let slots = s.slots
      for (const p of others) if (bySection.get(p.sectionId)?.instructorId === s.instructorId) slots += p.end - p.start
      if (slots > inst.capSlots) out.push(`${inst.name} would go over the weekly teaching limit.`)
    }
  }
  return [...new Set(out)]
}

/** The smallest meeting number of a section that is not on the timetable. */
function freeIndex(placements: Placement[], sectionId: string): number {
  const used = new Set(placements.filter((p) => p.sectionId === sectionId).map((p) => p.index))
  let i = 0
  while (used.has(i)) i++
  return i
}

export type Edit =
  | { ok: true; result: SolveResult }
  | { ok: false; reasons: string[] }

const rebuild = (problem: Problem, from: SolveResult, placements: Placement[], weights?: Partial<Weights>): SolveResult =>
  finalize(problem, placements, { engine: from.engine, proven: false, runtimeMs: from.runtimeMs, notes: from.notes, weights })

/**
 * Moves a meeting on the timetable (`index` is its number), or puts one that is not on it yet (`index` null) at `to`.
 * Refused, with the reasons, when it would break a hard rule.
 */
export function placeMeeting(
  problem: Problem,
  current: SolveResult,
  sectionId: string,
  index: number | null,
  to: Target,
  weights?: Partial<Weights>,
): Edit {
  const s = problem.sections.find((x) => x.id === sectionId)
  if (!s) return { ok: false, reasons: ['That class is not part of this plan.'] }
  if (index === null) {
    const placed = current.placements.filter((p) => p.sectionId === sectionId).length
    if (placed >= s.toPlace) return { ok: false, reasons: [`${s.code} already has all its meetings on the timetable.`] }
  } else if (!current.placements.some((p) => same(p, sectionId, index))) {
    return { ok: false, reasons: ['That meeting is not on the timetable.'] }
  }
  const reasons = placementProblems(problem, current.placements, sectionId, index, to)
  if (reasons.length > 0) return { ok: false, reasons }
  const end = to.start + s.slots
  const idx = index ?? freeIndex(current.placements, sectionId)
  const moved: Placement = { sectionId, index: idx, roomId: to.roomId, day: to.day, start: to.start, end }
  const placements = [...current.placements.filter((p) => !same(p, sectionId, idx)), moved]
  return { ok: true, result: rebuild(problem, current, placements, weights) }
}

/** Takes a meeting off the timetable. It becomes one of the meetings that still need a place. */
export function unplaceMeeting(problem: Problem, current: SolveResult, sectionId: string, index: number, weights?: Partial<Weights>): Edit {
  if (!current.placements.some((p) => same(p, sectionId, index))) return { ok: false, reasons: ['That meeting is not on the timetable.'] }
  return { ok: true, result: rebuild(problem, current, current.placements.filter((p) => !same(p, sectionId, index)), weights) }
}

/**
 * The first place where the meeting can go without breaking a rule: the preferred room first, then the others; earliest
 * day and time first. Null when no room has any such time left.
 */
export function findFreePlace(
  problem: Problem,
  placements: Placement[],
  sectionId: string,
  ignoreIndex: number | null,
  preferRoomId?: string,
): Target | null {
  const s = problem.sections.find((x) => x.id === sectionId)
  if (!s) return null
  const rooms = problem.rooms
    .filter((r) => s.roomIds.includes(r.id))
    .sort((a, b) => Number(b.id === preferRoomId) - Number(a.id === preferRoomId))
  for (const r of rooms) {
    for (const day of problem.days) {
      const h = problem.dayHours[day]
      if (!h) continue
      for (let start = h.open; start + s.slots <= h.close; start++) {
        if (placementProblems(problem, placements, sectionId, ignoreIndex, { roomId: r.id, day, start }).length === 0) {
          return { roomId: r.id, day, start }
        }
      }
    }
  }
  return null
}

export interface EditSummary {
  /** meetings that were on the timetable and are now somewhere else */
  moved: number
  /** meetings from the "not placed" list that were put on the timetable */
  placed: number
  /** meetings that were on the timetable and were taken off it */
  removed: number
}

/** Identifies where a meeting is: the same text for the same class in the same room, day and time. */
export const spotKey = (p: Placement) => `${p.sectionId}|${p.roomId}|${p.day}|${p.start}`

/** What was changed by hand: compares a plan with the one the scheduler made. */
export function summarizeEdits(original: Placement[], current: Placement[]): EditSummary {
  const was = new Set(original.map(spotKey))
  const now = new Set(current.map(spotKey))
  const added = new Map<string, number>()
  const gone = new Map<string, number>()
  for (const p of current) if (!was.has(spotKey(p))) added.set(p.sectionId, (added.get(p.sectionId) ?? 0) + 1)
  for (const p of original) if (!now.has(spotKey(p))) gone.set(p.sectionId, (gone.get(p.sectionId) ?? 0) + 1)
  let moved = 0
  let placed = 0
  let removed = 0
  for (const id of new Set([...added.keys(), ...gone.keys()])) {
    const a = added.get(id) ?? 0
    const g = gone.get(id) ?? 0
    const pair = Math.min(a, g)
    moved += pair
    placed += a - pair
    removed += g - pair
  }
  return { moved, placed, removed }
}

/** "1 moved, 2 placed from the list" for a note, or an empty string when nothing changed. */
export function editSummaryText(s: EditSummary): string {
  const parts: string[] = []
  if (s.moved) parts.push(`${s.moved} moved`)
  if (s.placed) parts.push(`${s.placed} placed from the list`)
  if (s.removed) parts.push(`${s.removed} taken off`)
  return parts.join(', ')
}
