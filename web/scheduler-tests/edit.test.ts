import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { clock, editSummaryText, findFreePlace, placeMeeting, placementProblems, summarizeEdits, unplaceMeeting } from '../src/lib/scheduler/edit.ts'
import { finalize } from '../src/lib/scheduler/finalize.ts'
import { firstFit } from '../src/lib/scheduler/firstFit.ts'
import { fullWeights } from '../src/lib/scheduler/score.ts'
import { verify } from '../src/lib/scheduler/verify.ts'
import type { Placement, SolveResult } from '../src/lib/scheduler/types.ts'
import { busy, inst, own, problemOf, randomCase, rng, room, sec, unavail } from './helpers.ts'

// slots are half hours after midnight: 07:00 = 14, 08:00 = 16, 09:30 = 19
const MON = 0
const TUE = 1
const WED = 2
const SUN = 6

const result = (problem: ReturnType<typeof problemOf>, placements: Placement[]): SolveResult =>
  finalize(problem, placements, { engine: 'first-fit', proven: false, runtimeMs: 5, notes: [] })

/** two 90-minute meetings for A (instructor I1, block C1), one for B (I1, block C2), two for C (I2, block C1) ... */
function world() {
  return problemOf({
    rooms: [room('R1'), room('R2', { capacity: 30, facilities: ['computer_lab'] }), room('R3')],
    instructors: [inst('I1'), inst('I2', { max_weekly_hours: 3 })],
    sections: [
      sec('A', { instructor_id: 'I1', cohort: 'C1', meetings_per_week: 2 }),
      sec('B', { instructor_id: 'I1', cohort: 'C2', meetings_per_week: 1 }),
      sec('C', { instructor_id: 'I2', cohort: 'C1', meetings_per_week: 2 }),
      sec('G', { instructor_id: 'I2', cohort: 'C9', meetings_per_week: 1 }),
      sec('D', { instructor_id: null, cohort: 'C3', enrollment: 120, meetings_per_week: 1 }),
      sec('E', { instructor_id: null, cohort: 'C4', meetings_per_week: 1, course: { code: 'C-E', required_facility: 'computer_lab' } }),
    ],
  })
}

const at = (sectionId: string, index: number, roomId: string, day: number, start: number): Placement => ({ sectionId, index, roomId, day, start, end: start + 3 })

describe('clock', () => {
  it('writes slot boundaries as clock times', () => {
    assert.equal(clock(14), '7:00 AM')
    assert.equal(clock(19), '9:30 AM')
    assert.equal(clock(24), '12:00 PM')
    assert.equal(clock(27), '1:30 PM')
    assert.equal(clock(42), '9:00 PM')
  })
})

