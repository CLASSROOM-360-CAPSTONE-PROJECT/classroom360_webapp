import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { facilityFor } from '../src/lib/scheduler/problem.ts'
import { firstFit } from '../src/lib/scheduler/firstFit.ts'
import { improve } from '../src/lib/scheduler/improve.ts'
import { solveTimetable } from '../src/lib/scheduler/solve.ts'
import { verify } from '../src/lib/scheduler/verify.ts'
import { dayWeight, fullWeights, roomPenalty, softPenalty } from '../src/lib/scheduler/score.ts'
import { PART_TIME_DAY_FACTOR } from '../src/lib/scheduler/types.ts'
import type { Placement } from '../src/lib/scheduler/types.ts'
import type { RawSchoolHours, RawWorkHours } from '../src/lib/scheduler/problem.ts'
import { inst, problemOf, randomCase, room, sec } from './helpers.ts'

const solve = (p: ReturnType<typeof problemOf>, s = 4) => solveTimetable(p, { timeLimitSec: s })
const hours = (day: number, opens: string, closes: string): RawSchoolHours => ({ day_of_week: day, opens_at: opens, closes_at: closes })
const work = (instructor_id: string, day: number, a: string, b: string): RawWorkHours => ({ instructor_id, day_of_week: day, start_time: a, end_time: b })
const slot = (hhmm: string) => Number(hhmm.slice(0, 2)) * 2 + (hhmm.slice(3, 5) === '30' ? 1 : 0)

describe('school operating hours', () => {
  const schoolHours = [
    hours(1, '08:00', '17:00'),
    hours(2, '08:00', '17:00'),
    hours(3, '10:00', '15:00'), // opens late, closes early
    hours(5, '08:00', '12:00'),
    hours(6, '08:00', '12:00'),
    // Thursday and Sunday: no row, so closed
  ]

  it('opens only the days that have hours, each with its own opening and closing slot', () => {
    const p = problemOf({ schoolHours, rooms: [room('R1')] })
    assert.deepEqual(p.days, [0, 1, 2, 4, 5])
    assert.deepEqual(p.dayHours[2], { open: slot('10:00'), close: slot('15:00') })
    assert.deepEqual(p.dayHours[5], { open: slot('08:00'), close: slot('12:00') })
    assert.equal(p.open, slot('08:00'))
    assert.equal(p.close, slot('17:00'))
  })

  it('closes every room outside a day’s hours without touching the count of other departments’ bookings', () => {
    const p = problemOf({ schoolHours, rooms: [room('R1'), room('R2')] })
    assert.equal(p.fixed.length, 0)
    const wed = p.closure.filter((c) => c.roomId === 'R1' && c.day === 2)
    assert.deepEqual(wed.map((c) => [c.start, c.end]).sort((a, b) => a[0]! - b[0]!), [
      [slot('08:00'), slot('10:00')],
      [slot('15:00'), slot('17:00')],
    ])
    assert.equal(p.closure.filter((c) => c.roomId === 'R2' && c.day === 5).length, 1) // Saturday: only the afternoon
  })

  it('never places a class outside the hours of its day, and never on a closed day', async () => {
    const p = problemOf({
      schoolHours,
      rooms: [room('R1'), room('R2')],
      instructors: [inst('I1'), inst('I2')],
      sections: [
        sec('S1', { instructor_id: 'I1', cohort: 'A', meetings_per_week: 3, minutes_per_meeting: 120 }),
        sec('S2', { instructor_id: 'I2', cohort: 'B', meetings_per_week: 3, minutes_per_meeting: 120 }),
        sec('S3', { instructor_id: 'I1', cohort: 'B', meetings_per_week: 2, minutes_per_meeting: 180 }),
      ],
    })
    const r = await solve(p)
    assert.equal(r.complete, true)
    assert.deepEqual(r.violations, [])
    for (const pl of r.placements) {
      assert.ok(p.days.includes(pl.day), `day ${pl.day} is closed`)
      const h = p.dayHours[pl.day]!
      assert.ok(pl.start >= h.open && pl.end <= h.close, `day ${pl.day} ${pl.start}-${pl.end} outside ${h.open}-${h.close}`)
    }
  })

  it('first-fit and local search respect the hours too', () => {
    const p = problemOf({
      schoolHours,
      rooms: [room('R1')],
      instructors: [inst('I1')],
      sections: [sec('S1', { instructor_id: 'I1', meetings_per_week: 3, minutes_per_meeting: 120 }), sec('S2', { instructor_id: 'I1', cohort: 'B', meetings_per_week: 2, minutes_per_meeting: 90 })],
    })
    const quick = firstFit(p)
    assert.deepEqual(verify(p, quick), [])
    const better = improve(p, quick, undefined, 600)
    assert.deepEqual(verify(p, better), [])
  })

  it('verify names the hours rule when a class sits outside its day', () => {
    const p = problemOf({ schoolHours, rooms: [room('R1')], sections: [sec('S1', { meetings_per_week: 1 })] })
    const bad: Placement = { sectionId: 'S1', index: 0, roomId: 'R1', day: 5, start: slot('11:00'), end: slot('12:30') } // Saturday closes at 12:00
    assert.match(verify(p, [bad]).join('|'), /outside school hours/)
    const closedDay: Placement = { sectionId: 'S1', index: 0, roomId: 'R1', day: 3, start: slot('09:00'), end: slot('10:30') } // Thursday
    assert.match(verify(p, [closedDay]).join('|'), /day not allowed/)
  })

  it('a day too short for a meeting is simply not used for it', async () => {
    // Saturday is open 08:00-09:00 only; a 90-minute class cannot go there, the other days take it
    const p = problemOf({
      schoolHours: [hours(1, '08:00', '17:00'), hours(6, '08:00', '09:00')],
      rooms: [room('R1')],
      sections: [sec('S1', { meetings_per_week: 1, minutes_per_meeting: 90 })],
    })
    const r = await solve(p)
    assert.equal(r.complete, true)
    assert.equal(r.placements[0]!.day, 0)
  })

  it('falls back to the older weekday/opening-time settings when no school hours are given', () => {
    const p = problemOf({ weekdays: [1, 2], openMinutes: 8 * 60, closeMinutes: 12 * 60, rooms: [room('R1')] })
    assert.deepEqual(p.days, [0, 1])
    assert.deepEqual(p.dayHours[0], { open: slot('08:00'), close: slot('12:00') })
    assert.equal(p.closure.length, 0)
  })
})

