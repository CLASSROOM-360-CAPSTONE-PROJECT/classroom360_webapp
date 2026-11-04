/**
 * Reads the teaching-load sheet a registrar or program chair already has (one line per class: who teaches
 * which course to which year and section) and turns it into the rows import_teaching_load() takes.
 *
 * The sheet may come from CSV or Excel; by the time it gets here it is just a table of cells. Column titles
 * are matched loosely ("Instructor", "Faculty name" and "Professor" all mean the same thing), so most
 * existing sheets work without renaming anything.
 */
import { parseWorkHours, type WorkWindow } from './workHours.ts'

export type Level = 'error' | 'warning' | 'info'
export interface Issue {
  /** the row in the file (1 = the first line), or 0 for something about the whole file */
  row: number
  level: Level
  message: string
}

/** the shape import_teaching_load() reads */
export interface ImportRow {
  row: number
  instructor: {
    name: string
    employee_no?: string
    email?: string
    employment?: 'full_time' | 'part_time'
    max_weekly_hours?: number
    work_hours?: WorkWindow[]
  }
  course: {
    code: string
    title?: string
    lecture_units: number
    lab_units: number
    room_type?: string
  }
  program: string
  year: number
  section: string
  students?: number
}

export interface ParsedLoad {
  rows: ImportRow[]
  issues: Issue[]
  /** columns of the file that were not recognised and so ignored */
  ignored: string[]
  /** the line the column titles were found on */
  headerRow: number
}

type Field =
  | 'instructor' | 'employeeNo' | 'email' | 'employment' | 'maxHours' | 'workHours'
  | 'courseCode' | 'courseTitle' | 'lectureUnits' | 'labUnits' | 'units' | 'lecLab' | 'roomType'
  | 'program' | 'year' | 'section' | 'yearSection' | 'students'

/** normalised column title -> field. Titles are lower-cased with everything but letters and digits turned into single spaces. */
const ALIASES: Record<Field, string[]> = {
  instructor: ['instructor', 'instructor name', 'name of instructor', 'professor', 'professor name', 'faculty', 'faculty name', 'teacher', 'teacher name', 'assigned instructor', 'handled by'],
  employeeNo: ['employee no', 'employee number', 'employee id', 'emp no', 'emp id', 'faculty id', 'faculty no', 'id no', 'instructor id', 'staff id'],
  email: ['email', 'e mail', 'email address', 'instructor email'],
  employment: ['employment', 'employment type', 'employment status', 'status', 'type', 'ft pt', 'ft or pt', 'full time part time', 'faculty type', 'load type', 'instructor type'],
  maxHours: ['max hours', 'max weekly hours', 'maximum hours', 'maximum weekly hours', 'weekly hours', 'weekly load', 'max load', 'max teaching hours', 'teaching hours limit', 'hours per week', 'weekly teaching hours'],
  workHours: ['work hours', 'working hours', 'work schedule', 'working schedule', 'work time', 'working time', 'availability', 'available time', 'available times', 'time available', 'schedule availability', 'office hours'],
  courseCode: ['course code', 'subject code', 'code', 'course no', 'subject no', 'catalog no', 'course number', 'subject number'],
  courseTitle: ['course title', 'subject title', 'title', 'course description', 'subject description', 'description', 'subject', 'course name', 'subject name', 'descriptive title'],
  lectureUnits: ['lecture units', 'lec units', 'lecture', 'lec', 'lecture hours', 'lec hours', 'lecture unit'],
  labUnits: ['lab units', 'laboratory units', 'lab', 'laboratory', 'lab unit', 'laboratory unit', 'lab hours'],
  units: ['units', 'total units', 'credit units', 'credits', 'unit', 'credit'],
  lecLab: ['lec lab', 'lec lab units', 'lec lab hours', 'lecture lab', 'lecture laboratory', 'lec lab unit'],
  roomType: ['room type', 'required room', 'room requirement', 'room requirements', 'required room type', 'facility', 'facility needed', 'required facility', 'lab type', 'laboratory type', 'special room', 'room needed', 'type of room', 'venue'],
  program: ['program', 'program code', 'degree program', 'curriculum', 'program course', 'course program', 'degree', 'program name'],
  year: ['year', 'year level', 'yr', 'yr level', 'level'],
  section: ['section', 'sec', 'block', 'section block', 'class section'],
  yearSection: ['year and section', 'year section', 'year sec', 'yr sec', 'yr and sec', 'year level and section', 'year and block', 'year block'],
  students: ['students', 'no of students', 'number of students', 'enrollment', 'enrolment', 'class size', 'size', 'headcount', 'enrolled', 'population', 'total students', 'student count'],
}