describe('placeMeeting', () => {
  it('puts a meeting that was not placed onto the timetable and leaves a safe plan', () => {
    const p = world()
    const r0 = result(p, [at('A', 0, 'R1', MON, 16)])
    assert.ok(r0.unplaced.some((u) => u.sectionId === 'A'))
    const e = placeMeeting(p, r0, 'A', null, { roomId: 'R1', day: WED, start: 16 })
    assert.ok(e.ok)
    if (!e.ok) return
    assert.equal(e.result.placements.filter((x) => x.sectionId === 'A').length, 2)
    assert.equal(e.result.unplaced.filter((u) => u.sectionId === 'A').length, 0)
    assert.deepEqual(e.result.violations, [])
  })

  it('gives a placed meeting a free number even when the unplaced one has the same number', () => {
    const p = world()
    // the optimiser may have kept meeting number 1 and left number 0 (or the other way round): the numbers are interchangeable
    const r0 = result(p, [at('A', 1, 'R1', MON, 16)])
    const e = placeMeeting(p, r0, 'A', null, { roomId: 'R1', day: WED, start: 16 })
    assert.ok(e.ok)
    if (!e.ok) return
    const nums = e.result.placements.filter((x) => x.sectionId === 'A').map((x) => x.index).sort()
    assert.deepEqual(nums, [0, 1])
    assert.deepEqual(e.result.violations, [])
  })

  it('moves a placed meeting, and its own old place never counts against it', () => {
    const p = world()
    const r0 = result(p, [at('A', 0, 'R1', MON, 16)])
    const e = placeMeeting(p, r0, 'A', 0, { roomId: 'R1', day: MON, start: 17 }) // overlaps where it is now
    assert.ok(e.ok)
    if (!e.ok) return
    assert.equal(e.result.placements.find((x) => x.sectionId === 'A')!.start, 17)
    assert.deepEqual(e.result.violations, [])
  })

  it('refuses a room that is too small and one without the needed room type, saying why', () => {
    const p = world()
    const r0 = result(p, [])
    const big = placeMeeting(p, r0, 'D', null, { roomId: 'R1', day: MON, start: 16 })
    assert.ok(!big.ok && big.reasons.some((x) => /R1 seats 40 but this class has 120/.test(x)), JSON.stringify(big))
    const lab = placeMeeting(p, r0, 'E', null, { roomId: 'R1', day: MON, start: 16 })
    assert.ok(!lab.ok && lab.reasons.some((x) => /not a computer lab room/.test(x)), JSON.stringify(lab))
    const fine = placeMeeting(p, r0, 'E', null, { roomId: 'R2', day: MON, start: 16 })
    assert.ok(fine.ok)
  })

  it('refuses a time outside school hours and a day the school is closed', () => {
    const p = world()
    const r0 = result(p, [])
    const early = placeMeeting(p, r0, 'B', null, { roomId: 'R1', day: MON, start: 10 })
    assert.ok(!early.ok && early.reasons.some((x) => /outside school hours/.test(x)), JSON.stringify(early))
    const late = placeMeeting(p, r0, 'B', null, { roomId: 'R1', day: MON, start: 40 }) // ends 22:00
    assert.ok(!late.ok && late.reasons.some((x) => /outside school hours/.test(x)))
    const sunday = placeMeeting(p, r0, 'B', null, { roomId: 'R1', day: SUN, start: 16 })
    assert.ok(!sunday.ok && sunday.reasons.some((x) => /closed on Sunday/.test(x)))
  })

  it('refuses a room that another department has booked', () => {
    const p = problemOf({
      rooms: [room('R1')],
      sections: [sec('B', { meetings_per_week: 1 })],
      busy: [busy({ room_id: 'R1', day_of_week: 1, start_time: '08:00:00', end_time: '09:30:00' })],
    })
    const e = placeMeeting(p, result(p, []), 'B', null, { roomId: 'R1', day: MON, start: 17 })
    assert.ok(!e.ok && e.reasons.some((x) => /booked by another department/.test(x)), JSON.stringify(e))
    assert.ok(placeMeeting(p, result(p, []), 'B', null, { roomId: 'R1', day: MON, start: 19 }).ok) // right after it
  })

  it('refuses a double booking inside the plan: room, instructor and student block', () => {
    const p = world()
    const r0 = result(p, [at('A', 0, 'R1', MON, 16)])
    const room_ = placeMeeting(p, r0, 'B', null, { roomId: 'R1', day: MON, start: 16 })
    assert.ok(!room_.ok && room_.reasons.some((x) => /R1 already has A on Monday/.test(x)), JSON.stringify(room_))
    const teacher = placeMeeting(p, r0, 'B', null, { roomId: 'R3', day: MON, start: 17 })
    assert.ok(!teacher.ok && teacher.reasons.some((x) => /Prof I1 already teaches A/.test(x)), JSON.stringify(teacher))
    const block = placeMeeting(p, r0, 'C', null, { roomId: 'R3', day: MON, start: 16 })
    assert.ok(!block.ok && block.reasons.some((x) => /student block already has A/.test(x)), JSON.stringify(block))
  })

  it('refuses two meetings of one class on the same day', () => {
    const p = world()
    const r0 = result(p, [at('A', 0, 'R1', MON, 16)])
    const e = placeMeeting(p, r0, 'A', null, { roomId: 'R3', day: MON, start: 30 })
    assert.ok(!e.ok && e.reasons.some((x) => /A already meets on Monday/.test(x)), JSON.stringify(e))
  })

  it('refuses the day a kept (already submitted) meeting of the same class uses', () => {
    const p = problemOf({
      rooms: [room('R1'), room('R3')],
      sections: [sec('A', { instructor_id: null, cohort: 'C1', meetings_per_week: 2 })],
      busy: [busy({ entry_id: 'kept', room_id: 'R1', day_of_week: 1, start_time: '08:00:00', end_time: '09:30:00' })],
      ownEntries: [own('kept', 'A', 'published', 1)],
    })
    assert.equal(p.sections[0]!.toPlace, 1)
    const same_day = placeMeeting(p, result(p, []), 'A', null, { roomId: 'R3', day: MON, start: 30 })
    assert.ok(!same_day.ok && same_day.reasons.some((x) => /A already meets on Monday/.test(x)), JSON.stringify(same_day))
    assert.ok(placeMeeting(p, result(p, []), 'A', null, { roomId: 'R3', day: TUE, start: 30 }).ok)
  })

  it('refuses an instructor who is unavailable, or over the weekly limit', () => {
    const p = problemOf({
      rooms: [room('R1'), room('R3')],
      instructors: [inst('I1'), inst('I2', { max_weekly_hours: 3 })],
      unavailability: [unavail('I1', 1, '08:00:00', '10:00:00')],
      sections: [
        sec('B', { instructor_id: 'I1', cohort: 'C2', meetings_per_week: 1 }),
        sec('C', { instructor_id: 'I2', cohort: 'C1', meetings_per_week: 2 }),
        sec('G', { instructor_id: 'I2', cohort: 'C9', meetings_per_week: 1 }),
      ],
    })
    const r0 = result(p, [at('C', 0, 'R1', MON, 16), at('C', 1, 'R1', WED, 16)]) // exactly 3 hours
    const away = placeMeeting(p, r0, 'B', null, { roomId: 'R3', day: MON, start: 16 })
    assert.ok(!away.ok && away.reasons.some((x) => /Prof I1 cannot teach/.test(x)), JSON.stringify(away))
    const over = placeMeeting(p, r0, 'G', null, { roomId: 'R3', day: TUE, start: 16 })
    assert.ok(!over.ok && over.reasons.some((x) => /Prof I2 would go over the weekly teaching limit/.test(x)), JSON.stringify(over))
  })

  it('refuses things that are not there', () => {
    const p = world()
    const r0 = result(p, [at('A', 0, 'R1', MON, 16)])
    assert.ok(!placeMeeting(p, r0, 'nope', null, { roomId: 'R1', day: MON, start: 16 }).ok)
    assert.ok(!placeMeeting(p, r0, 'A', 5, { roomId: 'R1', day: TUE, start: 16 }).ok)
    const full = result(p, [at('B', 0, 'R1', MON, 16)])
    const again = placeMeeting(p, full, 'B', null, { roomId: 'R1', day: TUE, start: 16 })
    assert.ok(!again.ok && again.reasons.some((x) => /already has all its meetings/.test(x)))
  })
})

