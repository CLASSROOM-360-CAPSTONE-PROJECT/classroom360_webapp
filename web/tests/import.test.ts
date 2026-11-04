import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'
import { formatWorkHours, parseDays, parseTimeRange, parseWorkHours } from '../src/lib/import/workHours.ts'
import { parseTeachingLoad, parseYear, parseYearSection } from '../src/lib/import/teachingLoad.ts'
import { tableFromCsv, tableFromXlsx } from '../src/lib/import/readTable.ts'
import { templateCsv } from '../src/lib/import/template.ts'

const wh = (text: string) => formatWorkHours(parseWorkHours(text).windows)
const fixture = (name: string) => new URL(`./fixtures/${name}`, import.meta.url)

describe('work hours text', () => {
  it('understands the usual ways of writing days and times', () => {
    assert.equal(wh('MWF 8am-5pm'), 'Mon, Wed, Fri 08:00-17:00')
    assert.equal(wh('Mon-Fri 8:00-17:00; Sat 8-12'), 'Mon–Fri 08:00-17:00; Sat 08:00-12:00')
    assert.equal(wh('TTh 1-5pm'), 'Tue, Thu 13:00-17:00')
    assert.equal(wh('Tue/Thu 1pm-5pm'), 'Tue, Thu 13:00-17:00')
    assert.equal(wh('8am-5pm Mon-Fri'), 'Mon–Fri 08:00-17:00')
    assert.equal(wh('Mon, Wed and Fri 9-12'), 'Mon, Wed, Fri 09:00-12:00')
    assert.equal(wh('weekdays 08:00-16:00'), 'Mon–Fri 08:00-16:00')
    assert.equal(wh('Mon to Fri 8 to 5'), 'Mon–Fri 08:00-17:00')
    assert.equal(wh('Sat 8am - noon'), 'Sat 08:00-12:00')
    assert.equal(wh('M-F 7:30am-4:30pm'), 'Mon–Fri 07:30-16:30')
  })

  it('keeps a split shift as two windows on the same day', () => {
    const r = parseWorkHours('Mon-Fri 8:00-12:00, 13:00-17:00')
    assert.equal(r.errors.length, 0)
    assert.equal(r.windows.filter((w) => w.day_of_week === 1).length, 2)
    assert.equal(wh('TTh 08:00-12:00 & 13:00-17:00'), 'Tue, Thu 08:00-12:00, 13:00-17:00')
  })

  it('merges overlapping periods so the database never sees an overlap', () => {
    const r = parseWorkHours('Mon 8-12; Mon 10-14')
    assert.deepEqual(r.windows, [{ day_of_week: 1, start_time: '08:00', end_time: '14:00' }])
  })

  it('guesses am/pm the way a school day runs, and honours 24-hour times', () => {
    assert.deepEqual(parseTimeRange('8', '5'), { start: 480, end: 1020 })
    assert.deepEqual(parseTimeRange('7', '12'), { start: 420, end: 720 })
    assert.deepEqual(parseTimeRange('1', '5'), { start: 780, end: 1020 })
    assert.deepEqual(parseTimeRange('8', '5pm'), { start: 480, end: 1020 })
    assert.deepEqual(parseTimeRange('11', '1pm'), { start: 660, end: 780 })
    assert.deepEqual(parseTimeRange('9am', '5'), { start: 540, end: 1020 })
    assert.deepEqual(parseTimeRange('08:00', '17:00'), { start: 480, end: 1020 })
    assert.equal(parseTimeRange('5', '3'), null)
  })

  it('says what is wrong instead of guessing', () => {
    assert.match(parseWorkHours('8-5').errors[0]!, /say which days/)
    assert.match(parseWorkHours('MWF').errors[0]!, /no times/)
    assert.match(parseWorkHours('Funday 8-5').errors[0]!, /not understood/)
    assert.match(parseWorkHours('Mon-Fri 5-3').errors[0]!, /not valid/)
  })

  it('treats blank text as no restriction', () => {
    assert.deepEqual(parseWorkHours('  '), { windows: [], errors: [] })
  })

  it('reads day abbreviations, ranges and runs', () => {
    assert.deepEqual(parseDays('MTWThFS'), [1, 2, 3, 4, 5, 6])
    assert.deepEqual(parseDays('tth'), [2, 4])
    assert.deepEqual(parseDays('Tue-Thu'), [2, 3, 4])
    assert.equal(parseDays('Thu-Tue'), null)
  })

  it('writes back what it can read again', () => {
    const original = parseWorkHours('Mon-Fri 8-12, 1-5; Sat 8-12').windows
    assert.deepEqual(parseWorkHours(formatWorkHours(original)).windows, original)
  })
})

