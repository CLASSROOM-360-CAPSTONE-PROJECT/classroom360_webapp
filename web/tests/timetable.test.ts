import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  blockLabel,
  buildSheet,
  cellText,
  filterMeetings,
  groupMeetings,
  hoursOf,
  isFinal,
  layoutLanes,
  legendCell,
  legendColumns,
  meetingLabel,
  timetableCsv,
  timetableFilename,
  tintIndex,
  toMeeting,
  whenText,
  type Meeting,
  type TimetableRow,
} from '../src/lib/timetable.ts'

const BOM = '﻿'
const lines = (csv: string) => csv.replace(BOM, '').split('\r\n').filter((l) => l !== '')

let n = 0
const row = (over: Partial<TimetableRow> & { course?: string; cohort?: string | null; year?: number | null; program?: string; component?: 'lecture' | 'lab' | null } = {}): TimetableRow => {
  const { course = 'CPE 401', cohort = 'A', year = 4, program = 'BSCPE', component = 'lecture', ...rest } = over
  n += 1
  return {
    id: `e${String(n).padStart(3, '0')}`,
    program_id: 'p1',
    instructor_id: 'i1',
    room_id: 'r1',
    day_of_week: 1,
    start_time: '08:00:00',
    end_time: '09:30:00',
    status: 'published',
    sections: { code: `${course}-1`, component, year_level: year, cohort, program_id: 'p1', courses: { code: course, title: `${course} title` }, programs: { code: program } },
    instructors: { full_name: 'Ana Reyes' },
    rooms: { code: 'LRC-301', name: 'Computer Lab 1' },
    ...rest,
  }
}
const m = (over: Parameters<typeof row>[0] = {}): Meeting => toMeeting(row(over))

describe('block labels', () => {
  it('joins the program and the cohort, adding the year only when the cohort leaves it out', () => {
    assert.equal(blockLabel('BSCPE', 4, 'A'), 'BSCPE 4A')
    assert.equal(blockLabel('BSCPE', 4, '4A'), 'BSCPE 4A')
    assert.equal(blockLabel('BSCPE', null, 'B'), 'BSCPE B')
  })
  it('falls back to the year, the program, or a plain sentence', () => {
    assert.equal(blockLabel('BSCPE', 3, null), 'BSCPE Year 3')
    assert.equal(blockLabel('BSCPE', null, ''), 'BSCPE')
    assert.equal(blockLabel(null, null, null), 'No student block')
  })
})

describe('toMeeting', () => {
  it('works out the names, the minutes and the block key the database uses', () => {
    const x = m({})
    assert.equal(x.courseCode, 'CPE 401')
    assert.equal(x.startMin, 480)
    assert.equal(x.endMin, 570)
    assert.equal(x.block, 'BSCPE 4A')
    assert.equal(x.blockKey, 'p1:4:A')
    assert.equal(x.room, 'LRC-301')
  })
  it('copes with a meeting that has no section, no room name or no instructor', () => {
    const x = toMeeting({ ...row(), sections: null, instructors: null, rooms: null, instructor_id: null })
    assert.equal(x.courseCode, 'Class')
    assert.equal(x.instructor, 'No instructor assigned')
    assert.equal(x.room, 'No room')
    assert.equal(x.block, 'No student block')
  })
})

describe('filtering', () => {
  const all = [m({ status: 'published' }), m({ status: 'draft' }), m({ status: 'returned' }), m({ status: 'submitted' })]
  it('keeps only published meetings by default', () => {
    assert.equal(filterMeetings(all, { include: 'published' }).length, 1)
  })
  it('keeps everything when asked, and narrows by program', () => {
    assert.equal(filterMeetings(all, { include: 'all' }).length, 4)
    const other = toMeeting({ ...row(), sections: { ...row().sections!, program_id: 'p2' } })
    assert.equal(filterMeetings([...all, other], { include: 'all', programId: 'p2' }).length, 1)
  })
})

