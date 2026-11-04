import { baseOccupancy, Occupancy } from './occupancy.ts'
import type { Placement, Problem } from './types.ts'

/**
 * Independent check of every hard rule, written separately from the optimiser so a mistake
 * in one cannot hide a mistake in the other. Returns one sentence per violation (empty = fine).
 * The app refuses to save anything that does not come back empty.
 */
export function verify(problem: Problem, placements: Placement[]): string[] {
  const out: string[] = []
  const sections = new Map(problem.sections.map((s) => [s.id, s]))
  const rooms = new Map(problem.rooms.map((r) => [r.id, r]))
  const days = new Set(problem.days)
  const base = baseOccupancy(problem)
  const mine = new Occupancy(problem)
  const seen = new Set<string>()
  const sectionDays = new Map<string, Set<number>>()
  const count = new Map<string, number>()
  const load = new Map<string, number>()

  for (const p of placements) {
    const s = sections.get(p.sectionId)
    const label = `${s?.code ?? p.sectionId} meeting ${p.index + 1}`
    if (!s) {
      out.push(`${label}: unknown section`)
      continue
    }
    const key = `${p.sectionId}#${p.index}`
    if (seen.has(key)) out.push(`${label}: placed twice`)
    seen.add(key)

    const room = rooms.get(p.roomId)
    if (!room) out.push(`${label}: unknown or inactive room`)
    else {
      if (room.capacity < s.enrollment) out.push(`${label}: ${room.code} seats ${room.capacity}, class has ${s.enrollment}`)
      if (s.requiredFacility && !room.facilities.includes(s.requiredFacility)) out.push(`${label}: ${room.code} lacks ${s.requiredFacility}`)
    }
    if (!days.has(p.day)) out.push(`${label}: day not allowed`)
    const hours = problem.dayHours[p.day]
    if (hours && (p.start < hours.open || p.end > hours.close)) out.push(`${label}: outside school hours`)
    if (p.end - p.start !== s.slots) out.push(`${label}: wrong length`)

    if (!base.roomFree(p.roomId, p.day, p.start, p.end)) out.push(`${label}: room already taken by another booking`)
    if (!base.instructorFree(s.instructorId, p.day, p.start, p.end)) out.push(`${label}: instructor busy or unavailable`)
    if (!base.cohortFree(s.cohortKey, p.day, p.start, p.end)) out.push(`${label}: student block already has a class`)
    if (!mine.roomFree(p.roomId, p.day, p.start, p.end)) out.push(`${label}: room double-booked inside this schedule`)
    if (!mine.instructorFree(s.instructorId, p.day, p.start, p.end)) out.push(`${label}: instructor double-booked inside this schedule`)
    if (!mine.cohortFree(s.cohortKey, p.day, p.start, p.end)) out.push(`${label}: student block double-booked inside this schedule`)
    mine.take(p.roomId, s.instructorId, s.cohortKey, p.day, p.start, p.end)

    if (!sectionDays.has(s.id)) sectionDays.set(s.id, new Set(s.lockedDays))
    if (sectionDays.get(s.id)!.has(p.day)) out.push(`${label}: section already meets on that day`)
    sectionDays.get(s.id)!.add(p.day)
    count.set(s.id, (count.get(s.id) ?? 0) + 1)
    if (s.instructorId) load.set(s.instructorId, (load.get(s.instructorId) ?? 0) + (p.end - p.start))
  }

  for (const [id, n] of count) {
    const s = sections.get(id)!
    if (n > s.toPlace) out.push(`${s.code}: ${n} meetings placed but only ${s.toPlace} needed`)
  }
  for (const [id, slots] of load) {
    const cap = problem.instructors[id]?.capSlots
    if (cap !== undefined && slots > cap) out.push(`${problem.instructors[id]!.name}: over the weekly teaching limit`)
  }
  return out
}
