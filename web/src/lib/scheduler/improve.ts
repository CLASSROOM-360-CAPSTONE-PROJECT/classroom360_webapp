import { baseOccupancy } from './occupancy.ts'
import { dayWeight, fullWeights, roomPenalty } from './score.ts'
import type { Placement, Problem, Weights } from './types.ts'

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())

/** small deterministic generator, so the same problem gives the same answer */
function prng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Local search over a complete, valid timetable: repeatedly try moving one class to another
 * day, time or room, keeping the move when it lowers the preference penalty (and, early on,
 * sometimes when it does not, to escape dead ends). A move is only ever tried if it breaks no
 * hard rule, so the result is as valid as the starting point.
 *
 * The optimiser (CP-SAT) in the browser build runs a single search thread, which is good at
 * finding any valid timetable but slow at polishing a large one. This step does the polishing.
 */
export function improve(
  problem: Problem,
  start: Placement[],
  weightOverrides: Partial<Weights> | undefined,
  budgetMs: number,
  onBetter?: (placements: Placement[]) => void,
): Placement[] {
  if (start.length === 0 || budgetMs <= 0) return start
  const w: Weights = fullWeights(weightOverrides)
  const rand = prng(20261103)
  const t0 = now()

  const sections = new Map(problem.sections.map((s) => [s.id, s]))
  const dayPos = new Map(problem.days.map((d, i) => [d, i]))
  const rooms = new Map(problem.rooms.map((r) => [r.id, r]))
  const hoursOf = (day: number) => problem.dayHours[day] ?? { open: problem.open, close: problem.close }
  const roomCost = (sec: { requiredFacility: string | null }, roomId: string) =>
    roomPenalty(Boolean(sec.requiredFacility), Boolean(rooms.get(roomId)?.special), w)
  let cur: Placement[] = []
  let occ = baseOccupancy(problem)
  let mine = new Map<string, number[]>() // section -> indices into cur
  let instDays = new Map<string, number>() // "instructor|day" -> number of meetings
  const bump = (inst: string | null, day: number, by: number) => {
    if (!inst) return
    const k = `${inst}|${day}`
    const n = (instDays.get(k) ?? 0) + by
    if (n <= 0) instDays.delete(k)
    else instDays.set(k, n)
  }
  /** (re)builds all bookkeeping from a plan */
  const load = (plan: Placement[]) => {
    cur = plan.map((p) => ({ ...p }))
    occ = baseOccupancy(problem)
    mine = new Map()
    instDays = new Map()
    cur.forEach((p, i) => {
      const s = sections.get(p.sectionId)!
      occ.take(p.roomId, s.instructorId, s.cohortKey, p.day, p.start, p.end)
      if (!mine.has(p.sectionId)) mine.set(p.sectionId, [])
      mine.get(p.sectionId)!.push(i)
      bump(s.instructorId, p.day, 1)
    })
  }
  load(start)

  const timeCost = (startSlot: number) => w.early * (startSlot - problem.open) + w.late * Math.max(0, startSlot - w.lateFrom)

  /** room spread and consecutive days of one section, given its meetings */
  const sectionCost = (indices: number[], override?: { at: number; p: Placement }) => {
    if (indices.length < 2) return 0
    const list = indices.map((i) => (override && override.at === i ? override.p : cur[i]!))
    let c = w.sameRoom * (new Set(list.map((p) => p.roomId)).size - 1)
    const days = list.map((p) => dayPos.get(p.day) ?? 0).sort((a, b) => a - b)
    for (let k = 1; k < days.length; k++) if (days[k]! - days[k - 1]! === 1) c += w.consecutiveDays
    return c
  }

  let total = 0
  for (const p of cur) total += timeCost(p.start) + roomCost(sections.get(p.sectionId)!, p.roomId)
  for (const idx of mine.values()) total += sectionCost(idx)
  for (const key of instDays.keys()) total += dayWeight(problem, key.split('|')[0]!, w)

  let best = cur.map((p) => ({ ...p }))
  let bestTotal = total
  const T0 = Math.max(1.5, bestTotal / Math.max(1, cur.length) / 6)
  const CYCLE = 250_000 // proposals per cooling cycle; after each cycle the search returns to the best plan
  const MAX_IDLE_CYCLES = 6
  let inCycle = 0
  let idleCycles = 0
  let improvedThisCycle = false

  let iter = 0
  while (true) {
    if ((iter & 255) === 0 && now() - t0 >= budgetMs) break
    iter++
    if (++inCycle > CYCLE) {
      if (!improvedThisCycle && ++idleCycles >= MAX_IDLE_CYCLES) break
      if (improvedThisCycle) idleCycles = 0
      improvedThisCycle = false
      inCycle = 0
      load(best)
      total = bestTotal
    }
    const temp = T0 * (1 - inCycle / CYCLE) ** 2 + 0.05

    const i = Math.floor(rand() * cur.length)
    const p = cur[i]!
    const sec = sections.get(p.sectionId)!
    const length = p.end - p.start

    // propose: shift in time, change room, or relocate
    let day = p.day
    let startSlot = p.start
    let roomId = p.roomId
    const r = rand()
    if (r < 0.4) {
      startSlot = p.start + (Math.floor(rand() * 9) - 4)
    } else if (r < 0.6) {
      roomId = sec.roomIds[Math.floor(rand() * sec.roomIds.length)]!
    } else {
      day = problem.days[Math.floor(rand() * problem.days.length)]!
      const h = hoursOf(day)
      if (h.close - length < h.open) continue
      startSlot = h.open + Math.floor(rand() * (h.close - length - h.open + 1))
      if (rand() < 0.5) roomId = sec.roomIds[Math.floor(rand() * sec.roomIds.length)]!
    }
    if (day === p.day && startSlot === p.start && roomId === p.roomId) continue
    const hours = hoursOf(day)
    if (startSlot < hours.open || startSlot + length > hours.close) continue

    // a section never meets twice on one day (kept meetings count too)
    if (day !== p.day) {
      if (sec.lockedDays.includes(day)) continue
      let clash = false
      for (const j of mine.get(sec.id)!) if (j !== i && cur[j]!.day === day) { clash = true; break }
      if (clash) continue
    }

    // hard rules: free the meeting's own slots, test the new ones
    occ.release(p.roomId, sec.instructorId, sec.cohortKey, p.day, p.start, p.end)
    const end = startSlot + length
    const ok =
      occ.roomFree(roomId, day, startSlot, end) &&
      occ.instructorFree(sec.instructorId, day, startSlot, end) &&
      occ.cohortFree(sec.cohortKey, day, startSlot, end)
    if (!ok) {
      occ.take(p.roomId, sec.instructorId, sec.cohortKey, p.day, p.start, p.end)
      continue
    }

    // preference change
    const moved: Placement = { ...p, day, start: startSlot, end, roomId }
    const idx = mine.get(sec.id)!
    let delta = timeCost(startSlot) - timeCost(p.start) + roomCost(sec, roomId) - roomCost(sec, p.roomId)
    delta += sectionCost(idx, { at: i, p: moved }) - sectionCost(idx)
    if (sec.instructorId && day !== p.day) {
      const before = instDays.size
      bump(sec.instructorId, p.day, -1)
      bump(sec.instructorId, day, 1)
      delta += dayWeight(problem, sec.instructorId, w) * (instDays.size - before)
      // undo the bookkeeping; it is redone below if the move is kept
      bump(sec.instructorId, day, -1)
      bump(sec.instructorId, p.day, 1)
    }

    if (delta <= 0 || rand() < Math.exp(-delta / temp)) {
      occ.take(roomId, sec.instructorId, sec.cohortKey, day, startSlot, end)
      if (sec.instructorId && day !== p.day) {
        bump(sec.instructorId, p.day, -1)
        bump(sec.instructorId, day, 1)
      }
      cur[i] = moved
      total += delta
      if (total < bestTotal) {
        bestTotal = total
        best = cur.map((q) => ({ ...q }))
        improvedThisCycle = true
        onBetter?.(best)
      }
    } else {
      occ.take(p.roomId, sec.instructorId, sec.cohortKey, p.day, p.start, p.end)
    }
  }
  return best
}
