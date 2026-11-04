import { DEFAULT_WEIGHTS, PART_TIME_DAY_FACTOR } from './types.ts'
import type { Placement, Problem, Weights } from './types.ts'

export function fullWeights(w?: Partial<Weights>): Weights {
  return { ...DEFAULT_WEIGHTS, ...(w ?? {}) }
}

/** what one teaching day costs this instructor */
export function dayWeight(problem: Pick<Problem, 'instructors'>, instructorId: string, w: Weights): number {
  return w.instructorDay * (problem.instructors[instructorId]?.partTime ? PART_TIME_DAY_FACTOR : 1)
}

/** extra cost of putting a plain lecture (no facility needed) in a special-facility room */
export function roomPenalty(needsFacility: boolean, roomSpecial: boolean, w: Weights): number {
  return !needsFacility && roomSpecial ? w.labRoom : 0
}

/**
 * How far a timetable is from ideal (lower is better). It uses the same terms as the
 * optimiser's objective, so the first-fit plan and the optimised plan compare fairly.
 */
export function softPenalty(problem: Problem, placements: Placement[], weights?: Partial<Weights>): number {
  const w = fullWeights(weights)
  const dayIdx = new Map(problem.days.map((d, i) => [d, i]))
  const inst = new Map(problem.sections.map((s) => [s.id, s.instructorId]))
  const secs = new Map(problem.sections.map((s) => [s.id, s]))
  const rooms = new Map(problem.rooms.map((r) => [r.id, r]))
  let total = 0

  const bySection = new Map<string, Placement[]>()
  const instructorDays = new Set<string>()
  for (const p of placements) {
    total += w.early * (p.start - problem.open)
    total += w.late * Math.max(0, p.start - w.lateFrom)
    total += roomPenalty(Boolean(secs.get(p.sectionId)?.requiredFacility), Boolean(rooms.get(p.roomId)?.special), w)
    if (!bySection.has(p.sectionId)) bySection.set(p.sectionId, [])
    bySection.get(p.sectionId)!.push(p)
    const i = inst.get(p.sectionId)
    if (i) instructorDays.add(`${i}|${p.day}`)
  }
  for (const key of instructorDays) total += dayWeight(problem, key.split('|')[0]!, w)

  for (const list of bySection.values()) {
    if (list.length < 2) continue
    total += w.sameRoom * (new Set(list.map((p) => p.roomId)).size - 1)
    const days = list.map((p) => dayIdx.get(p.day) ?? 0).sort((a, b) => a - b)
    for (let k = 1; k < days.length; k++) if (days[k]! - days[k - 1]! === 1) total += w.consecutiveDays
  }
  return total
}
