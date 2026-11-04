import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildProblem, isReplaceable, slotTime } from '../src/lib/scheduler/problem.ts'
import { firstFit } from '../src/lib/scheduler/firstFit.ts'
import { solveTimetable } from '../src/lib/scheduler/solve.ts'
import { verify } from '../src/lib/scheduler/verify.ts'
import { explainUnplaced } from '../src/lib/scheduler/explain.ts'
import { improve } from '../src/lib/scheduler/improve.ts'
import { buildModel, decode } from '../src/lib/scheduler/model.ts'
import { fullWeights, softPenalty } from '../src/lib/scheduler/score.ts'
import { CpSolver, CpSolverStatus } from 'cpsat-js/portable'
import type { Placement } from '../src/lib/scheduler/types.ts'
import { busy, inst, own, problemOf, randomCase, room, sec, unavail } from './helpers.ts'

const solve = (p: ReturnType<typeof problemOf>, sec = 4) => solveTimetable(p, { timeLimitSec: sec })

describe('buildProblem', () => {
  it('rounds minutes up to 30-minute slots and maps ISO days to 0-based', () => {
    const p = problemOf({ rooms: [room('R1')], sections: [sec('S1', { minutes_per_meeting: 75 })], busy: [busy({ room_id: 'R1', day_of_week: 3, start_time: '09:10:00', end_time: '10:20:00' })] })
    assert.equal(p.sections[0]!.slots, 3)
    assert.deepEqual(p.fixed[0], { roomId: 'R1', instructorId: null, cohortKey: null, day: 2, start: 18, end: 21 }) // 09:00 to 10:30
    assert.equal(slotTime(21), '10:30')
  })

  it('does not let the program’s own draft/returned meetings block anything, but keeps submitted ones', () => {
    const p = problemOf({
      rooms: [room('R1')], sections: [sec('S1', { meetings_per_week: 3 })],
      busy: [
        busy({ entry_id: 'd1', room_id: 'R1', day_of_week: 1, start_time: '08:00:00', end_time: '09:30:00' }),
        busy({ entry_id: 's1', room_id: 'R1', day_of_week: 2, start_time: '08:00:00', end_time: '09:30:00' }),
      ],
      ownEntries: [own('d1', 'S1', 'draft', 1), own('s1', 'S1', 'submitted', 2), own('r1', 'S1', 'returned', 4)],
    })
    assert.equal(p.fixed.length, 1) // only the submitted one blocks
    assert.equal(p.fixed[0]!.day, 1)
    assert.equal(p.sections[0]!.toPlace, 2) // 3 weekly minus 1 kept
    assert.deepEqual(p.sections[0]!.lockedDays, [1]) // Tuesday is taken by the kept meeting
  })

  it('leaves out sections with nothing left to place', () => {
    const p = problemOf({ rooms: [room('R1')], sections: [sec('S1', { meetings_per_week: 1 })], ownEntries: [own('x', 'S1', 'published', 1)] })
    assert.equal(p.sections.length, 0)
  })

  it('builds the same cohort key as the database trigger', () => {
    const p = problemOf({ rooms: [room('R1')], sections: [sec('S1', { program_id: 'PRG', year_level: 3, cohort: '3A' }), sec('S2', { cohort: null })] })
    assert.equal(p.sections[0]!.cohortKey, 'PRG:3:3A')
    assert.equal(p.sections[1]!.cohortKey, null)
  })

  it('filters rooms by capacity, facility and being in use', () => {
    const p = problemOf({
      rooms: [room('small', { capacity: 20 }), room('lab', { capacity: 30, facilities: ['computer_lab'] }), room('big', { capacity: 50 }), room('off', { capacity: 99, is_active: false })],
      sections: [sec('S1', { enrollment: 28, course: { code: 'X', required_facility: null } }), sec('S2', { enrollment: 28, course: { code: 'Y', required_facility: 'computer_lab' } })],
    })
    assert.deepEqual(p.sections[0]!.roomIds.sort(), ['big', 'lab'])
    assert.deepEqual(p.sections[1]!.roomIds, ['lab'])
  })

  it('reduces an instructor’s weekly limit by what they already teach elsewhere', () => {
    const p = problemOf({
      rooms: [room('R1')], instructors: [inst('I1', { max_weekly_hours: 10 })], sections: [sec('S1', { instructor_id: 'I1' })],
      busy: [busy({ room_id: 'R1', instructor_id: 'I1', day_of_week: 1, start_time: '08:00:00', end_time: '12:00:00' })], // 4 h
    })
    assert.equal(p.instructors['I1']!.capSlots, 20 - 8)
  })

  it('keeps a pinned draft where it is and replaces an unpinned one', () => {
    const p = problemOf({
      rooms: [room('R1')], sections: [sec('S1', { meetings_per_week: 3 })],
      busy: [
        busy({ entry_id: 'pin', room_id: 'R1', day_of_week: 2, start_time: '08:00:00', end_time: '09:30:00' }),
        busy({ entry_id: 'free', room_id: 'R1', day_of_week: 4, start_time: '08:00:00', end_time: '09:30:00' }),
      ],
      ownEntries: [{ ...own('pin', 'S1', 'draft', 2), is_pinned: true }, own('free', 'S1', 'draft', 4)],
    })
    assert.equal(p.fixed.length, 1) // the pinned meeting blocks its room
    assert.equal(p.fixed[0]!.day, 1)
    assert.equal(p.sections[0]!.toPlace, 2) // 3 weekly minus the pinned one
    assert.deepEqual(p.sections[0]!.lockedDays, [1]) // no second meeting on Tuesday
  })

  it('treats a pinned returned meeting like a kept one too', () => {
    assert.equal(isReplaceable({ status: 'returned', is_pinned: true }), false)
    assert.equal(isReplaceable({ status: 'returned', is_pinned: false }), true)
    assert.equal(isReplaceable({ status: 'draft' }), true)
    assert.equal(isReplaceable({ status: 'submitted', is_pinned: false }), false)
  })

  it('counts a pinned meeting against the instructor’s weekly limit', () => {
    const p = problemOf({
      rooms: [room('R1')], instructors: [inst('I1', { max_weekly_hours: 10 })], sections: [sec('S1', { instructor_id: 'I1' })],
      busy: [busy({ entry_id: 'pin', room_id: 'R1', instructor_id: 'I1', day_of_week: 1, start_time: '08:00:00', end_time: '12:00:00' })],
      ownEntries: [{ ...own('pin', 'S1', 'draft', 1), is_pinned: true }],
    })
    assert.equal(p.instructors['I1']!.capSlots, 20 - 8)
  })

  it('ignores days that are not scheduled (Sunday by default)', () => {
    const p = problemOf({ rooms: [room('R1')], busy: [busy({ room_id: 'R1', day_of_week: 7, start_time: '08:00:00', end_time: '09:00:00' })], unavailability: [unavail('I1', 7, '08:00:00', '09:00:00')] })
    assert.equal(p.fixed.length, 0)
    assert.equal(p.unavailable.length, 0)
    assert.deepEqual(p.days, [0, 1, 2, 3, 4, 5])
  })
})