describe('unplaceMeeting', () => {
  it('takes a meeting off the timetable and it needs a place again', () => {
    const p = world()
    const r0 = result(p, [at('B', 0, 'R1', MON, 16)])
    assert.equal(r0.unplaced.filter((u) => u.sectionId === 'B').length, 0)
    const e = unplaceMeeting(p, r0, 'B', 0)
    assert.ok(e.ok)
    if (!e.ok) return
    assert.equal(e.result.placements.some((x) => x.sectionId === 'B'), false)
    assert.equal(e.result.unplaced.filter((u) => u.sectionId === 'B').length, 1)
    assert.ok(!unplaceMeeting(p, r0, 'B', 7).ok)
  })
})

describe('the edit check agrees with the independent rule checker', () => {
  // for many random moves: allowed by placementProblems exactly when verify() finds the resulting plan clean
  for (const seed of [1, 2, 3]) {
    it(`seed ${seed}`, () => {
      const input = randomCase(seed, { rooms: 6, sections: 14, otherSections: 6, meetings: [1, 2], roomsFitEveryone: false })
      const problem = problemOf(input)
      const start = result(problem, firstFit(problem, fullWeights()))
      assert.deepEqual(start.violations, [])
      const r = rng(seed * 977)
      const pick = <T,>(a: T[]) => a[Math.floor(r() * a.length)]!
      let allowed = 0
      let refused = 0
      for (let n = 0; n < 400; n++) {
        const placed = start.placements
        const useUnplaced = start.unplaced.length > 0 && (placed.length === 0 || r() < 0.4)
        let sectionId: string
        let index: number | null
        if (useUnplaced) {
          sectionId = pick(start.unplaced).sectionId
          index = null
        } else {
          const p = pick(placed)
          sectionId = p.sectionId
          index = p.index
        }
        const to = { roomId: pick(problem.rooms).id, day: Math.floor(r() * 7), start: 12 + Math.floor(r() * 32) }
        const reasons = placementProblems(problem, start.placements, sectionId, index, to)
        const s = problem.sections.find((x) => x.id === sectionId)!
        const idx = index ?? Math.max(-1, ...start.placements.filter((x) => x.sectionId === sectionId).map((x) => x.index)) + 1
        const next = [...start.placements.filter((x) => !(x.sectionId === sectionId && x.index === idx)), { sectionId, index: idx, roomId: to.roomId, day: to.day, start: to.start, end: to.start + s.slots }]
        const clean = verify(problem, next).length === 0
        assert.equal(reasons.length === 0, clean, `${sectionId}#${index} -> ${JSON.stringify(to)}: ${reasons.join(' | ')} / ${verify(problem, next).join(' | ')}`)
        if (reasons.length === 0) allowed++
        else refused++
      }
      assert.ok(allowed > 5 && refused > 5, `a useful mix of moves: ${allowed} allowed, ${refused} refused`)
    })
  }
})

