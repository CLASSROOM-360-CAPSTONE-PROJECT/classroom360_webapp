import { baseOccupancy } from './occupancy.ts'
import type { Placement, Problem, Unplaced } from './types.ts'

/**
 * Meetings that did not get a place, each with a plain-language reason the chair can act on.
 * One reason per section (all of a section's missing meetings share it).
 */
export function explainUnplaced(problem: Problem, placements: Placement[]): Unplaced[] {
  const out: Unplaced[] = []
  const occ = baseOccupancy(problem)
  const bySection = new Map<string, Placement[]>()
  const taught = new Map<string, number>() // slots each instructor teaches in these placements
  for (const p of placements) {
    const sec = problem.sections.find((s) => s.id === p.sectionId)
    if (!sec) continue
    occ.take(p.roomId, sec.instructorId, sec.cohortKey, p.day, p.start, p.end)
    if (sec.instructorId) taught.set(sec.instructorId, (taught.get(sec.instructorId) ?? 0) + (p.end - p.start))
    if (!bySection.has(p.sectionId)) bySection.set(p.sectionId, [])
    bySection.get(p.sectionId)!.push(p)
  }

  for (const sec of problem.sections) {
    const done = bySection.get(sec.id) ?? []
    const missing = sec.toPlace - done.length
    if (missing <= 0) continue
    const reason = reasonFor(problem, sec.id, done, occ, taught)
    for (let k = done.length; k < sec.toPlace; k++) out.push({ sectionId: sec.id, index: k, reason })
  }
  return out
}

function reasonFor(
  problem: Problem,
  sectionId: string,
  done: Placement[],
  occ: ReturnType<typeof baseOccupancy>,
  taught: Map<string, number>,
): string {
  const sec = problem.sections.find((s) => s.id === sectionId)!
  if (sec.roomIds.length === 0) {
    const bigEnough = problem.rooms.filter((r) => r.capacity >= sec.enrollment)
    if (bigEnough.length === 0) return `No room seats ${sec.enrollment} students.`
    return `No room that seats ${sec.enrollment} also has the required facility (${sec.requiredFacility}).`
  }
  const used = new Set<number>([...sec.lockedDays, ...done.map((p) => p.day)])
  const freeDays = problem.days.filter((d) => !used.has(d))
  if (freeDays.length === 0) return 'The section has more meetings than days it can use (each meeting needs its own day).'

  if (sec.instructorId) {
    const inst = problem.instructors[sec.instructorId]
    if (inst && (taught.get(sec.instructorId) ?? 0) + sec.slots > inst.capSlots) {
      return `${inst.name} would go over the weekly teaching limit.`
    }
  }

  let someoneFree = false
  for (const day of freeDays) {
    const hours = problem.dayHours[day] ?? { open: problem.open, close: problem.close }
    for (let start = hours.open; start + sec.slots <= hours.close; start++) {
      const end = start + sec.slots
      if (!occ.instructorFree(sec.instructorId, day, start, end) || !occ.cohortFree(sec.cohortKey, day, start, end)) continue
      someoneFree = true
      if (sec.roomIds.some((r) => occ.roomFree(r, day, start, end))) {
        return 'A place exists, but the optimiser ran out of time before using it. Run it again with a longer time limit.'
      }
    }
  }
  if (!someoneFree) {
    return sec.instructorId
      ? 'The instructor (work hours, other classes, unavailable times) and the student block have no common free time left on the days this section can still use.'
      : 'The student block has no free time left on the days this section can still use.'
  }
  return 'Every suitable room is taken whenever the instructor and the student block are both free.'
}