describe('verify (independent rule check)', () => {
  const base = () => problemOf({
    rooms: [room('R1'), room('R2', { capacity: 20 }), room('LAB', { facilities: ['computer_lab'] })],
    instructors: [inst('I1', { max_weekly_hours: 2 })],
    sections: [
      sec('S1', { instructor_id: 'I1', cohort: 'A', enrollment: 30 }),
      sec('S2', { instructor_id: 'I1', cohort: 'A', enrollment: 30 }),
      sec('S3', { instructor_id: null, cohort: 'B', enrollment: 30, course: { code: 'L', required_facility: 'computer_lab' } }),
    ],
    unavailability: [unavail('I1', 5, '07:00:00', '12:00:00')],
    busy: [busy({ room_id: 'R1', day_of_week: 1, start_time: '10:00:00', end_time: '12:00:00', cohort_key: 'P1:1:A', instructor_id: null })],
  })
  const P = (o: Partial<Placement>): Placement => ({ sectionId: 'S1', index: 0, roomId: 'R1', day: 1, start: 14, end: 17, ...o })

  it('accepts a clean placement', () => assert.deepEqual(verify(base(), [P({})]), []))
  it('catches a room taken by another booking', () => assert.match(verify(base(), [P({ day: 0, start: 20, end: 23 })]).join('|'), /room already taken/))
  it('catches the student block already having a class', () => assert.match(verify(base(), [P({ roomId: 'R2', day: 0, start: 20, end: 23 })]).join('|'), /student block already has a class/))
  it('catches an instructor’s unavailable time', () => assert.match(verify(base(), [P({ day: 4, start: 16, end: 19 })]).join('|'), /instructor busy or unavailable/))
  it('catches a room that is too small', () => assert.match(verify(base(), [P({ roomId: 'R2' })]).join('|'), /seats 20/))
  it('catches a missing facility', () => assert.match(verify(base(), [P({ sectionId: 'S3', roomId: 'R1' })]).join('|'), /lacks computer_lab/))
  it('catches classes outside operating hours', () => assert.match(verify(base(), [P({ start: 10, end: 13 })]).join('|'), /outside school hours/))
  it('catches two meetings of one section on the same day', () => {
    assert.match(verify(base(), [P({}), P({ index: 1, roomId: 'LAB', start: 30, end: 33 })]).join('|'), /already meets on that day/)
  })
  it('catches double booking inside the new schedule (room, instructor, student block)', () => {
    const v = verify(base(), [P({ day: 2 }), P({ sectionId: 'S2', roomId: 'R1', day: 2 })]).join('|')
    assert.match(v, /room double-booked/)
    assert.match(v, /instructor double-booked/)
    assert.match(v, /student block double-booked/)
  })
  it('catches an instructor over the weekly limit', () => {
    const v = verify(base(), [P({ day: 1 }), P({ sectionId: 'S2', roomId: 'LAB', day: 2, start: 30, end: 33 })]).join('|')
    assert.match(v, /over the weekly teaching limit/)
  })
  it('catches a duplicate meeting and one beyond what the section needs', () => {
    const v = verify(base(), [P({}), P({ day: 2 }), P({ index: 2, day: 3 })]).join('|')
    assert.match(v, /3 meetings placed but only 2 needed/)
  })
})