/** Only these have to be in the file; everything else has a sensible default. */
const REQUIRED: Array<{ label: string; fields: Field[][] }> = [
  { label: 'Instructor', fields: [['instructor']] },
  { label: 'Course code', fields: [['courseCode']] },
  { label: 'Program', fields: [['program']] },
  { label: 'Year and section (a Year and a Section column, or one "Year and section" column)', fields: [['year', 'section'], ['yearSection']] },
  { label: 'Units (Lecture units and/or Lab units, or a total Units column)', fields: [['lectureUnits'], ['labUnits'], ['units'], ['lecLab']] },
]

const norm = (s: unknown) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

const ALIAS_INDEX = new Map<string, Field>()
for (const [field, names] of Object.entries(ALIASES) as Array<[Field, string[]]>) for (const n of names) ALIAS_INDEX.set(n, field)

/** a table cell as trimmed text */
export function cellText(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Math.round(v * 1000) / 1000)
  if (typeof v === 'boolean') return v ? 'yes' : 'no'
  if (v instanceof Date) {
    // a time typed into Excel ("8:00") arrives as a date; keep the clock part
    return Number.isNaN(v.getTime()) ? '' : `${String(v.getUTCHours()).padStart(2, '0')}:${String(v.getUTCMinutes()).padStart(2, '0')}`
  }
  return String(v).replace(/\s+/g, ' ').trim()
}

export function toNumber(text: string): number | null {
  const t = text.trim().replace(',', '.')
  if (!t) return null
  const m = /^(\d+(?:\.\d+)?)(?:\s*(?:units?|hrs?|hours?|u))?$/i.exec(t)
  return m ? Number(m[1]) : null
}

const ORDINAL_WORDS: Record<string, number> = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 }
const ROMAN: Record<string, number> = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6 }

/** "3", "3rd", "3rd year", "Year 3", "Third", "III" to a year level */
export function parseYear(text: string): number | null {
  const t = text.trim().toLowerCase().replace(/\byear\b|\byr\b|\blevel\b/g, '').replace(/[.\s]+/g, ' ').trim()
  if (!t) return null
  const d = /^(\d)(?:st|nd|rd|th)?$/.exec(t)
  if (d) return Number(d[1])
  if (t in ORDINAL_WORDS) return ORDINAL_WORDS[t]!
  if (t in ROMAN) return ROMAN[t]!
  return null
}

/** "3A", "3-A", "3 A", "BSIT 3-A", "Year 3 Section A" to a year level and section */
export function parseYearSection(text: string): { year: number; section: string } | null {
  const t = text.trim().replace(/\bsection\b|\bsec\b|\byear\b|\byr\b/gi, ' ').replace(/[-_/.,]+/g, ' ').replace(/\s+/g, ' ').trim()
  const m = /(?:^|\s)(\d)(?:st|nd|rd|th)?\s*([a-z0-9]{1,3})$/i.exec(t) ?? /^(\d)([a-z0-9]{1,3})$/i.exec(t)
  if (!m) return null
  return { year: Number(m[1]), section: m[2]!.toUpperCase() }
}

function parseEmployment(text: string): 'full_time' | 'part_time' | null {
  const t = norm(text)
  if (!t) return null
  if (/^(ft|full time|fulltime|full|regular|permanent|f t)$/.test(t)) return 'full_time'
  if (/^(pt|part time|parttime|part|ptl|part timer|adjunct|p t|contractual|lecturer)$/.test(t)) return 'part_time'
  return null
}

/** "2/1", "2+1", "2-1", "2 / 1", "2 1" to lecture and lab units */
export function parseLecLab(text: string): { lec: number; lab: number } | null {
  const m = /^(\d+(?:\.\d+)?)\s*(?:\/|\+|-|\s)\s*(\d+(?:\.\d+)?)$/.exec(text.trim())
  return m ? { lec: Number(m[1]), lab: Number(m[2]) } : null
}

/** blank and "lecture room" style answers mean "any ordinary room" */
export function parseRoomType(text: string): string | undefined {
  const t = norm(text)
  if (!t || /^(none|no|n a|na|any|any room|lecture|lecture room|classroom|regular|regular room|regular classroom|standard|tba|tbd|null)$/.test(t)) return undefined
  return text.trim()
}

const NO_INSTRUCTOR = /^(tba|tbd|n a|na|none|vacant|unassigned|-+)$/i

export interface ParseOptions {
  /** a blank instructor cell means "same instructor as the line above" (for sheets that name the instructor once) */
  fillDown?: boolean
  /**
   * The classes-only import: no Instructor column is needed, and nothing but the instructor's name (and employee number or
   * email, to tell two people with the same name apart) is read about them. Employment type, weekly limit and work hours
   * are left alone, because this import only assigns instructors who are already in the system.
   */
  classesOnly?: boolean
}

