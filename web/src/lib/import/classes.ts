/**
 * The classes import reuses the teaching-load importer (one line per class: course, program, year, section),
 * but it must not create instructors. This turns the instructor on each line into someone who is already in
 * the system, or into "no instructor yet" with one note per name that could not be matched.
 *
 * The matching mirrors what import_teaching_load() does (employee number, then email, then the exact name with
 * case and spacing ignored), so a line that is matched here is matched there and nothing new is created.
 */
import { lineList } from './columns.ts'
import type { ImportRow, Issue } from './teachingLoad.ts'

export interface InstructorRef {
  id: string
  full_name: string
  employee_no: string | null
  email: string | null
  is_active: boolean
}

const nameKey = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase()

export interface Resolved {
  rows: ImportRow[]
  issues: Issue[]
  /** lines that were given an instructor who is in the system */
  assigned: number
}

export function resolveInstructors(rows: ImportRow[], instructors: InstructorRef[]): Resolved {
  const byEmp = new Map<string, InstructorRef[]>()
  const byEmail = new Map<string, InstructorRef[]>()
  const byName = new Map<string, InstructorRef[]>()
  const push = (m: Map<string, InstructorRef[]>, k: string, i: InstructorRef) => m.set(k, [...(m.get(k) ?? []), i])
  for (const i of instructors) {
    if (i.employee_no) push(byEmp, i.employee_no, i)
    if (i.email) push(byEmail, i.email.toLowerCase(), i)
    push(byName, nameKey(i.full_name), i)
  }

  // one note per name, with the lines it was on
  const notes = new Map<string, { kind: 'unknown' | 'inactive' | 'ambiguous'; label: string; lines: number[] }>()
  const note = (kind: 'unknown' | 'inactive' | 'ambiguous', label: string, line: number) => {
    const k = `${kind}:${label.toLowerCase()}`
    const n = notes.get(k)
    if (n) n.lines.push(line)
    else notes.set(k, { kind, label, lines: [line] })
  }

  let assigned = 0
  const out = rows.map((r): ImportRow => {
    const { name, employee_no, email } = r.instructor
    if (!name && !employee_no && !email) return { ...r, instructor: { name: '' } }

    let found: InstructorRef[] = []
    if (employee_no) found = byEmp.get(employee_no) ?? []
    if (found.length === 0 && email) found = byEmail.get(email.toLowerCase()) ?? []
    if (found.length === 0 && name) found = byName.get(nameKey(name)) ?? []

    const label = name || employee_no || email || ''
    if (found.length === 0) {
      note('unknown', label, r.row)
      return { ...r, instructor: { name: '' } }
    }
    if (found.length > 1) {
      note('ambiguous', label, r.row)
      return { ...r, instructor: { name: '' } }
    }
    const who = found[0]!
    if (!who.is_active) {
      note('inactive', who.full_name, r.row)
      return { ...r, instructor: { name: '' } }
    }
    assigned++
    // give the database the instructor's own details so it picks exactly this person and changes nothing about them
    const instructor: ImportRow['instructor'] = { name: who.full_name }
    if (who.employee_no) instructor.employee_no = who.employee_no
    if (who.email) instructor.email = who.email
    return { ...r, instructor }
  })

  const issues: Issue[] = []
  for (const n of notes.values()) {
    const where = lineList(n.lines)
    if (n.kind === 'unknown') {
      issues.push({
        row: 0,
        level: 'warning',
        message: `The instructor "${n.label}" is not in the system (${where}). Those classes are imported without an instructor. Add the instructor on the Instructors page, then choose them with Edit.`,
      })
    } else if (n.kind === 'inactive') {
      issues.push({ row: 0, level: 'warning', message: `The instructor "${n.label}" is marked inactive (${where}). Those classes are imported without an instructor.` })
    } else {
      issues.push({
        row: 0,
        level: 'warning',
        message: `More than one instructor matches "${n.label}" (${where}). Those classes are imported without an instructor. Put the employee number in the file to say which one.`,
      })
    }
  }
  return { rows: out, issues, assigned }
}