describe('first-fit planner', () => {
  it('places an easy case completely, without breaking any rule', () => {
    const p = problemOf(randomCase(1, { rooms: 4, sections: 8, otherSections: 0 }))
    const plan = firstFit(p)
    assert.equal(plan.length, 16)
    assert.deepEqual(verify(p, plan), [])
  })
})

describe('solveTimetable', () => {
  it('schedules a demo-sized program completely and cleanly', async () => {
    const p = problemOf(randomCase(2, { rooms: 4, sections: 8, otherSections: 0 }))
    const r = await solve(p)
    assert.equal(r.complete, true)
    assert.deepEqual(r.violations, [])
    assert.equal(r.placements.length, 16)
  })

  it('never uses a slot another department already holds', async () => {
    const input = randomCase(3, { rooms: 4, sections: 10, otherSections: 40 })
    const p = problemOf(input)
    const r = await solve(p)
    assert.deepEqual(r.violations, [])
    for (const pl of r.placements) {
      for (const b of input.busy) {
        if (b.room_id !== pl.roomId || b.day_of_week - 1 !== pl.day) continue
        const bs = Number(b.start_time.slice(0, 2)) * 2 + (b.start_time.slice(3, 5) === '30' ? 1 : 0)
        const be = Number(b.end_time.slice(0, 2)) * 2 + (b.end_time.slice(3, 5) === '30' ? 1 : 0)
        assert.ok(pl.end <= bs || pl.start >= be, `room ${pl.roomId} day ${pl.day} overlaps another department`)
      }
    }
  })

  it('does as well as or better than the quick plan on the preferences', async () => {
    const p = problemOf(randomCase(4, { rooms: 6, sections: 16, otherSections: 20 }))
    const quick = firstFit(p)
    const r = await solve(p, 6)
    assert.equal(r.complete, true)
    const { softPenalty } = await import('../src/lib/scheduler/score.ts')
    assert.ok(r.softPenalty <= softPenalty(p, quick), `${r.softPenalty} > ${softPenalty(p, quick)}`)
  })

  it('leaves out only what truly cannot fit, and says why', async () => {
    // one room, Monday only, 07:00-09:00 (4 slots): three 1-hour (2-slot) single-meeting sections, only two fit
    const p = buildProblemWith({ weekdays: [1], openMinutes: 420, closeMinutes: 540 })
    const r = await solve(p, 4)
    assert.equal(r.placements.length, 2)
    assert.equal(r.unplaced.length, 1)
    assert.equal(r.complete, false)
    assert.deepEqual(r.violations, [])
    assert.match(r.unplaced[0]!.reason, /no common free time|Every suitable room is taken|start/i)
  })

  it('keeps new meetings off the days a kept meeting already uses', async () => {
    const p = problemOf({
      rooms: [room('R1')], sections: [sec('S1', { meetings_per_week: 3 })],
      ownEntries: [own('k', 'S1', 'approved', 1), own('d', 'S1', 'draft', 3)],
      busy: [busy({ entry_id: 'k', room_id: 'R1', day_of_week: 1, start_time: '08:00:00', end_time: '09:30:00' })],
    })
    assert.equal(p.sections[0]!.toPlace, 2)
    const r = await solve(p)
    assert.equal(r.complete, true)
    assert.ok(r.placements.every((x) => x.day !== 0))
    assert.deepEqual(r.violations, [])
  })

  it('plans several programs together without clashes when they share rooms and an instructor', async () => {
    // two programs, one shared teacher and only two rooms: planned in one problem the result must still be clean
    const sections = [
      sec('A1', { program_id: 'P1', cohort: 'A', instructor_id: 'I1' }),
      sec('A2', { program_id: 'P1', cohort: 'A', instructor_id: 'I2' }),
      sec('B1', { program_id: 'P2', cohort: 'A', instructor_id: 'I1' }),
      sec('B2', { program_id: 'P2', cohort: 'A', instructor_id: 'I3' }),
    ]
    const p = problemOf({ rooms: [room('R1'), room('R2')], instructors: [inst('I1'), inst('I2'), inst('I3')], sections })
    assert.equal(new Set(p.sections.map((x) => x.cohortKey)).size, 2) // two programs, two student blocks
    const r = await solve(p)
    assert.equal(r.complete, true)
    assert.deepEqual(r.violations, [])
    assert.equal(r.placements.length, 8)
    // the shared teacher is never in two places at once
    const mine = r.placements.filter((x) => p.sections.find((s) => s.id === x.sectionId)?.instructorId === 'I1')
    for (const a of mine) for (const b of mine) {
      if (a === b || a.day !== b.day) continue
      assert.ok(a.end <= b.start || b.end <= a.start, 'instructor I1 double booked')
    }
  })

  it('still works around a pinned meeting when solving', async () => {
    const p = problemOf({
      rooms: [room('R1')], sections: [sec('S1', { meetings_per_week: 3 })],
      busy: [busy({ entry_id: 'pin', room_id: 'R1', day_of_week: 2, start_time: '07:00:00', end_time: '08:30:00' })],
      ownEntries: [{ ...own('pin', 'S1', 'draft', 2), is_pinned: true }],
    })
    const r = await solve(p)
    assert.equal(r.complete, true)
    assert.equal(r.placements.length, 2)
    assert.ok(r.placements.every((x) => x.day !== 1), 'a second meeting landed on the pinned day')
    assert.deepEqual(r.violations, [])
  })

  it('reports a section no room can hold', async () => {
    const p = problemOf({ rooms: [room('R1', { capacity: 30 })], sections: [sec('S1', { enrollment: 80 }), sec('S2', { enrollment: 20, cohort: 'B' })] })
    const r = await solve(p)
    assert.equal(r.placements.filter((x) => x.sectionId === 'S2').length, 2)
    assert.equal(r.unplaced.filter((x) => x.sectionId === 'S1').length, 2)
    assert.match(r.unplaced[0]!.reason, /No room seats 80/)
  })

  it('reports a facility no room offers', async () => {
    const p = problemOf({ rooms: [room('R1')], sections: [sec('S1', { course: { code: 'L', required_facility: 'electronics_lab' } })] })
    const r = await solve(p)
    assert.equal(r.placements.length, 0)
    assert.match(r.unplaced[0]!.reason, /electronics_lab/)
  })

  it('respects an instructor’s weekly limit', async () => {
    const p = problemOf({
      rooms: [room('R1'), room('R2')], instructors: [inst('I1', { max_weekly_hours: 3 })],
      sections: [sec('S1', { instructor_id: 'I1', cohort: 'A' }), sec('S2', { instructor_id: 'I1', cohort: 'B' })], // 4 x 1.5 h = 6 h
    })
    const r = await solve(p)
    assert.equal(r.placements.length, 2)
    assert.equal(r.unplaced.length, 2)
    assert.match(r.unplaced[0]!.reason, /weekly teaching limit/)
    assert.deepEqual(r.violations, [])
  })

  it('works around an instructor who is unavailable most of the week', async () => {
    const un = [1, 2, 3, 4, 5].map((d) => unavail('I1', d, '07:00:00', '21:00:00')) // only Saturday is free
    const p = problemOf({ rooms: [room('R1')], instructors: [inst('I1')], sections: [sec('S1', { instructor_id: 'I1', meetings_per_week: 1 })], unavailability: un })
    const r = await solve(p)
    assert.equal(r.placements.length, 1)
    assert.equal(r.placements[0]!.day, 5)
  })

  it('gives each of a student block’s sections its own time', async () => {
    const p = problemOf({ rooms: [room('R1'), room('R2')], sections: [sec('A', { cohort: 'X' }), sec('B', { cohort: 'X' }), sec('C', { cohort: 'X' })] })
    const r = await solve(p)
    assert.equal(r.complete, true)
    assert.deepEqual(r.violations, [])
  })

  it('handles a program-sized problem (40 sections, 15 rooms, ~200 other bookings) within the time limit', async () => {
    const p = problemOf(randomCase(7, { rooms: 15, sections: 40, otherSections: 200 }))
    const t = Date.now()
    const r = await solve(p, 15)
    assert.ok(Date.now() - t < 25_000, 'took too long')
    assert.equal(r.complete, true)
    assert.deepEqual(r.violations, [])
  })

  it('stays clean across many random cases', async () => {
    for (let seed = 100; seed < 110; seed++) {
      const p = problemOf(randomCase(seed, { rooms: 6, sections: 14, otherSections: 30, meetings: [1, 2, 2, 3] }))
      const r = await solve(p, 2)
      assert.deepEqual(r.violations, [], `seed ${seed}`)
      assert.equal(r.placements.length + r.unplaced.length, p.sections.reduce((n, s) => n + s.toPlace, 0), `seed ${seed}`)
    }
  })

  it('reports progress and improving answers', async () => {
    const p = problemOf(randomCase(9, { rooms: 4, sections: 8, otherSections: 6 }))
    const phases = new Set<string>()
    let incumbents = 0
    await solveTimetable(p, { timeLimitSec: 3 }, { onProgress: (x) => phases.add(x.phase), onIncumbent: () => incumbents++ })
    assert.ok(phases.has('baseline') && phases.has('optimizing') && phases.has('checking'))
    assert.ok(incumbents >= 2)
  })
})