describe('instructor work hours', () => {
  it('turns work windows into unavailable time outside them', () => {
    const p = problemOf({
      schoolHours: [hours(1, '07:00', '21:00'), hours(2, '07:00', '21:00')],
      rooms: [room('R1')],
      instructors: [inst('I1')],
      workHours: [work('I1', 1, '09:00', '12:00'), work('I1', 1, '13:00', '16:00')], // nothing on Tuesday
    })
    const mon = p.unavailable.filter((u) => u.day === 0).map((u) => [u.start, u.end]).sort((a, b) => a[0]! - b[0]!)
    assert.deepEqual(mon, [[0, slot('09:00')], [slot('12:00'), slot('13:00')], [slot('16:00'), 48]])
    assert.deepEqual(p.unavailable.filter((u) => u.day === 1).map((u) => [u.start, u.end]), [[0, 48]]) // the whole of Tuesday
  })

  it('an instructor with no work hours may teach whenever the school is open', () => {
    const p = problemOf({ rooms: [room('R1')], instructors: [inst('I1')], workHours: [work('OTHER', 1, '09:00', '12:00')] })
    assert.equal(p.unavailable.length, 0)
  })

  it('schedules a part-time instructor only inside their work hours', async () => {
    const p = problemOf({
      rooms: [room('R1'), room('R2')],
      instructors: [inst('PT', { employment_type: 'part_time', max_weekly_hours: 12 }), inst('FT')],
      workHours: [work('PT', 2, '13:00', '17:00'), work('PT', 4, '13:00', '17:00')], // Tue and Thu afternoons
      sections: [
        sec('S1', { instructor_id: 'PT', cohort: 'A', meetings_per_week: 2, minutes_per_meeting: 90 }),
        sec('S2', { instructor_id: 'PT', cohort: 'B', meetings_per_week: 2, minutes_per_meeting: 90 }),
        sec('S3', { instructor_id: 'FT', cohort: 'C', meetings_per_week: 2, minutes_per_meeting: 90 }),
      ],
    })
    assert.equal(p.instructors['PT']!.partTime, true)
    assert.equal(p.instructors['FT']!.partTime, false)
    const r = await solve(p)
    assert.equal(r.complete, true)
    assert.deepEqual(r.violations, [])
    for (const pl of r.placements.filter((x) => p.sections.find((s) => s.id === x.sectionId)!.instructorId === 'PT')) {
      assert.ok(pl.day === 1 || pl.day === 3, `part-time instructor placed on day ${pl.day}`)
      assert.ok(pl.start >= slot('13:00') && pl.end <= slot('17:00'), `part-time instructor placed at ${pl.start}-${pl.end}`)
    }
  })

  it('verify rejects a class outside the instructor’s work hours', () => {
    const p = problemOf({
      rooms: [room('R1')],
      instructors: [inst('PT', { employment_type: 'part_time' })],
      workHours: [work('PT', 2, '13:00', '17:00')],
      sections: [sec('S1', { instructor_id: 'PT', meetings_per_week: 1 })],
    })
    const morning: Placement = { sectionId: 'S1', index: 0, roomId: 'R1', day: 1, start: slot('09:00'), end: slot('10:30') }
    assert.match(verify(p, [morning]).join('|'), /instructor busy or unavailable/)
    const ok: Placement = { sectionId: 'S1', index: 0, roomId: 'R1', day: 1, start: slot('14:00'), end: slot('15:30') }
    assert.deepEqual(verify(p, [ok]), [])
  })

  it('says so when the work hours leave no room for a class', async () => {
    const p = problemOf({
      rooms: [room('R1')],
      instructors: [inst('PT', { employment_type: 'part_time' })],
      workHours: [work('PT', 2, '10:00', '11:00')], // one hour a week, class needs 90 minutes
      sections: [sec('S1', { instructor_id: 'PT', meetings_per_week: 1, minutes_per_meeting: 90 })],
    })
    const r = await solve(p)
    assert.equal(r.placements.length, 0)
    assert.match(r.unplaced[0]!.reason, /work hours/)
  })

  it('keeps the weekly teaching limit for a part-time instructor', async () => {
    const p = problemOf({
      rooms: [room('R1'), room('R2')],
      instructors: [inst('PT', { employment_type: 'part_time', max_weekly_hours: 3 })],
      sections: [
        sec('S1', { instructor_id: 'PT', cohort: 'A', meetings_per_week: 2, minutes_per_meeting: 90 }),
        sec('S2', { instructor_id: 'PT', cohort: 'B', meetings_per_week: 2, minutes_per_meeting: 90 }),
      ],
    })
    const r = await solve(p)
    assert.equal(r.placements.length, 2) // 3 h = two 90-minute meetings
    assert.equal(r.unplaced.length, 2)
    assert.match(r.unplaced[0]!.reason, /weekly teaching limit/)
  })
})

