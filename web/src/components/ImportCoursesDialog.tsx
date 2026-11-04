import { useCallback, useMemo, useState } from 'react'
import { useAuth } from '@/auth/AuthProvider'
import { ImportFileDialog, plural } from '@/components/ImportFileDialog'
import { Badge, inputCls } from '@/components/ui'
import { unwrap } from '@/lib/api'
import { facilityLabel } from '@/lib/format'
import { parseCourses, type CourseRow, type DepartmentRef } from '@/lib/import/courses'
import { coursesTemplateCsv } from '@/lib/import/template'
import { supabase } from '@/lib/supabase'

/** Add many courses to the catalog at once from a CSV or Excel file. Courses already in the catalog are left out, never changed. */
export function ImportCoursesDialog({
  open,
  onClose,
  onImported,
  departments,
  anyDepartment,
  ownDepartmentId,
  existingCodes,
  knownRoomTypes,
}: {
  open: boolean
  onClose: () => void
  onImported: (text: string) => void
  departments: DepartmentRef[]
  /** an administrator or dean may add to any department; a program chair only to their own */
  anyDepartment: boolean
  ownDepartmentId: string | null
  existingCodes: string[]
  knownRoomTypes: string[]
}) {
  const { profile } = useAuth()
  const [chosen, setChosen] = useState('')
  const ownDepartment = departments.find((d) => d.id === ownDepartmentId) ?? null

  // a chair's courses always go to their department; for the others a lone department needs no choosing
  const defaultDepartmentId = anyDepartment
    ? chosen && departments.some((d) => d.id === chosen)
      ? chosen
      : departments.length === 1
        ? departments[0]!.id
        : null
    : (ownDepartment?.id ?? null)
  const ownId = ownDepartment?.id ?? null
  const allowedDepartmentIds = useMemo(() => (anyDepartment ? null : ownId ? [ownId] : []), [anyDepartment, ownId])

  const parse = useCallback(
    (table: unknown[][]) => parseCourses(table, { departments, allowedDepartmentIds, defaultDepartmentId, existingCodes, knownRoomTypes }),
    [departments, allowedDepartmentIds, defaultDepartmentId, existingCodes, knownRoomTypes],
  )

  return (
    <ImportFileDialog<CourseRow>
      open={open}
      onClose={onClose}
      onImported={onImported}
      title="Import courses"
      fileLabel="Courses file"
      noun={['course', 'courses']}
      template={{ filename: 'courses-template.csv', text: coursesTemplateCsv() }}
      blockedReason={!anyDepartment && !ownDepartment ? 'Your account is not linked to a department, so you cannot add courses. Ask an administrator.' : null}
      intro={
        <>
          Upload a CSV or Excel file with one line per course: its code, title and units, and optionally its department and room type. You see what would be added before anything
          is saved. Courses that are already in the catalog are left out, not changed.
          {!anyDepartment && ownDepartment && <> As a program chair you can add courses to {ownDepartment.code} only.</>}
        </>
      }
      options={
        anyDepartment && departments.length > 1 ? (
          <label className="block max-w-sm">
            <span className="mb-1 block text-[13px] font-medium text-ink-700">Department for lines that do not name one</span>
            <select value={defaultDepartmentId ?? ''} onChange={(e) => setChosen(e.target.value)} className={inputCls} aria-label="Department for lines that do not name one">
              <option value="">No department</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.code}: {d.name}
                </option>
              ))}
            </select>
          </label>
        ) : null
      }
      help={
        <>
          <p>Column titles can be worded in your own way (for example “Subject code”, “Lec units”). The first sheet of an Excel file is used.</p>
          <ul className="list-disc space-y-1 pl-5">
            <li><strong>Required:</strong> Course code, Course title, and units.</li>
            <li>
              <strong>Units:</strong> “Lecture units” and “Lab units” (or “Lec/Lab” such as 2/1). 1 lecture unit is 1 hour a week; 1 lab unit is 3 hours. A single “Units” column counts as lecture units. Each is at most 12.
            </li>
            <li><strong>Department:</strong> the department’s code or name. A line with none goes in the department chosen above{anyDepartment ? '' : ', which for a program chair is their own'}.</li>
            <li><strong>Room type:</strong> for a course that needs a special room, such as “Chemistry Laboratory”. With lab units the lab part uses that room; without, every meeting does. Leave it blank for any room.</li>
          </ul>
        </>
      }
      parse={parse}
      columns={[
        {
          head: 'Course',
          cell: (r) => (
            <>
              <div className="font-medium">{r.code}</div>
              <div className="text-[13px] text-ink-500">{r.title}</div>
            </>
          ),
        },
        { head: 'Department', cell: (r) => r.department?.code ?? <span className="text-ink-400">None</span> },
        { head: 'Lecture units', cell: (r) => r.lecture_units },
        { head: 'Lab units', cell: (r) => r.lab_units },
        { head: 'Room type', cell: (r) => (r.room_type ? <Badge>{facilityLabel(r.room_type)}</Badge> : <span className="text-ink-400">Any room</span>) },
      ]}
      summary={(rows, skipped) => [
        ['Courses to add', String(rows.length)],
        ['Already in the catalog', String(skipped)],
        ['With a laboratory part', String(rows.filter((r) => r.lab_units > 0).length)],
        ['Needing a special room', String(rows.filter((r) => r.room_type).length)],
      ]}
      apply={async (rows, fileName) => {
        // one insert, so either every course is added or none is
        await unwrap(
          supabase.from('courses').insert(
            rows.map((r) => ({
              tenant_id: profile!.tenant_id,
              code: r.code,
              title: r.title,
              department_id: r.department?.id ?? null,
              lecture_units: r.lecture_units,
              lab_units: r.lab_units,
              required_facility: r.room_type,
            })),
          ),
        )
        return `Imported ${fileName}: added ${plural(rows.length, 'course')} to the catalog.`
      }}
    />
  )
}
