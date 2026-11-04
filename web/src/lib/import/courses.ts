/**
 * Reads a course list (code, title, units, room type, department) into rows ready to add to the course catalog.
 *
 * Nothing here talks to the database. The same checks the Add course form makes are made here: a code and a
 * title, units that are numbers from 0 to 12 with something above zero in total. A chair may add courses to
 * their own department only, which is also what the database enforces.
 */
import { normFacility } from '../facilities.ts'
import { Grouped, lineList, locateColumns, MAX_ROWS, normTitle } from './columns.ts'
import { cellText, parseLecLab, parseRoomType, toNumber, type Issue } from './teachingLoad.ts'

export interface DepartmentRef {
  id: string
  code: string
  name: string
}

export interface CourseContext {
  departments: DepartmentRef[]
  /** the departments the person may add courses to; null when any department is allowed */
  allowedDepartmentIds: string[] | null
  /** the department for lines that do not name one; null means no department */
  defaultDepartmentId: string | null
  /** codes of the courses that are already in the catalog */
  existingCodes: string[]
  /** room types at least one room has, in the database spelling (computer_lab) */
  knownRoomTypes: string[]
}

export interface CourseRow {
  /** the line in the file (1 = the first line) */
  row: number
  code: string
  title: string
  department: DepartmentRef | null
  lecture_units: number
  lab_units: number
  /** the room type in the database spelling, or null for any room */
  room_type: string | null
}

export interface ParsedCourses {
  rows: CourseRow[]
  issues: Issue[]
  /** lines left out because the course is already in the catalog */
  skipped: number
}

type Field = 'code' | 'title' | 'department' | 'lectureUnits' | 'labUnits' | 'units' | 'lecLab' | 'roomType'

const ALIASES: Record<Field, string[]> = {
  code: ['course code', 'subject code', 'code', 'course no', 'subject no', 'catalog no', 'course number', 'subject number', 'course'],
  title: ['course title', 'subject title', 'title', 'course description', 'subject description', 'description', 'course name', 'subject name', 'descriptive title', 'name', 'subject'],
  department: ['department', 'department code', 'dept', 'dept code', 'department name', 'college', 'school', 'offering department', 'offered by'],
  lectureUnits: ['lecture units', 'lec units', 'lecture', 'lec', 'lecture hours', 'lec hours', 'lecture unit'],
  labUnits: ['lab units', 'laboratory units', 'lab', 'laboratory', 'lab unit', 'laboratory unit', 'lab hours'],
  units: ['units', 'total units', 'credit units', 'credits', 'unit', 'credit'],
  lecLab: ['lec lab', 'lec lab units', 'lec lab hours', 'lecture lab', 'lecture laboratory', 'lec lab unit'],
  roomType: ['room type', 'required room', 'room requirement', 'room requirements', 'required room type', 'facility', 'facility needed', 'required facility', 'lab type', 'laboratory type', 'special room', 'room needed', 'type of room', 'venue'],
}

const MAX_CODE = 30
const MAX_TITLE = 120

/** units are stored with one decimal place */
const oneDecimal = (n: number) => Math.abs(Math.round(n * 10) / 10 - n) < 1e-9