describe('the CP-SAT model on its own (no starting hint)', () => {
  it('finds a complete, valid timetable that respects other departments’ bookings', async () => {
    const p = problemOf(randomCase(11, { rooms: 4, sections: 14, otherSections: 30 }))
    const solver = await CpSolver.create()
    const { model, meetings } = buildModel(p, 'strict', fullWeights({}))
    const res = solver.solve(model, { maxTimeInSeconds: 8, numWorkers: 1 })
    assert.ok(res.status === CpSolverStatus.FEASIBLE || res.status === CpSolverStatus.OPTIMAL, `status ${res.status}`)
    const plan = decode(p, meetings, (v) => res.value(v))
    assert.equal(plan.length, p.sections.reduce((n, x) => n + x.toPlace, 0))
    assert.deepEqual(verify(p, plan), [])
  })

  it('proves a case impossible (strict) and, relaxed, places what fits', async () => {
    const p = buildProblemWith({ weekdays: [1], openMinutes: 420, closeMinutes: 540 })
    const solver = await CpSolver.create()
    const strict = buildModel(p, 'strict', fullWeights({}))
    assert.equal(solver.solve(strict.model, { maxTimeInSeconds: 4, numWorkers: 1 }).status, CpSolverStatus.INFEASIBLE)
    const relaxed = buildModel(p, 'relaxed', fullWeights({}))
    const res = solver.solve(relaxed.model, { maxTimeInSeconds: 4, numWorkers: 1 })
    const plan = decode(p, relaxed.meetings, (v) => res.value(v))
    assert.equal(plan.length, 2)
    assert.deepEqual(verify(p, plan), [])
  })

  it('accepts the first-fit plan as a hint even when the plan numbers a section’s meetings out of day order', async () => {
    const p = problemOf(randomCase(12, { rooms: 4, sections: 10, otherSections: 10 }))
    const quick = firstFit(p).map((x) => ({ ...x }))
    // reverse the numbering of every section's meetings
    const by = new Map<string, number>()
    for (const x of quick) by.set(x.sectionId, (by.get(x.sectionId) ?? 0) + 1)
    const seen = new Map<string, number>()
    for (const x of quick) { const k = seen.get(x.sectionId) ?? 0; seen.set(x.sectionId, k + 1); x.index = by.get(x.sectionId)! - 1 - k }
    const solver = await CpSolver.create()
    const { model, meetings } = buildModel(p, 'strict', fullWeights({}), quick)
    const res = solver.solve(model, { maxTimeInSeconds: 4, numWorkers: 1 })
    assert.ok(res.status === CpSolverStatus.FEASIBLE || res.status === CpSolverStatus.OPTIMAL)
    assert.equal(decode(p, meetings, (v) => res.value(v)).length, quick.length)
  })
})

