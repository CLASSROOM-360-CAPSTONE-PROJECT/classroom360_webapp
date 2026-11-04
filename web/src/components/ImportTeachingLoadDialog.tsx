import { useRef, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { Download, FileSpreadsheet, TriangleAlert } from 'lucide-react'
import { Modal } from '@/components/Modal'
import { Badge, Button, Notice, Table, TBody, THead, td, th } from '@/components/ui'
import { useActiveTerm } from '@/lib/api'
import { friendlyError } from '@/lib/errors'
import { facilityLabel } from '@/lib/format'
import { resolveInstructors, type InstructorRef } from '@/lib/import/classes'
import { readTable, FileProblem } from '@/lib/import/readTable'
import { classesTemplateCsv, downloadText, templateCsv } from '@/lib/import/template'
import { parseTeachingLoad, type ImportRow, type Issue } from '@/lib/import/teachingLoad'
import { supabase } from '@/lib/supabase'

interface PlanPart {
  component: 'lecture' | 'lab'
  code: string
  meetings: number
  minutes: number
  room_type: string | null
}
interface ResultRow {
  row: number
  instructor: string | null
  program: string
  course: string
  title: string
  year: number
  cohort: string
  students: number | null
  lecture_units: number
  lab_units: number
  plan: PlanPart[]
}
interface DbIssue {
  row: number | null
  level: 'error' | 'warning'
  message: string
}
interface Result {
  applied: boolean
  errors: number
  issues: DbIssue[]
  rows: ResultRow[]
  summary: {
    instructors_new: number
    instructors_updated: number
    courses_new: number
    courses_updated: number
    sections_new: number
    sections_updated: number
    weekly_hours: number
  }
}

interface Checked {
  fileName: string
  rows: ImportRow[]
  fileIssues: Issue[]
  result: Result | null
}

const MAX_SHOWN = 150

function planText(plan: PlanPart[]): string {
  return plan
    .map((p) => `${p.component === 'lab' ? 'Lab' : 'Lecture'} ${p.meetings} × ${p.minutes} min${p.room_type ? ` in a ${facilityLabel(p.room_type).toLowerCase()} room` : ''}`)
    .join(' · ')
}

function count(n: number, one: string, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`
}

/** the classes import says once, in total, how many classes have no instructor, not once per line */
const NO_INSTRUCTOR_NOTE = 'No instructor is assigned yet'
const withoutPerLineInstructorNotes = (r: Result): Result => ({ ...r, issues: r.issues.filter((i) => !i.message.startsWith(NO_INSTRUCTOR_NOTE)) })

/**
 * One dialog, two imports of the same kind of file.
 *  - 'teaching': the Instructors page. Adds instructors, courses and sections; unknown instructors are created.
 *  - 'classes': the Courses and classes page. Adds classes (and any course the catalog lacks) and gives them to instructors who
 *    are already in the system; it never creates an instructor, and leaves a class without one when the name is not found.
 */
export function ImportTeachingLoadDialog({
  open,
  onClose,
  onImported,
  mode = 'teaching',
}: {
  open: boolean
  onClose: () => void
  onImported: (summary: string) => void
  mode?: 'teaching' | 'classes'
}) {
  const classes = mode === 'classes'
  const { term } = useActiveTerm()
  const input = useRef<HTMLInputElement>(null)
  const [fillDown, setFillDown] = useState(false)
  const [checked, setChecked] = useState<Checked | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [lastFile, setLastFile] = useState<File | null>(null)

  const reset = () => {
    setChecked(null)
    setProblem(null)
    setLastFile(null)
    if (input.current) input.current.value = ''
  }
  const close = () => {
    reset()
    onClose()
  }

  /** read the file, check its columns here, then let the database check it against what already exists (changing nothing) */
  const check = useMutation({
    mutationFn: async ({ file, fill }: { file: File; fill: boolean }): Promise<Checked> => {
      const table = await readTable(file)
      const parsed = parseTeachingLoad(table, { fillDown: fill, classesOnly: classes })
      if (parsed.rows.length === 0) return { fileName: file.name, rows: [], fileIssues: parsed.issues, result: null }
      let rows = parsed.rows
      let fileIssues = parsed.issues
      if (classes) {
        // instructors are matched here, against the ones that exist, so the database never creates one from a file of classes
        const { data: people, error: peopleError } = await supabase.from('instructors').select('id, full_name, employee_no, email, is_active')
        if (peopleError) throw new Error(peopleError.message)
        const resolved = resolveInstructors(rows, (people ?? []) as InstructorRef[])
        rows = resolved.rows
        fileIssues = [...fileIssues, ...resolved.issues]
      }
      const { data, error } = await supabase.rpc('import_teaching_load', { p_term_id: term!.id, p_rows: rows, p_apply: false })
      if (error) throw new Error(error.message)
      const result = data as Result
      return { fileName: file.name, rows, fileIssues, result: classes ? withoutPerLineInstructorNotes(result) : result }
    },
    onMutate: () => setProblem(null),
    onSuccess: (c) => setChecked(c),
    onError: (err) => {
      setChecked(null)
      setProblem(err instanceof FileProblem ? err.message : friendlyError(err, 'The file could not be read.'))
    },
  })

  const apply = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.rpc('import_teaching_load', { p_term_id: term!.id, p_rows: checked!.rows, p_apply: true })
      if (error) throw new Error(error.message)
      return data as Result
    },
    onSuccess: (r) => {
      if (!r.applied) {
        setChecked((c) => (c ? { ...c, result: classes ? withoutPerLineInstructorNotes(r) : r } : c))
        setProblem('Nothing was imported because the database found a problem. See the list below.')
        return
      }
      const s = r.summary
      const changed = s.sections_updated + s.instructors_updated + s.courses_updated
      onImported(
        classes
          ? `Imported ${checked!.fileName}: ${count(checked!.rows.length, 'class', 'classes')}` +
              (s.courses_new > 0 ? `, ${count(s.courses_new, 'new course')}` : '') +
              (changed > 0 ? `, ${count(changed, 'existing record')} updated` : '') +
              '. Generate the schedule to place them.'
          : `Imported ${checked!.fileName}: ${count(s.sections_new, 'new section')}, ${count(s.instructors_new, 'new instructor')}, ${count(s.courses_new, 'new course')}` +
              (changed > 0 ? `, ${count(changed, 'existing record')} updated.` : '.'),
      )
      close()
    },
    onError: (err) => setProblem(friendlyError(err, 'The import failed and nothing was saved.')),
  })

  const choose = (file: File | undefined) => {
    if (!file) return
    setLastFile(file)
    check.mutate({ file, fill: fillDown })
  }

  const fileErrors = checked?.fileIssues.filter((i) => i.level === 'error') ?? []
  const dbErrors = checked?.result?.issues.filter((i) => i.level === 'error') ?? []
  const blocked = fileErrors.length + dbErrors.length > 0
  const result = checked?.result ?? null

  // everything worth telling the person, errors first
  const all: Array<{ row: number | null; level: 'error' | 'warning' | 'info'; message: string }> = [
    ...(checked?.fileIssues ?? []).map((i) => ({ row: i.row || null, level: i.level, message: i.message })),
    ...(result?.issues ?? []),
  ]
  const unassigned = classes && result ? result.rows.filter((r) => !r.instructor).length : 0
  if (unassigned > 0) {
    all.push({
      row: null,
      level: 'info',
      message: `${count(unassigned, 'class', 'classes')} will have no instructor yet. Choose one with Edit before generating the schedule, or the schedule cannot check instructor clashes for ${unassigned === 1 ? 'it' : 'them'}.`,
    })
  }
  const order = { error: 0, warning: 1, info: 2 } as const
  all.sort((a, b) => order[a.level] - order[b.level] || (a.row ?? 0) - (b.row ?? 0))

  return (
    <Modal
      open={open}
      onClose={close}
      wide
      title={classes ? 'Import classes' : 'Import teaching load'}
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            {result?.applied ? 'Close' : 'Cancel'}
          </Button>
          {checked && (
            <Button variant="secondary" onClick={reset}>
              Choose another file
            </Button>
          )}
          {result && (
            <Button onClick={() => apply.mutate()} busy={apply.isPending} disabled={blocked || result.rows.length === 0}>
              Import {classes ? count(result.rows.length, 'class', 'classes') : count(result.rows.length, 'line')}
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-4">
        {!term && <Notice tone="bad">There is no term yet. Add one before importing.</Notice>}

        {!checked && (
          <>
            <p className="text-ink-600">
              {classes ? (
                <>
                  Upload a CSV or Excel file with one line per class: the course and its units, the program, and the year and section that take it, and optionally the
                  instructor. A course that is not in the catalog yet is added too. Instructors are matched with the ones already in the
                  system; a name that is not found is left unassigned, and no instructor is ever created here.
                </>
              ) : (
                <>
                  Upload a CSV or Excel file with one line per class: the instructor, the course and its units, the program, and the year and section that take it. Instructors,
                  courses and sections that are not in the system yet are added, and ones that are already there are matched, not duplicated.
                </>
              )}
              {term && <> The classes are created for <strong>{term.name}</strong>.</>}
            </p>

            <div className="flex flex-wrap items-center gap-3">
              <input
                ref={input}
                type="file"
                accept=".csv,.xlsx,.xlsm,.tsv,.txt,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                onChange={(e) => choose(e.target.files?.[0])}
                disabled={!term || check.isPending}
                className="block max-w-full text-[14px] file:mr-3 file:h-9 file:cursor-pointer file:rounded-md file:border file:border-ink-200 file:bg-white file:px-3.5 file:text-[14px] file:font-medium hover:file:bg-ink-50"
                aria-label={classes ? 'Classes file' : 'Teaching load file'}
              />
              <Button variant="ghost" onClick={() => (classes ? downloadText('classes-template.csv', classesTemplateCsv()) : downloadText('teaching-load-template.csv', templateCsv()))}>
                <Download className="size-4" aria-hidden />
                Download a template
              </Button>
            </div>

            <label className="flex items-start gap-2 text-[14px]">
              <input type="checkbox" checked={fillDown} onChange={(e) => setFillDown(e.target.checked)} className="mt-0.5 size-4 accent-ink-900" />
              <span>
                A blank instructor cell means the same instructor as the line above
                <span className="block text-[13px] text-ink-500">Use this when your sheet names an instructor once and lists their classes underneath.</span>
              </span>
            </label>

            {check.isPending && (
              <p className="text-ink-600" role="status">
                Checking {lastFile?.name}…
              </p>
            )}
            {problem && <Notice tone="bad">{problem}</Notice>}

            <details className="rounded-md border border-ink-200 px-3 py-2 text-[14px]">
              <summary className="cursor-pointer font-medium">Which columns does the file need?</summary>
              <div className="mt-2 space-y-2 text-ink-600">
                <p>Column titles can be worded in your own way (for example “Faculty name”, “Subject code”, “Lec units”). The first sheet of an Excel file is used.</p>
                <ul className="list-disc space-y-1 pl-5">
                  <li>
                    <strong>Required:</strong> {classes ? '' : 'Instructor, '}Course code, Program (such as BSIT), Year and Section (or one “Year and section” column such as 3A), and units.
                  </li>
                  <li>
                    <strong>Units:</strong> “Lecture units” and “Lab units” (or “Lec/Lab” such as 2/1). 1 lecture unit is 1 hour a week; 1 lab unit is 3 hours. A single “Units” column counts as lecture units.
                  </li>
                  <li><strong>Room type:</strong> for a course that needs a special room, such as “Chemistry Laboratory” or “Computer Laboratory”. With lab units the lab part uses that room; without, every meeting does. Leave it blank for any room.</li>
                  {classes ? (
                    <li>
                      <strong>Instructor (optional):</strong> the name as it is on the Instructors page, or an Employee no. or Email to be sure which person. A name that is not found leaves the class
                      without an instructor; you can choose one later with Edit.
                    </li>
                  ) : (
                    <li><strong>Instructor details (optional):</strong> Employee no., Email, Employment (Full-time or Part-time), Max weekly hours, and Work hours such as “Mon-Fri 8:00-17:00; Sat 8:00-12:00”.</li>
                  )}
                  <li>
                    <strong>Also optional:</strong> Course title, Students (class size, to check room capacity).
                    {classes && ' A course already in the catalog is matched by its code; if the file gives different units or a different room type, the course is updated.'}
                  </li>
                </ul>
              </div>
            </details>
          </>
        )}

        {checked && (
          <>
            <div className="flex flex-wrap items-center gap-2 text-ink-600">
              <FileSpreadsheet className="size-4" aria-hidden />
              <span className="font-medium text-ink-900">{checked.fileName}</span>
              <span>· {count(checked.rows.length, 'line')} read</span>
            </div>

            {problem && <Notice tone="bad">{problem}</Notice>}

            {result && (
              <dl className="grid gap-px overflow-hidden rounded-lg border border-ink-200 bg-ink-200 sm:grid-cols-2 lg:grid-cols-4">
                {(classes
                  ? [
                      ['Classes', `${result.rows.length}` + (result.summary.sections_updated ? `, ${count(result.summary.sections_updated, 'section')} already there` : '')],
                      ['Courses', `${result.summary.courses_new} new` + (result.summary.courses_updated ? `, ${result.summary.courses_updated} changed` : '')],
                      ['With an instructor', `${result.rows.length - unassigned} of ${result.rows.length}`],
                      ['Teaching a week', `${result.summary.weekly_hours} hours`],
                    ]
                  : [
                      ['Sections', `${result.summary.sections_new} new` + (result.summary.sections_updated ? `, ${result.summary.sections_updated} changed` : '')],
                      ['Instructors', `${result.summary.instructors_new} new` + (result.summary.instructors_updated ? `, ${result.summary.instructors_updated} changed` : '')],
                      ['Courses', `${result.summary.courses_new} new` + (result.summary.courses_updated ? `, ${result.summary.courses_updated} changed` : '')],
                      ['Teaching a week', `${result.summary.weekly_hours} hours`],
                    ]
                ).map(([label, value]) => (
                  <div key={label} className="bg-white px-4 py-3">
                    <dt className="text-[13px] text-ink-500">{label}</dt>
                    <dd className="text-[17px] font-semibold">{value}</dd>
                  </div>
                ))}
              </dl>
            )}

            {blocked ? (
              <Notice tone="bad">
                {count(fileErrors.length + dbErrors.length, 'problem')} must be fixed before anything can be imported. Nothing has been saved. Correct the file and choose it again.
              </Notice>
            ) : result ? (
              <p className="text-ink-600">Nothing has been saved yet. Look it over, then import.</p>
            ) : null}

            {all.length > 0 && (
              <ul className="max-h-56 space-y-1 overflow-y-auto rounded-md border border-ink-200 p-2 text-[14px]" aria-label="Problems found">
                {all.map((i, k) => (
                  <li key={k} className="flex items-start gap-2">
                    <span className="mt-0.5 shrink-0">
                      {i.level === 'error' ? <Badge tone="bad">Error</Badge> : i.level === 'warning' ? <Badge tone="warn">Check</Badge> : <Badge>Note</Badge>}
                    </span>
                    <span>
                      {i.row ? <span className="text-ink-500">Line {i.row}: </span> : null}
                      {i.message}
                    </span>
                  </li>
                ))}
              </ul>
            )}

            {result && result.rows.length > 0 && (
              <div className="overflow-hidden rounded-md border border-ink-200">
                <Table>
                  <THead>
                    <tr>
                      <th className={th}>Line</th>
                      <th className={th}>Instructor</th>
                      <th className={th}>Course</th>
                      <th className={th}>Program, block</th>
                      <th className={th}>Students</th>
                      <th className={th}>Weekly meetings</th>
                    </tr>
                  </THead>
                  <TBody>
                    {result.rows.slice(0, MAX_SHOWN).map((r) => (
                      <tr key={r.row}>
                        <td className={`${td} text-ink-500`}>{r.row}</td>
                        <td className={td}>{r.instructor ?? <span className="inline-flex items-center gap-1 text-amber-800"><TriangleAlert className="size-3.5" aria-hidden />Not assigned</span>}</td>
                        <td className={td}>
                          <div className="font-medium">{r.course}</div>
                          <div className="text-[13px] text-ink-500">{r.title}</div>
                        </td>
                        <td className={td}>
                          {r.program}, {r.cohort}
                        </td>
                        <td className={td}>{r.students ?? <span className="text-ink-400">–</span>}</td>
                        <td className={td}>{planText(r.plan)}</td>
                      </tr>
                    ))}
                  </TBody>
                </Table>
                {result.rows.length > MAX_SHOWN && (
                  <p className="border-t border-ink-100 px-4 py-2 text-[13px] text-ink-500">Showing the first {MAX_SHOWN} of {result.rows.length} lines. All of them are imported.</p>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  )
}