export function parseCourses(table: unknown[][], ctx: CourseContext): ParsedCourses {
  const issues: Issue[] = []
  const located = locateColumns<Field>(table, ALIASES, 3)
  const fail = (message: string): ParsedCourses => ({ rows: [], issues: [...issues, { row: 0, level: 'error', message }], skipped: 0 })
  if (!located) {
    return fail('Could not find the column titles. The first lines of the file should include titles such as Course code, Course title and Units. Download the template to see an example.')
  }
  const { headerIdx, col, ignored } = located

  const missing: string[] = []
  if (!col.has('code')) missing.push('Course code')
  if (!col.has('title')) missing.push('Course title')
  if (!col.has('lectureUnits') && !col.has('labUnits') && !col.has('units') && !col.has('lecLab')) {
    missing.push('Units (Lecture units and/or Lab units, or a total Units column)')
  }
  if (missing.length > 0) return fail(`The file has no column for: ${missing.join('; ')}.`)
  if (ignored.length > 0) issues.push({ row: 0, level: 'info', message: `Ignored columns: ${ignored.join(', ')}.` })

  const body = table.slice(headerIdx + 1).filter((line) => (line ?? []).some((c) => cellText(c) !== ''))
  if (body.length === 0) return fail('The file has titles but no lines of data under them.')
  if (body.length > MAX_ROWS) return fail(`The file has ${body.length} courses. Import at most ${MAX_ROWS} at a time.`)

  const hasSplit = col.has('lectureUnits') || col.has('labUnits') || col.has('lecLab')
  if (col.has('units') && !hasSplit) {
    issues.push({
      row: 0,
      level: 'info',
      message: 'The file has only a total Units column, so all units are counted as lecture units. Add a Lab units column for courses with a laboratory (1 lab unit = 3 hours a week).',
    })
  }

  const byDept = new Map<string, DepartmentRef>()
  for (const d of ctx.departments) {
    byDept.set(normTitle(d.code), d)
    byDept.set(normTitle(d.name), d)
  }
  const fallback = ctx.departments.find((d) => d.id === ctx.defaultDepartmentId) ?? null
  const allowed = ctx.allowedDepartmentIds ? new Set(ctx.allowedDepartmentIds) : null
  const deptList = ctx.departments.map((d) => d.code).join(', ')
  const existing = new Set(ctx.existingCodes.map((c) => c.trim().toLowerCase()))
  const knownTypes = new Set(ctx.knownRoomTypes)

  const seen = new Map<string, number>()
  const grouped = new Grouped()
  const skippedCodes: string[] = []
  const rows: CourseRow[] = []
  const get = (line: unknown[], f: Field) => (col.has(f) ? cellText(line[col.get(f)!]) : '')

  for (let i = headerIdx + 1; i < table.length; i++) {
    const line = table[i] ?? []
    if (line.every((c) => cellText(c) === '')) continue
    const row = i + 1
    const bad = (message: string) => issues.push({ row, level: 'error', message })
    let ok = true

    // ---- code and title
    const code = get(line, 'code').toUpperCase().replace(/\s+/g, ' ')
    if (!code) {
      bad('The course code is missing.')
      continue
    }
    if (code.length > MAX_CODE) {
      bad(`The course code "${code}" is longer than ${MAX_CODE} characters.`)
      continue
    }
    const key = code.toLowerCase()
    if (seen.has(key)) {
      bad(`Course ${code} is already on line ${seen.get(key)} of this file.`)
      continue
    }
    seen.set(key, row)
    if (existing.has(key)) {
      skippedCodes.push(code)
      continue
    }
    let title = get(line, 'title')
    if (!title) {
      bad(`${code}: the course title is missing.`)
      ok = false
    } else if (title.length > MAX_TITLE) title = title.slice(0, MAX_TITLE)

    // ---- units
    let lec = 0
    let lab = 0
    const lecText = get(line, 'lectureUnits')
    const labText = get(line, 'labUnits')
    const splitText = get(line, 'lecLab')
    const totalText = get(line, 'units')
    let unitsOk = true
    if (splitText && !lecText && !labText) {
      const s = parseLecLab(splitText)
      if (!s) {
        bad(`${code}: "${splitText}" is not lecture/lab units (write it like 2/1).`)
        unitsOk = false
      } else {
        lec = s.lec
        lab = s.lab
      }
    } else {
      if (lecText) {
        const n = toNumber(lecText)
        if (n === null) {
          bad(`${code}: "${lecText}" is not a number of lecture units.`)
          unitsOk = false
        } else lec = n
      }
      if (labText) {
        const n = toNumber(labText)
        if (n === null) {
          bad(`${code}: "${labText}" is not a number of laboratory units.`)
          unitsOk = false
        } else lab = n
      }
      if (!lecText && !labText && totalText) {
        const n = toNumber(totalText)
        if (n === null) {
          bad(`${code}: "${totalText}" is not a number of units.`)
          unitsOk = false
        } else lec = n
      } else if (totalText && (lecText || labText) && unitsOk) {
        const n = toNumber(totalText)
        if (n !== null && Math.abs(n - (lec + lab)) > 0.001) {
          issues.push({ row, level: 'warning', message: `${code}: Units is ${n} but lecture + lab units add up to ${lec + lab}. The lecture and lab units were used.` })
        }
      }
    }
    if (unitsOk) {
      if (lec > 12 || lab > 12) {
        bad(`${code}: ${Math.max(lec, lab)} units is a lot for one course (the most is 12). Check the numbers.`)
        unitsOk = false
      } else if (!oneDecimal(lec) || !oneDecimal(lab)) {
        bad(`${code}: units can have one decimal place at most.`)
        unitsOk = false
      } else if (lec + lab <= 0) {
        bad(`${code} has no lecture or laboratory units.`)
        unitsOk = false
      }
    }
    if (!unitsOk) ok = false

    // ---- department
    let department: DepartmentRef | null = fallback
    const dText = get(line, 'department')
    if (dText) {
      department = byDept.get(normTitle(dText)) ?? null
      if (!department) {
        bad(`${code}: the department "${dText}" is not in the system. The departments are: ${deptList || 'none yet'}.`)
        ok = false
      } else if (allowed && !allowed.has(department.id)) {
        bad(`${code}: you can add courses to your own department only, and ${department.code} is not it.`)
        ok = false
      }
    } else if (allowed && !fallback) {
      bad(`${code}: the department is missing.`)
      ok = false
    }
    if (!department && ok) grouped.add('nodept', 'info', row, (r) => `${r.length} ${r.length === 1 ? 'course has' : 'courses have'} no department (${lineList(r)}). Only an administrator or dean can edit those later.`)

    // ---- room type
    const rt = parseRoomType(get(line, 'roomType'))
    const roomType = rt ? normFacility(rt) || null : null
    if (roomType && !knownTypes.has(roomType)) {
      grouped.add(`type:${roomType}`, 'warning', row, (r) => `No room has the type "${rt}" yet (${lineList(r)}). The course is added anyway, but it cannot be placed in a timetable until a room with that type exists.`)
    }

    if (!ok) continue
    rows.push({ row, code, title, department, lecture_units: lec, lab_units: lab, room_type: roomType })
  }

  if (skippedCodes.length > 0) {
    const shown = skippedCodes.slice(0, 8).join(', ') + (skippedCodes.length > 8 ? `, and ${skippedCodes.length - 8} more` : '')
    issues.push({
      row: 0,
      level: 'warning',
      message: `${skippedCodes.length} ${skippedCodes.length === 1 ? 'course is' : 'courses are'} already in the catalog and ${skippedCodes.length === 1 ? 'was' : 'were'} left out: ${shown}. Existing courses are not changed by an import; use Edit to change one.`,
    })
  }
  issues.push(...grouped.issues())
  if (rows.length === 0 && skippedCodes.length === 0 && !issues.some((x) => x.level === 'error')) {
    issues.push({ row: 0, level: 'error', message: 'There is no course to add in this file.' })
  }
  return { rows, issues, skipped: skippedCodes.length }
}
