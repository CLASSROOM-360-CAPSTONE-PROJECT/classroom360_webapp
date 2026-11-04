import { Constraint, CpModel, LinearExpr } from 'cpsat-js/portable'
import type { BoolVar, IntVar, IntervalVar } from 'cpsat-js/portable'
import { mergeBlocks } from './problem.ts'
import { dayWeight, roomPenalty } from './score.ts'
import { SLOTS_PER_DAY } from './types.ts'
import type { Placement, Problem, SchedSection, Weights } from './types.ts'

/**
 * The timetable as a CP-SAT model.
 *
 * Every meeting gets: a "placed" flag, one flag per allowed weekday, a start slot within that day,
 * and one flag per suitable room. A room is booked through an optional interval that only exists
 * when its flag is on, so the solver's no-overlap constraint per room, per instructor and per
 * student block does the clash-avoidance (including against everything other departments already
 * hold, which enters as fixed intervals).
 *
 * 'strict' requires every meeting to be placed (the case that matters; fast to solve).
 * 'relaxed' lets the solver drop meetings, at a price high enough that it only does so when it must.
 */
export type Mode = 'strict' | 'relaxed'

/** Large enough that placing one more meeting always beats any combination of preferences. */
export const PLACED_REWARD = 100_000

export interface Meeting {
  sec: SchedSection
  index: number
  placed: BoolVar
  /** one flag per entry of problem.days */
  isDay: BoolVar[]
  /** allowed day positions for this section (indices into problem.days) */
  dayPositions: number[]
  local: IntVar
  start: IntVar
  rooms: Array<[string, BoolVar]>
}

export interface Built {
  model: CpModel
  meetings: Meeting[]
}

function optionalInterval(model: CpModel, start: IntVar, size: number, presence: BoolVar, name: string): IntervalVar {
  const iv = model.newIntervalVar(start, size, start.plus(size), name)
  // an interval constraint that is only enforced when `presence` is true is an optional interval
  new Constraint(model.toProto().constraints[iv.constraintIndex]!).onlyEnforceIf(presence)
  return iv
}

function push<T>(m: Map<string, T[]>, k: string, v: T): void {
  const list = m.get(k)
  if (list) list.push(v)
  else m.set(k, [v])
}

function weighted(terms: Array<[IntVar, number]>): LinearExpr {
  let e = LinearExpr.fromConstant(0)
  for (const [v, c] of terms) e = e.plus(v.times(c))
  return e
}