describe('subjects with special room needs', () => {
  const chem = (o: object = {}) => ({ component: 'lab', course: { code: 'CHEM1', required_facility: 'chemistry_lab', lab_units: 1 }, ...o })

  it('applies the room type to the lab part only when a course has lab units', () => {
    assert.equal(facilityFor({ component: 'lecture', course: { code: 'X', required_facility: 'chemistry_lab', lab_units: 1 } }), null)
    assert.equal(facilityFor({ component: 'lab', course: { code: 'X', required_facility: 'chemistry_lab', lab_units: 1 } }), 'chemistry_lab')
    // a course without lab units that names a room type needs it for every meeting
    assert.equal(facilityFor({ component: 'lecture', course: { code: 'X', required_facility: 'computer_lab', lab_units: 0 } }), 'computer_lab')
    assert.equal(facilityFor({ course: { code: 'X', required_facility: 'computer_lab' } }), 'computer_lab')
    assert.equal(facilityFor({ component: 'lab', course: { code: 'X', required_facility: null, lab_units: 1 } }), null)
  })

  it('puts a chemistry lab session in the chemistry lab and the lecture of the same course elsewhere', async () => {
    const p = problemOf({
      rooms: [room('LEC'), room('CHEM', { facilities: ['chemistry_lab'] }), room('CS', { facilities: ['computer_lab'] })],
      sections: [
        sec('CH-LEC', { cohort: 'A', component: 'lecture', meetings_per_week: 2, minutes_per_meeting: 90, course: { code: 'CHEM1', required_facility: 'chemistry_lab', lab_units: 1 } }),
        sec('CH-LAB', { cohort: 'A', component: 'lab', meetings_per_week: 1, minutes_per_meeting: 180, ...chem() }),
      ],
    })
    assert.equal(p.sections.find((s) => s.id === 'CH-LAB')!.requiredFacility, 'chemistry_lab')
    assert.equal(p.sections.find((s) => s.id === 'CH-LEC')!.requiredFacility, null)
    const r = await solve(p)
    assert.equal(r.complete, true)
    assert.deepEqual(r.violations, [])
    for (const pl of r.placements) {
      if (pl.sectionId === 'CH-LAB') assert.equal(pl.roomId, 'CHEM')
      else assert.notEqual(pl.roomId, 'CS', 'a lecture should not take the computer lab while a plain room is free')
    }
  })

  it('reports a lab nobody has a room for, naming the room type', async () => {
    const p = problemOf({ rooms: [room('LEC')], sections: [sec('S1', { component: 'lab', course: { code: 'CHEM1', required_facility: 'chemistry_lab', lab_units: 1 } })] })
    const r = await solve(p)
    assert.equal(r.placements.length, 0)
    assert.match(r.unplaced[0]!.reason, /chemistry_lab/)
  })

  it('prefers plain rooms for plain lectures, but does use a special room when it must', async () => {
    const rooms = [room('PLAIN'), room('LAB', { facilities: ['computer_lab'] })]
    const p1 = problemOf({ rooms, sections: [sec('S1', { cohort: 'A', meetings_per_week: 1 })] })
    const r1 = await solve(p1)
    assert.equal(r1.placements[0]!.roomId, 'PLAIN')

    // the only plain room is closed all week by another department: the lecture takes the lab room
    const blocked = problemOf({
      rooms,
      busy: Array.from({ length: 6 }, (_, d) => ({ entry_id: `b${d}`, room_id: 'PLAIN', instructor_id: null, cohort_key: null, day_of_week: d + 1, start_time: '07:00:00', end_time: '21:00:00' })),
      sections: [sec('S1', { cohort: 'A', meetings_per_week: 1 })],
    })
    const r2 = await solve(blocked)
    assert.equal(r2.placements[0]!.roomId, 'LAB')
  })

  it('charges for a lecture in a special room and not for a lab that needs it', () => {
    const w = fullWeights()
    assert.equal(roomPenalty(false, true, w), w.labRoom)
    assert.equal(roomPenalty(true, true, w), 0)
    assert.equal(roomPenalty(false, false, w), 0)
    const p = problemOf({
      rooms: [room('PLAIN'), room('LAB', { facilities: ['computer_lab'] })],
      sections: [sec('S1', { meetings_per_week: 1 })],
    })
    const inPlain: Placement = { sectionId: 'S1', index: 0, roomId: 'PLAIN', day: 0, start: p.open, end: p.open + 3 }
    const inLab: Placement = { ...inPlain, roomId: 'LAB' }
    assert.equal(softPenalty(p, [inLab]) - softPenalty(p, [inPlain]), w.labRoom)
  })

  it('local search moves a lecture out of a special room when that is free', () => {
    const p = problemOf({
      rooms: [room('PLAIN'), room('LAB', { facilities: ['computer_lab'] })],
      sections: [sec('S1', { meetings_per_week: 1 })],
    })
    const start: Placement[] = [{ sectionId: 'S1', index: 0, roomId: 'LAB', day: 0, start: p.open, end: p.open + 3 }]
    const out = improve(p, start, undefined, 400)
    assert.equal(out[0]!.roomId, 'PLAIN')
  })
})

