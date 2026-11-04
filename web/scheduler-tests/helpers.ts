import { buildProblem } from '../src/lib/scheduler/problem.ts'
import type { BuildInput, RawBusy, RawInstructor, RawOwnEntry, RawRoom, RawSection, RawUnavailability } from '../src/lib/scheduler/problem.ts'

export const room = (id: string, o: Partial<RawRoom> = {}): RawRoom => ({ id, code: id, capacity: 40, facilities: [], is_active: true, ...o })
export const inst = (id: string, o: Partial<RawInstructor> = {}): RawInstructor => ({ id, full_name: `Prof ${id}`, max_weekly_hours: 24, ...o })
export const sec = (id: string, o: Partial<RawSection> = {}): RawSection => ({
  id, code: id, year_level: 1, cohort: 'A', program_id: 'P1', enrollment: 30, instructor_id: null,
  meetings_per_week: 2, minutes_per_meeting: 90, course: { code: `C-${id}`, required_facility: null }, ...o,
})
export const busy = (o: Partial<RawBusy> & { room_id: string; day_of_week: number; start_time: string; end_time: string }): RawBusy => ({
  entry_id: `b${Math.random().toString(36).slice(2)}`, instructor_id: null, cohort_key: null, ...o,
})
export const unavail = (instructor_id: string, day_of_week: number, start_time: string, end_time: string): RawUnavailability =>
  ({ instructor_id, day_of_week, start_time, end_time })
export const own = (id: string, section_id: string, status: string, day_of_week: number): RawOwnEntry => ({ id, section_id, status, day_of_week })

export function problemOf(o: Partial<BuildInput>) {
  return buildProblem({ sections: [], rooms: [], instructors: [], unavailability: [], busy: [], ownEntries: [], ...o })
}

/** small deterministic random generator */
export function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const hhmm = (slot: number) => `${String(Math.floor(slot / 2)).padStart(2, '0')}:${slot % 2 ? '30' : '00'}:00`

/** A program of `n` sections plus other departments' bookings, resembling the real thing. */
export function randomCase(seed: number, o: { rooms: number; sections: number; otherSections: number; meetings?: number[]; roomsFitEveryone?: boolean }): BuildInput {
  const r = rng(seed)
  const pick = <T,>(a: T[]) => a[Math.floor(r() * a.length)]!
  const rooms = Array.from({ length: o.rooms }, (_, i) => room(`R${i}`, { capacity: o.roomsFitEveryone ? pick([40, 45]) : pick([30, 40, 45]), facilities: i % 5 === 4 ? ['computer_lab'] : [] }))
  const nInst = Math.max(3, Math.ceil(o.sections / 2.5))
  const instructors = Array.from({ length: nInst }, (_, i) => inst(`I${i}`))
  const nCoh = Math.max(2, Math.ceil(o.sections / 4))
  const sections = Array.from({ length: o.sections }, (_, i) => {
    const mt = pick(o.meetings ?? [2])
    return sec(`S${i}`, {
      instructor_id: `I${i % nInst}`, cohort: `C${i % nCoh}`, enrollment: pick([25, 30, 35]),
      meetings_per_week: mt, minutes_per_meeting: mt === 1 ? 180 : pick([90, 90, 90, 180]),
    })
  })
  // other departments: a conflict-free set of fixed bookings
  const used = new Set<string>()
  const free = (k: string, d: number, a: number, b: number) => { for (let t = a; t < b; t++) if (used.has(`${k}|${d}|${t}`)) return false; return true }
  const take = (k: string, d: number, a: number, b: number) => { for (let t = a; t < b; t++) used.add(`${k}|${d}|${t}`) }
  const busyRows: RawBusy[] = []
  for (let i = 0; i < o.otherSections; i++) {
    const ins = `X${i % Math.max(3, Math.ceil(o.otherSections / 2.5))}`
    const coh = `XC${i % Math.max(2, Math.ceil(o.otherSections / 4))}`
    const dur = pick([3, 3, 3, 6])
    const d0 = Math.floor(r() * 3)
    const rm = pick(rooms).id
    const st = 14 + Math.floor(r() * (28 - dur))
    for (const d of [d0, d0 + 3]) {
      if (free(`R${rm}`, d, st, st + dur) && free(`I${ins}`, d, st, st + dur) && free(`C${coh}`, d, st, st + dur)) {
        take(`R${rm}`, d, st, st + dur); take(`I${ins}`, d, st, st + dur); take(`C${coh}`, d, st, st + dur)
        busyRows.push(busy({ room_id: rm, instructor_id: ins, cohort_key: coh, day_of_week: d + 1, start_time: hhmm(st), end_time: hhmm(st + dur) }))
      }
    }
  }
  const unavailability = instructors.map((i) => unavail(i.id, 1 + Math.floor(r() * 6), hhmm(14 + Math.floor(r() * 20)), hhmm(14 + Math.floor(r() * 20) + 4)))
    .filter((u) => u.start_time < u.end_time)
  return { sections, rooms, instructors, unavailability, busy: busyRows, ownEntries: [] }
}