describe('findFreePlace', () => {
  it('finds the earliest free time, preferring the given room, and the result is always accepted', () => {
    const p = world()
    const r0 = result(p, [at('A', 0, 'R1', MON, 14)]) // A already meets Monday from 07:00 in R1
    const spot = findFreePlace(p, r0.placements, 'B', null, 'R1')
    assert.ok(spot)
    assert.equal(spot!.roomId, 'R1')
    // Monday 07:00 in R1 is taken (and Prof I1 teaches then), so the first free start is Monday 08:30 in R1
    assert.deepEqual(spot, { roomId: 'R1', day: MON, start: 17 })
    assert.ok(placeMeeting(p, r0, 'B', null, spot!).ok)
  })

  it('only offers rooms that are big enough and of the right type, and returns null when nothing fits', () => {
    const p = world()
    const r0 = result(p, [])
    assert.equal(findFreePlace(p, r0.placements, 'D', null), null) // 120 students: no room seats them
    assert.equal(findFreePlace(p, r0.placements, 'E', null, 'R1')!.roomId, 'R2') // the only computer lab, although R1 was preferred
  })

  it('is fast enough to run when a button is pressed', () => {
    const problem = problemOf(randomCase(7, { rooms: 8, sections: 30, otherSections: 20, meetings: [1, 2] }))
    const start = result(problem, firstFit(problem, fullWeights()))
    const t0 = performance.now()
    for (const u of start.unplaced.slice(0, 5)) findFreePlace(problem, start.placements, u.sectionId, null)
    findFreePlace(problem, start.placements, problem.sections[0]!.id, null)
    assert.ok(performance.now() - t0 < 1500, `took ${Math.round(performance.now() - t0)} ms`)
  })
})

describe('summarizeEdits', () => {
  it('tells moved, placed from the list and taken off apart', () => {
    const p = world()
    const r0 = result(p, [at('A', 0, 'R1', MON, 16), at('B', 0, 'R1', TUE, 16), at('C', 0, 'R3', MON, 20)])
    assert.deepEqual(summarizeEdits(r0.placements, r0.placements), { moved: 0, placed: 0, removed: 0 })
    assert.equal(editSummaryText(summarizeEdits(r0.placements, r0.placements)), '')

    const moved = placeMeeting(p, r0, 'B', 0, { roomId: 'R3', day: WED, start: 22 })
    assert.ok(moved.ok)
    if (!moved.ok) return
    assert.deepEqual(summarizeEdits(r0.placements, moved.result.placements), { moved: 1, placed: 0, removed: 0 })

    const placed = placeMeeting(p, moved.result, 'A', null, { roomId: 'R1', day: WED, start: 16 })
    assert.ok(placed.ok)
    if (!placed.ok) return
    assert.deepEqual(summarizeEdits(r0.placements, placed.result.placements), { moved: 1, placed: 1, removed: 0 })

    const off = unplaceMeeting(p, placed.result, 'C', 0)
    assert.ok(off.ok)
    if (!off.ok) return
    const s = summarizeEdits(r0.placements, off.result.placements)
    assert.deepEqual(s, { moved: 1, placed: 1, removed: 1 })
    assert.equal(editSummaryText(s), '1 moved, 1 placed from the list, 1 taken off')
  })

  it('moving a meeting and moving it back is no change at all', () => {
    const p = world()
    const r0 = result(p, [at('B', 0, 'R1', TUE, 16)])
    const there = placeMeeting(p, r0, 'B', 0, { roomId: 'R3', day: WED, start: 22 })
    assert.ok(there.ok)
    if (!there.ok) return
    const back = placeMeeting(p, there.result, 'B', 0, { roomId: 'R1', day: TUE, start: 16 })
    assert.ok(back.ok)
    if (!back.ok) return
    assert.deepEqual(summarizeEdits(r0.placements, back.result.placements), { moved: 0, placed: 0, removed: 0 })
  })
})
