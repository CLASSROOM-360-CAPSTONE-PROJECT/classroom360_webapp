import { baseOccupancy } from './occupancy.ts'
import { dayWeight, fullWeights, roomPenalty } from './score.ts'
import type { Placement, Problem, SchedSection, Weights } from './types.ts'

/**
 * Quick constructive planner. It finishes in milliseconds, gives the optimiser a starting point
 * (a hint), and is the answer of last resort if the optimiser cannot be loaded.
 *
 * Hardest sections go first (long, many meetings, few suitable rooms). Each meeting takes the
 * cheapest free (day, start, room) for the same preferences the optimiser uses.
 */
export function firstFit(problem: Problem, weightOverrides?: Partial<Weights>): Placement[] {
  const w = fullWeights(weightOverrides)
  const occ = baseOccupancy(problem)
  const dayIdx = new Map(problem.days.map((d, i) => [d, i]))
  const load = new Map<string, number>() // slots placed per instructor
  const perDay = new Map<number, number>() // classes placed per weekday, to spread the week
  const teachDays = new Set<string>() // instructor|day pairs that already have a class
  const rooms = new Map(problem.rooms.map((r) => [r.id, r]))
  const placed: Placement[] = []

  const order = problem.sections
    .slice()
    .sort(
      (a: SchedSection, b: SchedSection) =>
        b.toPlace * b.slots - a.toPlace * a.slots || a.roomIds.length - b.roomIds.length || a.code.localeCompare(b.code),
    )

  for (const sec of order) {
    if (sec.roomIds.length === 0) continue
    const cap = sec.instructorId ? (problem.instructors[sec.instructorId]?.capSlots ?? Number.POSITIVE_INFINITY) : Number.POSITIVE_INFINITY
    const usedDays = new Set<number>(sec.lockedDays)
    const mine: Placement[] = []

    for (let k = 0; k < sec.toPlace; k++) {
      if (sec.instructorId && (load.get(sec.instructorId) ?? 0) + sec.slots > cap) break
      let best: { cost: number; day: number; start: number; roomId: string } | null = null

      for (const day of problem.days) {
        if (usedDays.has(day)) continue
        const di = dayIdx.get(day)!
        // consecutive-day penalty against the section's meetings already placed (including kept ones)
        let dayCost = (perDay.get(day) ?? 0) * 2
        if (sec.instructorId && !teachDays.has(`${sec.instructorId}|${day}`)) dayCost += dayWeight(problem, sec.instructorId, w)
        const hours = problem.dayHours[day] ?? { open: problem.open, close: problem.close }
        for (const other of [...usedDays]) {
          const oi = dayIdx.get(other)
          if (oi !== undefined && Math.abs(oi - di) === 1) dayCost += w.consecutiveDays
        }
        for (let start = hours.open; start + sec.slots <= hours.close; start++) {
          const end = start + sec.slots
          if (!occ.instructorFree(sec.instructorId, day, start, end) || !occ.cohortFree(sec.cohortKey, day, start, end)) continue
          const timeCost = w.early * (start - problem.open) + w.late * Math.max(0, start - w.lateFrom)
          for (const roomId of sec.roomIds) {
            if (!occ.roomFree(roomId, day, start, end)) continue
            const roomCost =
              (mine.length > 0 && !mine.some((p) => p.roomId === roomId) ? w.sameRoom : 0) +
              roomPenalty(Boolean(sec.requiredFacility), Boolean(rooms.get(roomId)?.special), w)
            const cost = dayCost + timeCost + roomCost
            if (!best || cost < best.cost) best = { cost, day, start, roomId }
          }
        }
      }
      if (!best) break
      occ.take(best.roomId, sec.instructorId, sec.cohortKey, best.day, best.start, best.start + sec.slots)
      load.set(sec.instructorId ?? '', (load.get(sec.instructorId ?? '') ?? 0) + sec.slots)
      perDay.set(best.day, (perDay.get(best.day) ?? 0) + 1)
      if (sec.instructorId) teachDays.add(`${sec.instructorId}|${best.day}`)
      usedDays.add(best.day)
      const p: Placement = { sectionId: sec.id, index: k, roomId: best.roomId, day: best.day, start: best.start, end: best.start + sec.slots }
      mine.push(p)
      placed.push(p)
    }
  }
  return placed
}