describe('grouping', () => {
  const list = [
    m({ cohort: 'B', day_of_week: 3, instructors: { full_name: 'Zed Young' }, instructor_id: 'i2', room_id: 'r2', rooms: { code: 'LRC-302', name: 'Lecture room' } }),
    m({ cohort: 'A', day_of_week: 2, start_time: '10:00:00', end_time: '11:00:00' }),
    m({ cohort: 'A', day_of_week: 1 }),
    m({ cohort: 'A', instructor_id: null, instructors: null, day_of_week: 5 }),
  ]
  it('makes one sheet per student block, each in week order', () => {
    const g = groupMeetings(list, 'block')
    assert.deepEqual(g.map((x) => x.label), ['BSCPE 4A', 'BSCPE 4B'])
    assert.deepEqual(g[0].meetings.map((x) => x.day), [1, 2, 5])
  })
  it('sorts instructors by last name and puts the unassigned meetings last', () => {
    const g = groupMeetings(list, 'instructor')
    assert.deepEqual(g.map((x) => x.label), ['Ana Reyes', 'Zed Young', 'No instructor assigned'])
  })
  it('makes one sheet per room with the room name underneath', () => {
    const g = groupMeetings(list, 'room')
    assert.deepEqual(g.map((x) => `${x.label}|${x.sub}`), ['LRC-301|Computer Lab 1', 'LRC-302|Lecture room'])
  })
  it('sorts room codes the way people count (LRC-9 before LRC-10)', () => {
    const rooms = ['LRC-10', 'LRC-9', 'LRC-2'].map((c, i) => m({ room_id: `r${i}`, rooms: { code: c, name: '' } }))
    assert.deepEqual(groupMeetings(rooms, 'room').map((x) => x.label), ['LRC-2', 'LRC-9', 'LRC-10'])
  })
  it('adds up the weekly hours to a quarter of an hour', () => {
    assert.equal(hoursOf([m({}), m({ start_time: '13:00:00', end_time: '14:15:00' })]), 2.75)
    assert.equal(groupMeetings(list, 'block')[0].hours, 1.5 + 1 + 1.5)
  })
})

describe('lanes', () => {
  const it2 = (startMin: number, endMin: number) => ({ startMin, endMin })
  it('gives meetings that do not overlap the whole width', () => {
    const l = layoutLanes([it2(480, 540), it2(540, 600)])
    assert.deepEqual(l.map((x) => [x.lane, x.lanes]), [[0, 1], [0, 1]])
  })
  it('puts overlapping meetings side by side, and they all share the same width', () => {
    const l = layoutLanes([it2(480, 600), it2(500, 560), it2(570, 620), it2(700, 760)])
    assert.deepEqual(l.map((x) => [x.lane, x.lanes]), [[0, 2], [1, 2], [1, 2], [0, 1]])
  })
})

describe('sheet', () => {
  it('shows Monday to Friday and only the hours that are used', () => {
    const s = buildSheet([m({ start_time: '08:00:00', end_time: '09:30:00' }), m({ day_of_week: 3, start_time: '13:00:00', end_time: '16:00:00' })])
    assert.equal(s.columns.length, 5)
    assert.equal(s.startHour, 8)
    assert.equal(s.endHour, 16)
    assert.deepEqual(s.hours, [8, 9, 10, 11, 12, 13, 14, 15])
  })
  it('adds Saturday and Sunday only when something is on them', () => {
    assert.equal(buildSheet([m({ day_of_week: 6 })]).columns.length, 6)
    assert.equal(buildSheet([m({ day_of_week: 7 })]).columns.length, 7)
  })
  it('places a meeting by its share of the day', () => {
    const s = buildSheet([m({ start_time: '08:00:00', end_time: '10:00:00' }), m({ start_time: '10:00:00', end_time: '12:00:00', day_of_week: 2 })])
    // 8:00 to 12:00 = 4 hours = 100%
    assert.equal(s.columns[0].blocks[0].topPct, 0)
    assert.equal(s.columns[0].blocks[0].heightPct, 50)
    assert.equal(s.columns[1].blocks[0].topPct, 50)
  })
  it('keeps at least four hours so a short day is not squashed, and copes with nothing at all', () => {
    const s = buildSheet([m({ start_time: '08:00:00', end_time: '09:00:00' })])
    assert.equal(s.endHour - s.startHour, 4)
    const empty = buildSheet([])
    assert.equal(empty.columns.length, 5)
    assert.ok(empty.hours.length >= 4)
  })
  it('does not run past midnight', () => {
    const s = buildSheet([m({ start_time: '22:00:00', end_time: '23:30:00' })])
    assert.equal(s.endHour, 24)
    assert.equal(s.endHour - s.startHour, 4)
  })
})