export function buildModel(problem: Problem, mode: Mode, weights: Weights, hint: Placement[] = []): Built {
  const model = new CpModel('timetable')
  const D = problem.days.length
  const dayPos = new Map(problem.days.map((d, i) => [d, i]))
  const meetings: Meeting[] = []

  const roomIv = new Map<string, IntervalVar[]>()
  const instIv = new Map<string, IntervalVar[]>()
  const cohIv = new Map<string, IntervalVar[]>()
  const instLoad = new Map<string, Array<[IntVar, number]>>()
  const roomUse = new Map<string, { sec: SchedSection; lits: BoolVar[] }>()
  const instDayFlags = new Map<string, BoolVar[]>()
  const cost: Array<[IntVar, number]> = []
  const special = new Set(problem.rooms.filter((r) => r.special).map((r) => r.id))

  for (const sec of problem.sections) {
    if (sec.roomIds.length === 0) continue
    const lockedPos = new Set(sec.lockedDays.map((d) => dayPos.get(d)).filter((x): x is number => x !== undefined))
    const dayPositions = [...Array(D).keys()].filter((i) => !lockedPos.has(i))
    const mine: Meeting[] = []

    for (let k = 0; k < sec.toPlace; k++) {
      const tag = `${sec.code}#${k}`
      const placed = model.newBoolVar(`p ${tag}`)
      if (mode === 'strict') model.add(placed.equals(1))

      const isDay = Array.from({ length: D }, (_, i) => model.newBoolVar(`d${i} ${tag}`))
      for (let i = 0; i < D; i++) if (!dayPositions.includes(i)) model.add(isDay[i]!.equals(0))
      // exactly one day when placed, none otherwise
      model.add(weighted(isDay.map((b) => [b, 1] as [IntVar, number])).minus(placed.toLinearExpr()).equals(0))

      const local = model.newIntVar(problem.open, problem.close - sec.slots, `t ${tag}`)
      const start = model.newIntVar(problem.open, (D - 1) * SLOTS_PER_DAY + problem.close - sec.slots, `s ${tag}`)
      // start = 48 * (day position) + local   (when placed; when not, flags are all 0 so start = local)
      model.add(
        weighted([[start, 1], [local, -1], ...isDay.map((b, i) => [b, -SLOTS_PER_DAY * i] as [IntVar, number])]).equals(0),
      )

      const m: Meeting = { sec, index: k, placed, isDay, dayPositions, local, start, rooms: [] }
      mine.push(m)
      meetings.push(m)

      const main = optionalInterval(model, start, sec.slots, placed, `iv ${tag}`)
      if (sec.instructorId) push(instIv, sec.instructorId, main)
      if (sec.cohortKey) push(cohIv, sec.cohortKey, main)

      const lits: BoolVar[] = []
      for (const roomId of sec.roomIds) {
        const pr = model.newBoolVar(`r ${tag} ${roomId}`)
        lits.push(pr)
        m.rooms.push([roomId, pr])
        // plain lectures prefer to stay out of laboratories and other special rooms
        if (weights.labRoom > 0 && roomPenalty(Boolean(sec.requiredFacility), special.has(roomId), weights) > 0) cost.push([pr, weights.labRoom])
        push(roomIv, roomId, optionalInterval(model, start, sec.slots, pr, `ivr ${tag} ${roomId}`))
        const key = `${sec.id}|${roomId}`
        if (!roomUse.has(key)) roomUse.set(key, { sec, lits: [] })
        roomUse.get(key)!.lits.push(pr)
      }
      model.add(weighted(lits.map((b) => [b, 1] as [IntVar, number])).minus(placed.toLinearExpr()).equals(0))

      if (sec.instructorId) {
        if (!instLoad.has(sec.instructorId)) instLoad.set(sec.instructorId, [])
        instLoad.get(sec.instructorId)!.push([placed, sec.slots])
        for (const i of dayPositions) push(instDayFlags, `${sec.instructorId}|${i}`, isDay[i]!)
      }

      // preferences
      cost.push([local, weights.early])
      if (problem.close - sec.slots > weights.lateFrom && weights.late > 0) {
        const late = model.newIntVar(0, problem.close - sec.slots - weights.lateFrom, `late ${tag}`)
        model.add(late.minus(local).ge(-weights.lateFrom))
        cost.push([late, weights.late])
      }
    }

    // meetings of one section: placed in order, on strictly increasing days (also breaks the symmetry between them)
    const dayValue = (m: Meeting) => weighted(m.isDay.map((b, i) => [b, i] as [IntVar, number]))
    for (let k = 1; k < mine.length; k++) {
      const prev = mine[k - 1]!
      const cur = mine[k]!
      if (mode === 'relaxed') model.add(cur.placed.le(prev.placed))
      model.add(dayValue(cur).minus(dayValue(prev)).ge(1)).onlyEnforceIf(cur.placed)
      if (weights.consecutiveDays > 0) {
        const g = model.newBoolVar(`adj ${sec.code}#${k}`)
        // g must be on when the two meetings are on neighbouring days
        model.add(dayValue(cur).minus(dayValue(prev)).plus(g.toLinearExpr()).ge(2)).onlyEnforceIf(cur.placed)
        cost.push([g, weights.consecutiveDays])
      }
    }
  }

  // no two things in the same room / for the same instructor / for the same student block at once,
  // counting what is already booked (other departments, kept meetings) and the instructor's unavailable times
  const fixedBlocks = (pick: (f: Problem['fixed'][number]) => string | null, extra: Array<{ key: string; day: number; start: number; end: number }> = []) => {
    const by = new Map<string, Array<[number, number]>>()
    // the hours the school is closed are blocks on every room (they have no instructor or student block)
    for (const f of problem.fixed.concat(problem.closure)) {
      const key = pick(f)
      if (key) push(by, key, [dayPos.get(f.day)! * SLOTS_PER_DAY + f.start, dayPos.get(f.day)! * SLOTS_PER_DAY + f.end] as [number, number])
    }
    for (const x of extra) push(by, x.key, [dayPos.get(x.day)! * SLOTS_PER_DAY + x.start, dayPos.get(x.day)! * SLOTS_PER_DAY + x.end] as [number, number])
    return by
  }
  const noOverlap = (ivs: Map<string, IntervalVar[]>, fixed: Map<string, Array<[number, number]>>, label: string) => {
    for (const [key, list] of ivs) {
      const blocks = mergeBlocks(fixed.get(key) ?? []).map(([a, b], j) => model.newIntervalVar(a, b - a, b, `${label} fixed ${key} ${j}`))
      model.addNoOverlap([...list, ...blocks])
    }
  }
  noOverlap(roomIv, fixedBlocks((f) => f.roomId), 'room')
  noOverlap(instIv, fixedBlocks((f) => f.instructorId, problem.unavailable.map((u) => ({ key: u.instructorId, day: u.day, start: u.start, end: u.end }))), 'instructor')
  noOverlap(cohIv, fixedBlocks((f) => f.cohortKey), 'cohort')

  // weekly teaching limit
  for (const [id, list] of instLoad) {
    const cap = problem.instructors[id]?.capSlots
    if (cap === undefined) continue
    model.add(weighted(list).le(cap))
  }

  // preference: a section stays in one room
  if (weights.sameRoom > 0) {
    for (const { sec, lits } of roomUse.values()) {
      if (sec.toPlace < 2) continue
      const y = model.newBoolVar(`uses ${sec.code}`)
      for (const l of lits) model.add(y.minus(l).ge(0))
      cost.push([y, weights.sameRoom])
    }
  }

  // preference: an instructor teaches on few days
  if (weights.instructorDay > 0) {
    for (const [key, flags] of instDayFlags) {
      if (flags.length < 2) continue
      const u = model.newBoolVar(`teaches ${key}`)
      for (const f of flags) model.add(u.minus(f).ge(0))
      cost.push([u, dayWeight(problem, key.split('|')[0]!, weights)])
    }
  }

  let objective = weighted(cost)
  if (mode === 'relaxed') for (const m of meetings) objective = objective.plus(m.placed.times(-PLACED_REWARD))
  model.minimize(objective)

  // hint: start the search from a plan we already have
  if (hint.length > 0) {
    // the model puts a section's meetings in day order (to break symmetry), so number the hint the same way
    const bySection = new Map<string, Placement[]>()
    for (const p of hint) push(bySection, p.sectionId, p)
    const byKey = new Map<string, Placement>()
    for (const [id, list] of bySection) {
      list.slice().sort((a, b) => a.day - b.day).forEach((p, k) => byKey.set(`${id}#${k}`, p))
    }
    for (const m of meetings) {
      const h = byKey.get(`${m.sec.id}#${m.index}`)
      model.addHint(m.placed, h ? 1 : 0)
      if (!h) continue
      const pos = dayPos.get(h.day)!
      m.isDay.forEach((b, i) => model.addHint(b, i === pos ? 1 : 0))
      model.addHint(m.local, h.start)
      model.addHint(m.start, pos * SLOTS_PER_DAY + h.start)
      for (const [roomId, pr] of m.rooms) model.addHint(pr, roomId === h.roomId ? 1 : 0)
    }
  }

  return { model, meetings }
}

/** Reads a solution back into placements. `value` is the solver's accessor for a variable. */
export function decode(problem: Problem, meetings: Meeting[], value: (v: IntVar) => number): Placement[] {
  const out: Placement[] = []
  for (const m of meetings) {
    if (value(m.placed) !== 1) continue
    const pos = m.isDay.findIndex((b) => value(b) === 1)
    const room = m.rooms.find(([, pr]) => value(pr) === 1)
    if (pos < 0 || !room) continue
    const start = value(m.local)
    out.push({ sectionId: m.sec.id, index: m.index, roomId: room[0], day: problem.days[pos]!, start, end: start + m.sec.slots })
  }
  return out
}