describe('part-time instructors teach on fewer days', () => {
  it('weighs a teaching day more for part-time staff', () => {
    const p = problemOf({ rooms: [room('R1')], instructors: [inst('PT', { employment_type: 'part_time' }), inst('FT')] })
    const w = fullWeights()
    assert.equal(dayWeight(p, 'FT', w), w.instructorDay)
    assert.equal(dayWeight(p, 'PT', w), w.instructorDay * PART_TIME_DAY_FACTOR)
  })

  it('counts those days in the penalty', () => {
    const p = problemOf({
      rooms: [room('R1')],
      instructors: [inst('PT', { employment_type: 'part_time' }), inst('FT')],
      sections: [sec('A', { instructor_id: 'PT', cohort: 'A' }), sec('B', { instructor_id: 'FT', cohort: 'B' })],
    })
    const at = (sectionId: string, day: number): Placement => ({ sectionId, index: 0, roomId: 'R1', day, start: p.open, end: p.open + 3 })
    const w = fullWeights()
    const base = softPenalty(p, [at('A', 0), at('B', 0)], w)
    // a second teaching day for the part-time instructor costs three times as much as for the full-time one
    const extraPt = softPenalty(p, [at('A', 0), { ...at('A', 2), index: 1 }, at('B', 0)], w) - base
    const extraFt = softPenalty(p, [at('A', 0), at('B', 0), { ...at('B', 2), index: 1 }], w) - base
    assert.equal(extraPt - extraFt, w.instructorDay * (PART_TIME_DAY_FACTOR - 1))
  })
})

describe('a whole program with every rule at once', () => {
  it('stays clean with school hours, work hours, lab rooms and other departments’ bookings', async () => {
    const input = randomCase(7, { rooms: 6, sections: 14, otherSections: 20 })
    const schoolHours = [1, 2, 3, 4, 5].map((d) => hours(d, '07:30', '19:00')).concat(hours(6, '08:00', '13:00'))
    const workHours: RawWorkHours[] = [
      ...[1, 3, 5].map((d) => work('I0', d, '08:00', '17:00')),
      ...[2, 4].map((d) => work('I1', d, '07:30', '19:00')),
    ]
    const instructors = input.instructors.map((i, k) => (k === 0 ? { ...i, employment_type: 'part_time' } : i))
    const p = problemOf({ ...input, instructors, schoolHours, workHours })
    const r = await solve(p, 8)
    assert.deepEqual(r.violations, [])
    for (const pl of r.placements) {
      const h = p.dayHours[pl.day]!
      assert.ok(pl.start >= h.open && pl.end <= h.close)
    }
    assert.ok(r.placements.length > 0)
  })
})