describe('text', () => {
  const x = m({ component: 'lab' })
  it('says in each box only what the view does not already say', () => {
    assert.deepEqual(cellText(x, 'block'), { title: 'CPE 401 Lab', lines: ['LRC-301', 'Ana Reyes'] })
    assert.deepEqual(cellText(x, 'instructor'), { title: 'CPE 401 Lab', lines: ['BSCPE 4A', 'LRC-301'] })
    assert.deepEqual(cellText(x, 'room'), { title: 'CPE 401 Lab', lines: ['BSCPE 4A', 'Ana Reyes'] })
  })
  it('leaves out an instructor line when nobody is assigned', () => {
    const y = toMeeting({ ...row(), instructors: null, instructor_id: null })
    assert.deepEqual(cellText(y, 'block').lines, ['LRC-301'])
  })
  it('writes one full sentence for a tooltip', () => {
    assert.equal(
      meetingLabel(x),
      'CPE 401, CPE 401 title, laboratory, Monday 8:00 AM to 9:30 AM, room LRC-301, Ana Reyes, BSCPE 4A, Published',
    )
    assert.equal(whenText(x), 'Mon 8:00 AM to 9:30 AM')
  })
  it('picks the same colour for the same course every time, within the palette', () => {
    assert.equal(tintIndex('CPE 401'), tintIndex('CPE 401'))
    for (const c of ['CPE 401', 'MATH 101', 'NSTP 1', '']) assert.ok(tintIndex(c) >= 0 && tintIndex(c) < 8)
  })
})

describe('legend', () => {
  it('leaves out the column that every row of the sheet would repeat', () => {
    assert.deepEqual(legendColumns('block').map((c) => c.key), ['when', 'course', 'title', 'type', 'room', 'instructor'])
    assert.ok(!legendColumns('instructor').some((c) => c.key === 'instructor'))
    assert.ok(!legendColumns('room').some((c) => c.key === 'room'))
  })
  it('fills every cell of every view, with a blank instead of "No instructor assigned"', () => {
    const y = toMeeting({ ...row(), instructors: null, instructor_id: null })
    for (const v of ['block', 'instructor', 'room'] as const) {
      for (const c of legendColumns(v)) assert.equal(typeof legendCell(y, c.key), 'string')
    }
    assert.equal(legendCell(y, 'instructor'), '')
    assert.equal(legendCell(m({ component: 'lab' }), 'type'), 'Laboratory')
  })
})

describe('file', () => {
  const g = groupMeetings([m({ component: 'lab', day_of_week: 3, start_time: '13:00:00', end_time: '16:00:00' }), m({})], 'block')
  it('writes one row per meeting with the subject first and 24-hour times', () => {
    const l = lines(timetableCsv(g, 'block'))
    assert.equal(l[0], 'Student block,Day,Start,End,Hours,Course,Title,Type,Section,Student block,Room,Instructor,Status')
    assert.equal(l[1], 'BSCPE 4A,Monday,08:00,09:30,1.5,CPE 401,CPE 401 title,Lecture,CPE 401-1,BSCPE 4A,LRC-301,Ana Reyes,Published')
    assert.equal(l[2], 'BSCPE 4A,Wednesday,13:00,16:00,3,CPE 401,CPE 401 title,Laboratory,CPE 401-1,BSCPE 4A,LRC-301,Ana Reyes,Published')
  })
  it('starts with a byte order mark and never lets a title run as a formula', () => {
    const risky = groupMeetings([toMeeting({ ...row(), sections: { ...row().sections!, courses: { code: 'X', title: '=HYPERLINK("x")' } } })], 'block')
    const csv = timetableCsv(risky, 'block')
    assert.ok(csv.startsWith(BOM))
    assert.ok(lines(csv)[1].includes(`"'=HYPERLINK(""x"")"`))
  })
  it('names the file after the view, the term and the subject', () => {
    assert.equal(timetableFilename('block', '1st Sem 2026-2027', 'BSCPE 4A', 'csv'), 'classroom360-timetable-block-1st-sem-2026-2027-bscpe-4a.csv')
    assert.equal(timetableFilename('room', '', null, 'csv'), 'classroom360-timetable-room-term-all.csv')
  })
  it('calls a sheet final only when everything on it is published', () => {
    assert.equal(isFinal([m({})]), true)
    assert.equal(isFinal([m({}), m({ status: 'draft' })]), false)
    assert.equal(isFinal([]), false)
  })
})