/** Finds the title line: the first of the top lines that has at least three recognisable column titles. */
function findHeader(table: unknown[][]): number {
  let best = -1
  let bestHits = 0
  for (let i = 0; i < Math.min(table.length, 15); i++) {
    const hits = new Set((table[i] ?? []).map((c) => ALIAS_INDEX.get(norm(c))).filter((f): f is Field => Boolean(f))).size
    if (hits >= 3 && hits > bestHits) {
      best = i
      bestHits = hits
    }
  }
  return best
}

export function parseTeachingLoad(table: unknown[][], options: ParseOptions = {}): ParsedLoad {
  const issues: Issue[] = []
  const headerIdx = findHeader(table)
  if (headerIdx < 0) {
    issues.push({
      row: 0,
      level: 'error',
      message: 'Could not find the column titles. The first lines of the file should include titles such as Instructor, Course code, Program, Year, Section and Units. Download the template to see an example.',
    })
    return { rows: [], issues, ignored: [], headerRow: 0 }
  }

  const header = table[headerIdx]!
  const col = new Map<Field, number>()
  const ignored: string[] = []
  header.forEach((cell, i) => {
    const title = cellText(cell)
    if (!title) return
    const field = ALIAS_INDEX.get(norm(title))
    if (!field) ignored.push(title)
    else if (!col.has(field)) col.set(field, i)
    else ignored.push(`${title} (a second column for the same thing)`)
  })

  const required = options.classesOnly ? REQUIRED.filter((r) => r.label !== 'Instructor') : REQUIRED
  const missing = required.filter((r) => !r.fields.some((set) => set.every((f) => col.has(f)))).map((r) => r.label)
  if (missing.length > 0) {
    issues.push({ row: 0, level: 'error', message: `The file has no column for: ${missing.join('; ')}.` })
    return { rows: [], issues, ignored, headerRow: headerIdx + 1 }
  }
  if (ignored.length > 0) issues.push({ row: 0, level: 'info', message: `Ignored columns: ${ignored.join(', ')}.` })
  if (options.classesOnly) {
    const unused = (['employment', 'maxHours', 'workHours'] as Field[]).filter((f) => col.has(f)).map((f) => header.map(cellText)[col.get(f)!])
    if (unused.length > 0) {
      issues.push({
        row: 0,
        level: 'info',
        message: `Ignored here: ${unused.join(', ')}. This import only gives classes to instructors who are already in the system. To add instructors or change their hours, use Import from file on the Instructors page.`,
      })
    }
  }

  const hasLecLabSplit = col.has('lectureUnits') || col.has('labUnits') || col.has('lecLab')
  if (col.has('units') && !hasLecLabSplit) {
    issues.push({
      row: 0,
      level: 'info',
      message: 'The file has only a total Units column, so all units are counted as lecture units. Add a Lab units column for courses with a laboratory (1 lab unit = 3 hours).',
    })
  }

  const get = (line: unknown[], f: Field) => (col.has(f) ? cellText(line[col.get(f)!]) : '')
  const rows: ImportRow[] = []
  let lastInstructor: ImportRow['instructor'] | null = null

  for (let i = headerIdx + 1; i < table.length; i++) {
    const line = table[i] ?? []
    if (line.every((c) => cellText(c) === '')) continue
    const row = i + 1
    const fail = (message: string) => issues.push({ row, level: 'error', message })
    let bad = false

    // ---- instructor
    let name = get(line, 'instructor')
    let instructor: ImportRow['instructor']
    if (!name && options.fillDown && lastInstructor) {
      instructor = { ...lastInstructor }
    } else {
      if (NO_INSTRUCTOR.test(name)) name = ''
      instructor = { name }
      const emp = get(line, 'employeeNo')
      if (emp) instructor.employee_no = emp
      const email = get(line, 'email')
      if (email) instructor.email = email
      const empText = options.classesOnly ? '' : get(line, 'employment')
      if (empText) {
        const e = parseEmployment(empText)
        if (e) instructor.employment = e
        else {
          fail(`"${empText}" is not an employment type. Use Full-time or Part-time (FT or PT).`)
          bad = true
        }
      }
      const maxText = options.classesOnly ? '' : get(line, 'maxHours')
      if (maxText) {
        const n = toNumber(maxText)
        if (n === null || !Number.isInteger(n) || n < 1 || n > 60) {
          fail(`"${maxText}" is not a valid weekly teaching limit (a whole number of hours from 1 to 60).`)
          bad = true
        } else instructor.max_weekly_hours = n
      }
      const whText = options.classesOnly ? '' : get(line, 'workHours')
      if (whText) {
        const wh = parseWorkHours(whText)
        if (wh.errors.length > 0) {
          fail(`Work hours: ${wh.errors[0]}`)
          bad = true
        } else if (wh.windows.length > 0) instructor.work_hours = wh.windows
      }
      if (name) lastInstructor = instructor
    }

    // ---- course and units
    const code = get(line, 'courseCode').toUpperCase()
    if (!code) {
      fail('The course code is missing.')
      continue
    }
    let lec = 0
    let lab = 0
    const lecText = get(line, 'lectureUnits')
    const labText = get(line, 'labUnits')
    const splitText = get(line, 'lecLab')
    const totalText = get(line, 'units')
    if (splitText && !lecText && !labText) {
      const s = parseLecLab(splitText)
      if (!s) {
        fail(`"${splitText}" is not lecture/lab units (write it like 2/1).`)
        bad = true
      } else {
        lec = s.lec
        lab = s.lab
      }
    } else {
      if (lecText) {
        const n = toNumber(lecText)
        if (n === null) {
          fail(`"${lecText}" is not a number of lecture units.`)
          bad = true
        } else lec = n
      }
      if (labText) {
        const n = toNumber(labText)
        if (n === null) {
          fail(`"${labText}" is not a number of laboratory units.`)
          bad = true
        } else lab = n
      }
      if (!lecText && !labText && totalText) {
        const n = toNumber(totalText)
        if (n === null) {
          fail(`"${totalText}" is not a number of units.`)
          bad = true
        } else lec = n
      } else if (totalText && (lecText || labText)) {
        const n = toNumber(totalText)
        if (n !== null && Math.abs(n - (lec + lab)) > 0.001) {
          issues.push({ row, level: 'warning', message: `${code}: Units is ${n} but lecture + lab units add up to ${lec + lab}. The lecture and lab units were used.` })
        }
      }
    }
    if (!bad && lec + lab === 0) {
      fail(`${code} has no lecture or laboratory units.`)
      bad = true
    }

    // ---- program, year, section
    const program = get(line, 'program').toUpperCase()
    if (!program) {
      fail('The program is missing.')
      bad = true
    }
    let year: number | null = null
    let section = ''
    if (col.has('year') && col.has('section')) {
      const yText = get(line, 'year')
      year = parseYear(yText)
      section = get(line, 'section').toUpperCase()
      if (year === null) {
        // some sheets put "3A" in the Section column and leave Year out
        const combined = parseYearSection(section)
        if (!yText && combined) {
          year = combined.year
          section = combined.section
        } else {
          fail(yText ? `"${yText}" is not a year level (use 1 to 6).` : 'The year level is missing.')
          bad = true
        }
      }
    } else if (col.has('yearSection')) {
      const ys = get(line, 'yearSection')
      const parsed = parseYearSection(ys)
      if (!parsed) {
        fail(ys ? `"${ys}" is not a year and section (write it like 3A or 3-A).` : 'The year and section are missing.')
        bad = true
      } else {
        year = parsed.year
        section = parsed.section
      }
    }
    if (!bad && year !== null && (year < 1 || year > 6)) {
      fail(`Year ${year} is not between 1 and 6.`)
      bad = true
    }
    if (!bad && !section) {
      fail('The section is missing.')
      bad = true
    }

    // ---- students
    let students: number | undefined
    const stText = get(line, 'students')
    if (stText) {
      const n = toNumber(stText)
      if (n === null || !Number.isInteger(n) || n < 0) {
        fail(`"${stText}" is not a number of students.`)
        bad = true
      } else students = n
    }

    if (bad) continue
    const course: ImportRow['course'] = { code, lecture_units: lec, lab_units: lab }
    const title = get(line, 'courseTitle')
    if (title) course.title = title
    const room = parseRoomType(get(line, 'roomType'))
    if (room) course.room_type = room

    const out: ImportRow = { row, instructor, course, program, year: year!, section }
    if (students !== undefined) out.students = students
    rows.push(out)
  }

  if (rows.length === 0 && !issues.some((x) => x.level === 'error')) {
    issues.push({ row: 0, level: 'error', message: 'The file has titles but no lines of data under them.' })
  }
  return { rows, issues, ignored, headerRow: headerIdx + 1 }
}

/** a short description of one row's units, for the preview ("Lecture 2 + Lab 1") */
export function unitsText(c: { lecture_units: number; lab_units: number }): string {
  const parts: string[] = []
  if (c.lecture_units > 0) parts.push(`Lecture ${c.lecture_units}`)
  if (c.lab_units > 0) parts.push(`Lab ${c.lab_units}`)
  return parts.join(' + ')
}