describe('local search', () => {
  it('lowers the preference penalty and never breaks a hard rule', () => {
    const w = fullWeights({})
    let gain = 0
    for (const seed of [22, 23, 24]) {
      const p = problemOf(randomCase(seed, { rooms: 6, sections: 20, otherSections: 40 }))
      const quick = firstFit(p, w)
      const better = improve(p, quick, w, 1500)
      assert.ok(softPenalty(p, better, w) <= softPenalty(p, quick, w))
      gain += softPenalty(p, quick, w) - softPenalty(p, better, w)
      assert.equal(better.length, quick.length)
      assert.deepEqual(verify(p, better), [])
    }
    assert.ok(gain > 0)
  })
  it('hands back the plan unchanged when there is nothing to do', () => {
    const p = problemOf({ rooms: [room('R1')] })
    assert.deepEqual(improve(p, [], undefined, 100), [])
  })
})

describe('explainUnplaced', () => {
  it('says when the optimiser merely ran out of time', () => {
    const p = problemOf({ rooms: [room('R1')], sections: [sec('S1', { meetings_per_week: 1 })] })
    const u = explainUnplaced(p, [])
    assert.match(u[0]!.reason, /longer time limit/)
  })
})

function buildProblemWith(o: { weekdays: number[]; openMinutes: number; closeMinutes: number }) {
  return buildProblem({
    rooms: [room('R1')], instructors: [], unavailability: [], busy: [], ownEntries: [],
    sections: [
      sec('S1', { meetings_per_week: 1, minutes_per_meeting: 60, cohort: 'A' }),
      sec('S2', { meetings_per_week: 1, minutes_per_meeting: 60, cohort: 'B' }),
      sec('S3', { meetings_per_week: 1, minutes_per_meeting: 60, cohort: 'C' }),
    ],
    ...o,
  })
}
