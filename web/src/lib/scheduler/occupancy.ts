import { SLOTS_PER_DAY } from './types.ts'
import type { Problem } from './types.ts'

/**
 * Which slots of the week are taken, per room, per instructor and per student block.
 * Used by the first-fit planner and by the rule checker.
 */
export class Occupancy {
  private readonly dayIndex: Map<number, number>
  private readonly week: number
  private readonly room = new Map<string, Uint8Array>()
  private readonly inst = new Map<string, Uint8Array>()
  private readonly coh = new Map<string, Uint8Array>()

  constructor(problem: Pick<Problem, 'days'>) {
    this.dayIndex = new Map(problem.days.map((d, i) => [d, i]))
    this.week = problem.days.length * SLOTS_PER_DAY
  }

  private arr(map: Map<string, Uint8Array>, key: string): Uint8Array {
    let a = map.get(key)
    if (!a) {
      a = new Uint8Array(this.week)
      map.set(key, a)
    }
    return a
  }

  private base(day: number): number {
    const i = this.dayIndex.get(day)
    return i === undefined ? -1 : i * SLOTS_PER_DAY
  }

  private free(map: Map<string, Uint8Array>, key: string | null, day: number, start: number, end: number): boolean {
    if (key == null) return true
    const b = this.base(day)
    if (b < 0) return true
    const a = map.get(key)
    if (!a) return true
    for (let t = start; t < end; t++) if (a[b + t]) return false
    return true
  }

  private mark(map: Map<string, Uint8Array>, key: string | null, day: number, start: number, end: number, v: 0 | 1): void {
    if (key == null) return
    const b = this.base(day)
    if (b < 0) return
    const a = this.arr(map, key)
    for (let t = start; t < end; t++) a[b + t] = v
  }

  roomFree(id: string, day: number, s: number, e: number) { return this.free(this.room, id, day, s, e) }
  instructorFree(id: string | null, day: number, s: number, e: number) { return this.free(this.inst, id, day, s, e) }
  cohortFree(key: string | null, day: number, s: number, e: number) { return this.free(this.coh, key, day, s, e) }

  take(roomId: string, instructorId: string | null, cohortKey: string | null, day: number, s: number, e: number) {
    this.mark(this.room, roomId, day, s, e, 1)
    this.mark(this.inst, instructorId, day, s, e, 1)
    this.mark(this.coh, cohortKey, day, s, e, 1)
  }

  release(roomId: string, instructorId: string | null, cohortKey: string | null, day: number, s: number, e: number) {
    this.mark(this.room, roomId, day, s, e, 0)
    this.mark(this.inst, instructorId, day, s, e, 0)
    this.mark(this.coh, cohortKey, day, s, e, 0)
  }

  blockInstructor(id: string, day: number, s: number, e: number) { this.mark(this.inst, id, day, s, e, 1) }
}

/** Occupancy with everything that is already fixed: other bookings and instructors' unavailable times. */
export function baseOccupancy(problem: Problem): Occupancy {
  const occ = new Occupancy(problem)
  for (const f of problem.fixed) occ.take(f.roomId, f.instructorId, f.cohortKey, f.day, f.start, f.end)
  for (const f of problem.closure) occ.take(f.roomId, null, null, f.day, f.start, f.end)
  for (const u of problem.unavailable) occ.blockInstructor(u.instructorId, u.day, u.start, u.end)
  return occ
}