describe('year and section', () => {
  it('reads year levels written in different ways', () => {
    for (const [text, year] of [['3', 3], ['3rd', 3], ['3rd year', 3], ['Year 3', 3], ['Third', 3], ['III', 3], ['1st', 1]] as const) {
      assert.equal(parseYear(text), year, text)
    }
    assert.equal(parseYear('Freshman'), null)
  })
  it('splits combined values', () => {
    assert.deepEqual(parseYearSection('3A'), { year: 3, section: 'A' })
    assert.deepEqual(parseYearSection('3-A'), { year: 3, section: 'A' })
    assert.deepEqual(parseYearSection('BSIT 3-A'), { year: 3, section: 'A' })
    assert.deepEqual(parseYearSection('Year 2 Section B'), { year: 2, section: 'B' })
    assert.equal(parseYearSection('Alpha'), null)
  })
})

describe('teaching load sheet', () => {
  it('reads an Excel file with a title above the column names, loose headings and fill-down', async () => {
    const table = await tableFromXlsx(new Blob([await readFile(fixture('teaching-load.xlsx'))]))
    const r = parseTeachingLoad(table)
    assert.equal(r.headerRow, 3)
    assert.deepEqual(r.issues.filter((i) => i.level === 'error'), [])
    assert.equal(r.rows.length, 5)

    const first = r.rows[0]!
    assert.equal(first.row, 4)
    assert.deepEqual(first.instructor, { name: 'Juan Dela Cruz', employee_no: 'E-101', email: 'juan@school.edu', employment: 'full_time', max_weekly_hours: 24, work_hours: parseWorkHours('Mon-Fri 8-17').windows })
    assert.deepEqual(first.course, { code: 'IT 211', title: 'Data Structures and Algorithms', lecture_units: 2, lab_units: 1, room_type: 'Computer Laboratory' })
    assert.equal(first.program, 'BSIT')
    assert.equal(first.year, 2)
    assert.equal(first.section, 'A')
    assert.equal(first.students, 35)

    const pt = r.rows[2]!
    assert.equal(pt.instructor.employment, 'part_time')
    assert.equal(formatWorkHours(pt.instructor.work_hours!), 'Tue, Thu 13:00-18:00; Sat 08:00-12:00')
    assert.equal(r.rows[3]!.year, 1) // "1st"
    assert.equal(r.rows[3]!.course.lab_units, 0)
    assert.equal(r.rows[4]!.instructor.name, '') // no instructor named; the database reports it
  })

  it('can treat a blank instructor as "same as the line above"', async () => {
    const table = await tableFromXlsx(new Blob([await readFile(fixture('teaching-load.xlsx'))]))
    const r = parseTeachingLoad(table, { fillDown: true })
    assert.equal(r.rows[1]!.instructor.name, 'Juan Dela Cruz')
    assert.equal(r.rows[3]!.instructor.name, 'Maria Santos') // named again, details left blank: the database already knows her
    assert.equal(r.rows[3]!.instructor.employment, undefined)
    assert.equal(r.rows[4]!.instructor.name, 'Maria Santos') // blank name: follows the line above, as asked
    assert.equal(r.rows[4]!.instructor.employment, undefined)
  })

  it('reads a semicolon CSV with a byte-order mark, Lec/Lab units and a combined year-and-section', async () => {
    const table = await tableFromCsv(await readFile(fixture('semicolon.csv'), 'utf8'))
    const r = parseTeachingLoad(table)
    assert.deepEqual(r.issues.filter((i) => i.level === 'error'), [])
    assert.equal(r.rows.length, 3)
    assert.deepEqual(r.rows.map((x) => [x.course.code, x.course.lecture_units, x.course.lab_units, x.year, x.section]), [
      ['IT 211', 2, 1, 2, 'A'],
      ['CHEM 101', 3, 1, 1, 'B'],
      ['MATH 101', 3, 0, 1, 'B'],
    ])
    assert.equal(r.rows[0]!.instructor.employment, 'full_time')
    assert.equal(r.rows[1]!.instructor.employment, 'part_time')
  })

  it('reads a bare-bones Excel sheet', async () => {
    const r = parseTeachingLoad(await tableFromXlsx(new Blob([await readFile(fixture('minimal.xlsx'))])))
    assert.deepEqual(r.rows.map((x) => [x.instructor.name, x.course.code, x.course.lecture_units, x.course.lab_units, x.program, x.year, x.section]), [['Ana Reyes', 'GE 101', 3, 0, 'BSIT', 1, 'A']])
    assert.ok(r.issues.some((i) => i.level === 'info' && /counted as lecture units/.test(i.message)))
  })

  it('parses the downloadable template without a single problem', async () => {
    const r = parseTeachingLoad(await tableFromCsv(templateCsv()))
    assert.deepEqual(r.issues, [])
    assert.equal(r.rows.length, 4)
    assert.equal(r.rows[2]!.course.room_type, 'Chemistry Laboratory')
    assert.equal(r.rows[2]!.instructor.max_weekly_hours, 12)
  })

  it('asks for what is missing, naming the columns', () => {
    const r = parseTeachingLoad([['Instructor', 'Course Code', 'Program', 'Year', 'Section']])
    assert.equal(r.rows.length, 0)
    assert.match(r.issues[0]!.message, /Units/)
    const noTitles = parseTeachingLoad([['a', 'b'], ['c', 'd']])
    assert.match(noTitles.issues[0]!.message, /column titles/)
  })

  it('reports each bad line by its number in the file and keeps the good ones', () => {
    const r = parseTeachingLoad([
      ['Instructor', 'Employment', 'Max Hours', 'Work Hours', 'Course Code', 'Lecture Units', 'Lab Units', 'Program', 'Year', 'Section', 'Students'],
      ['A', 'Full-time', '24', '', 'X 1', '3', '', 'BSIT', '1', 'A', ''], // fine
      ['B', 'sometimes', '', '', 'X 2', '3', '', 'BSIT', '1', 'A', ''],
      ['C', '', '99', '', 'X 3', '3', '', 'BSIT', '1', 'A', ''],
      ['D', '', '', 'whenever', 'X 4', '3', '', 'BSIT', '1', 'A', ''],
      ['E', '', '', '', '', '3', '', 'BSIT', '1', 'A', ''],
      ['F', '', '', '', 'X 6', '', '', 'BSIT', '1', 'A', ''],
      ['G', '', '', '', 'X 7', '3', '', '', '1', 'A', ''],
      ['H', '', '', '', 'X 8', '3', '', 'BSIT', '9', 'A', ''],
      ['I', '', '', '', 'X 9', '3', '', 'BSIT', '1', '', ''],
      ['J', '', '', '', 'X 10', 'three', '', 'BSIT', '1', 'A', ''],
      ['K', '', '', '', 'X 11', '3', '', 'BSIT', '1', 'A', 'many'],
      [],
      ['L', '', '', '', 'X 12', '3', '1', 'BSIT', '1', 'A', '40'], // fine
    ])
    assert.deepEqual(r.rows.map((x) => x.instructor.name), ['A', 'L'])
    const errors = r.issues.filter((i) => i.level === 'error')
    assert.deepEqual(errors.map((e) => e.row), [3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
    assert.match(errors[0]!.message, /Full-time or Part-time/)
    assert.match(errors[1]!.message, /1 to 60/)
    assert.match(errors[2]!.message, /Work hours/)
    assert.match(errors[3]!.message, /course code/)
    assert.match(errors[4]!.message, /no lecture or laboratory units/)
    assert.match(errors[5]!.message, /program/)
    assert.match(errors[6]!.message, /between 1 and 6/)
    assert.match(errors[7]!.message, /section/)
    assert.match(errors[8]!.message, /lecture units/)
    assert.match(errors[9]!.message, /number of students/)
    assert.equal(r.rows[1]!.row, 14) // the blank line still counts, so row numbers match the spreadsheet
  })

  it('uses a total Units column as lecture units and warns when it disagrees with lecture + lab', () => {
    const r = parseTeachingLoad([
      ['Instructor', 'Course Code', 'Units', 'Lecture Units', 'Lab Units', 'Program', 'Year', 'Section'],
      ['A', 'X 1', '4', '2', '1', 'BSIT', '1', 'A'],
      ['B', 'X 2', '3', '2', '1', 'BSIT', '1', 'A'],
    ])
    assert.equal(r.rows.length, 2)
    assert.equal(r.issues.filter((i) => i.level === 'warning').length, 1)
    assert.equal(r.issues.find((i) => i.level === 'warning')!.row, 2)
  })

  it('leaves "any room" answers out and keeps real room types', () => {
    const r = parseTeachingLoad([
      ['Instructor', 'Course Code', 'Units', 'Room Type', 'Program', 'Year', 'Section'],
      ['A', 'X 1', '3', 'Lecture Room', 'BSIT', '1', 'A'],
      ['A', 'X 2', '3', 'none', 'BSIT', '1', 'A'],
      ['A', 'X 3', '3', 'Physics Laboratory', 'BSIT', '1', 'A'],
    ])
    assert.deepEqual(r.rows.map((x) => x.course.room_type), [undefined, undefined, 'Physics Laboratory'])
  })

  it('treats TBA as no instructor', () => {
    const r = parseTeachingLoad([
      ['Instructor', 'Course Code', 'Units', 'Program', 'Year', 'Section'],
      ['TBA', 'X 1', '3', 'BSIT', '1', 'A'],
    ])
    assert.equal(r.rows[0]!.instructor.name, '')
  })
})
