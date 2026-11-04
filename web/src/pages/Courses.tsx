import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { FileUp, LayoutGrid, Pencil, Plus, Rows3, Trash2 } from 'lucide-react'
import { useAuth } from '@/auth/AuthProvider'
import { ImportCoursesDialog } from '@/components/ImportCoursesDialog'
import { ImportTeachingLoadDialog } from '@/components/ImportTeachingLoadDialog'
import { Modal } from '@/components/Modal'
import { ResultNote, SearchInput, Segmented, SortTh, useSort } from '@/components/controls'
import { Badge, Button, EmptyState, ErrorNote, filterSelectCls, inputCls, Loading, Notice, Table, TBody, td, th, THead } from '@/components/ui'
import { Rivet } from '@/components/surfaces'
import { useStoredState } from '@/hooks/useStoredState'
import { cn } from '@/lib/cn'
import { unwrap, useActiveTerm, useDepartments, usePrograms } from '@/lib/api'
import { friendlyError } from '@/lib/errors'
import { facilityTitle, normFacilities, normFacility, ROOM_TYPE_PRESETS } from '@/lib/facilities'
import { facilityLabel } from '@/lib/format'
import { meetingPlan, planText, weeklyHours } from '@/lib/plan'
import { supabase } from '@/lib/supabase'
import { matchesQuery, sortRows } from '@/lib/tableView'
import type { Course, Instructor, ScheduleStatus, SectionRow } from '@/lib/types'

/* ---------- one class = a course taken by one student block (its lecture and lab parts are separate sections) ---------- */

interface ClassGroup {
  key: string
  parts: SectionRow[]
  course: { code: string; title: string } | null
  programId: string
  programCode: string
  year: number | null
  cohort: string | null
  students: number
  instructorId: string | null
  instructorName: string | null
  placed: number
  needed: number
  statuses: Set<ScheduleStatus>
}

function groupClasses(sections: SectionRow[]): ClassGroup[] {
  const map = new Map<string, ClassGroup>()
  for (const s of sections) {
    const key = [s.course_id, s.program_id, s.year_level ?? '', s.cohort ?? ''].join('|')
    let g = map.get(key)
    if (!g) {
      g = {
        key,
        parts: [],
        course: s.courses,
        programId: s.program_id,
        programCode: s.programs?.code ?? '',
        year: s.year_level,
        cohort: s.cohort,
        students: s.enrollment,
        instructorId: s.instructor_id,
        instructorName: s.instructors?.full_name ?? null,
        placed: 0,
        needed: 0,
        statuses: new Set(),
      }
      map.set(key, g)
    }
    g.parts.push(s)
    g.needed += s.meetings_per_week
    for (const e of s.schedule_entries ?? []) {
      if (e.status === 'returned') continue
      g.placed += 1
      g.statuses.add(e.status)
    }
  }
  for (const g of map.values()) g.parts.sort((a, b) => (a.component === b.component ? 0 : a.component === 'lecture' ? -1 : 1))
  return [...map.values()].sort((a, b) => (a.programCode + a.cohort + a.course?.code).localeCompare(b.programCode + b.cohort + b.course?.code))
}

interface ClassForm {
  editing: boolean
  program_id: string
  course_id: string
  year: string
  block: string
  students: string
  instructor_id: string
}

interface CourseForm {
  id?: string
  code: string
  title: string
  department_id: string
  lecture: string
  lab: string
  room_type: string
}

/** One small block for each weekly meeting of a class, filled as the scheduler places it. */
function MeetingPips({ placed, needed, published }: { placed: number; needed: number; published: boolean }) {
  const n = Math.min(Math.max(needed, 1), 12)
  return (
    <span className="inline-flex items-end gap-[3px]" aria-hidden>
      {Array.from({ length: n }, (_, i) => (
        <span key={i} className={cn('h-3.5 w-1.5 rounded-[1px]', i < placed ? (published ? 'bg-brass-500' : 'bg-ink-700') : 'bg-ink-200')} />
      ))}
    </span>
  )
}

const num = (t: string) => (t.trim() === '' ? NaN : Number(t))

export default function Courses() {
  const { profile } = useAuth()
  const qc = useQueryClient()
  const role = profile?.role
  const anyDepartment = role === 'admin' || role === 'dean'
  const canManage = role === 'admin' || role === 'dean' || role === 'program_chair'
  const { term } = useActiveTerm()
  const programs = usePrograms()
  const allDepartments = useDepartments()
  const departmentList = useMemo(() => (allDepartments.data ?? []).filter((d) => d.is_active), [allDepartments.data])

  const [notice, setNotice] = useState<{ tone: 'good' | 'bad'; text: string; items?: string[] } | null>(null)
  const [search, setSearch] = useState('')
  const [classShow, setClassShow] = useState<'all' | 'unassigned' | 'unplaced'>('all')
  const classSort = useSort<'course' | 'program' | 'students' | 'instructor' | 'placed'>('course')
  const [courseSearch, setCourseSearch] = useState('')
  const [courseDept, setCourseDept] = useState('')
  const courseSort = useSort<'code' | 'title' | 'dept' | 'lecture' | 'lab'>('code')
  const [catalogLayout, setCatalogLayout] = useStoredState('c360.courses.layout', 'cards', ['cards', 'table'] as const)
  const [classForm, setClassForm] = useState<ClassForm | null>(null)
  const [courseForm, setCourseForm] = useState<CourseForm | null>(null)
  const [confirmCourseDelete, setConfirmCourseDelete] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [removing, setRemoving] = useState<ClassGroup | null>(null)
  const [importingCourses, setImportingCourses] = useState(false)
  const [importingClasses, setImportingClasses] = useState(false)

  const courses = useQuery({
    queryKey: ['courses'],
    queryFn: () =>
      unwrap<Course[]>(
        supabase
          .from('courses')
          .select('id, code, title, units, lecture_units, lab_units, required_facility, department_id, departments(code)')
          .order('code'),
      ),
  })

  const sections = useQuery({
    queryKey: ['sections', term?.id],
    enabled: Boolean(term),
    queryFn: () =>
      unwrap<SectionRow[]>(
        supabase
          .from('sections')
          .select(
            'id, code, component, course_id, program_id, instructor_id, year_level, cohort, enrollment, meetings_per_week, minutes_per_meeting, courses(code, title), programs(code), instructors(full_name), schedule_entries(status)',
          )
          .eq('term_id', term!.id)
          .order('code'),
      ),
  })

  const instructors = useQuery({
    queryKey: ['instructor-options'],
    enabled: canManage,
    queryFn: () => unwrap<Pick<Instructor, 'id' | 'full_name' | 'employment_type' | 'is_active'>[]>(supabase.from('instructors').select('id, full_name, employment_type, is_active').eq('is_active', true).order('full_name')),
  })

  const roomTypes = useQuery({
    queryKey: ['room-types'],
    queryFn: () => unwrap<{ facilities: string[] }[]>(supabase.from('rooms').select('facilities')),
  })
  const knownTypes = normFacilities([...ROOM_TYPE_PRESETS, ...(roomTypes.data ?? []).flatMap((r) => r.facilities)])
  // for the import: the types rooms really have (a course needing any other type could not be placed yet)
  const roomsHaveTypes = useMemo(() => normFacilities((roomTypes.data ?? []).flatMap((r) => r.facilities)), [roomTypes.data])
  const existingCourseCodes = useMemo(() => (courses.data ?? []).map((c) => c.code), [courses.data])

  const programOptions = useMemo(
    () => (programs.data ?? []).filter((p) => anyDepartment || p.department_id === profile?.department_id),
    [programs.data, anyDepartment, profile?.department_id],
  )
  const canManageProgram = (programId: string) => programOptions.some((p) => p.id === programId)
  const canEditCourse = (c: Course) => anyDepartment || (role === 'program_chair' && c.department_id === profile?.department_id)

  // an old message goes away as soon as the person starts correcting the form
  useEffect(() => setFormError(null), [classForm, courseForm])
  useEffect(() => setConfirmCourseDelete(false), [courseForm?.id])

  const classes = useMemo(() => groupClasses(sections.data ?? []), [sections.data])
  const needle = search.trim()
  const classFiltering = Boolean(needle) || classShow !== 'all'
  const shownClasses = useMemo(() => {
    const kept = classes.filter(
      (g) =>
        (classShow === 'all' || (classShow === 'unassigned' ? !g.instructorId : g.placed === 0)) &&
        matchesQuery([g.course?.code, g.course?.title, g.programCode, g.cohort, g.instructorName].filter(Boolean).join(' '), needle),
    )
    if (!classSort.key) return kept
    const get = {
      course: (g: ClassGroup) => g.course?.code,
      program: (g: ClassGroup) => `${g.programCode} ${g.cohort ?? ''}`.trim(),
      students: (g: ClassGroup) => g.students,
      instructor: (g: ClassGroup) => g.instructorName,
      placed: (g: ClassGroup) => (g.needed ? g.placed / g.needed : 0),
    }[classSort.key]
    return sortRows(kept, get, classSort.dir)
  }, [classes, classShow, needle, classSort.key, classSort.dir])

  const allCourses = courses.data ?? []
  const courseFiltering = Boolean(courseSearch.trim()) || courseDept !== ''
  const courseDepartments = useMemo(() => [...new Set(allCourses.map((c) => c.departments?.code).filter((x): x is string => Boolean(x)))].sort(), [allCourses])
  const shownCourses = useMemo(() => {
    const kept = allCourses.filter(
      (c) =>
        (!courseDept || c.departments?.code === courseDept) &&
        matchesQuery(`${c.code} ${c.title} ${c.departments?.code ?? ''} ${c.required_facility ? facilityLabel(c.required_facility) : ''}`, courseSearch),
    )
    if (!courseSort.key) return kept
    const get = {
      code: (c: Course) => c.code,
      title: (c: Course) => c.title,
      dept: (c: Course) => c.departments?.code,
      lecture: (c: Course) => c.lecture_units,
      lab: (c: Course) => c.lab_units,
    }[courseSort.key]
    return sortRows(kept, get, courseSort.dir)
  }, [allCourses, courseDept, courseSearch, courseSort.key, courseSort.dir])

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['sections'] })
    void qc.invalidateQueries({ queryKey: ['courses'] })
    void qc.invalidateQueries({ queryKey: ['room-types'] })
    void qc.invalidateQueries({ queryKey: ['audit'] })
    void qc.invalidateQueries({ queryKey: ['instructors'] })
  }

  /* ---------- classes ---------- */

  const saveClass = useMutation({
    mutationFn: async (f: ClassForm) => {
      const r = await unwrap<{ created: boolean; sections: { code: string }[]; warnings: string[] }>(
        supabase.rpc('save_class', {
          p_term_id: term!.id,
          p_course_id: f.course_id,
          p_program_id: f.program_id,
          p_year: Number(f.year),
          p_block: f.block.trim(),
          p_students: f.students.trim() === '' ? null : Number(f.students),
          p_instructor_id: f.instructor_id || null,
        }),
      )
      return r
    },
    onSuccess: (r, f) => {
      const course = courses.data?.find((c) => c.id === f.course_id)
      setClassForm(null)
      setNotice({
        tone: 'good',
        text: `${r.created ? 'Added' : 'Saved'} ${course?.code ?? 'class'} for ${programs.data?.find((p) => p.id === f.program_id)?.code ?? ''} ${f.block.trim().toUpperCase()}: ${r.sections.map((s) => s.code).join(', ')}. Generate the schedule to place it.`,
        items: r.warnings,
      })
      refresh()
    },
    onError: (err) => setFormError(friendlyError(err, 'The class was not saved.')),
  })

  function submitClass(e: FormEvent) {
    e.preventDefault()
    if (!classForm) return
    setFormError(null)
    if (!classForm.program_id) return setFormError('Choose a program.')
    if (!classForm.course_id) return setFormError('Choose a course.')
    if (!classForm.block.trim()) return setFormError('Give the section, for example A.')
    const students = classForm.students.trim() === '' ? null : Number(classForm.students)
    if (students !== null && (!Number.isInteger(students) || students < 0)) return setFormError('The number of students must be a whole number.')
    saveClass.mutate(classForm)
  }

  const removeClass = useMutation({
    mutationFn: (g: ClassGroup) => unwrap<number>(supabase.rpc('delete_class', { p_section_id: g.parts[0]!.id })),
    onSuccess: (_n, g) => {
      setRemoving(null)
      setNotice({ tone: 'good', text: `Deleted ${g.course?.code ?? 'class'} for ${g.programCode} ${g.cohort ?? ''}, with its draft meetings.` })
      refresh()
    },
    onError: (err) => {
      setRemoving(null)
      setNotice({ tone: 'bad', text: friendlyError(err, 'The class was not deleted.') })
    },
  })

  const openClass = (g?: ClassGroup) => {
    setFormError(null)
    setNotice(null)
    if (g) {
      const year = g.year ?? 1
      const cohort = g.cohort ?? ''
      setClassForm({
        editing: true,
        program_id: g.programId,
        course_id: g.parts[0]!.course_id,
        year: String(year),
        block: cohort.startsWith(String(year)) ? cohort.slice(String(year).length) : cohort,
        students: String(g.students),
        instructor_id: g.instructorId ?? '',
      })
    } else {
      setClassForm({ editing: false, program_id: programOptions[0]?.id ?? '', course_id: '', year: '1', block: '', students: '', instructor_id: '' })
    }
  }

  /* ---------- courses ---------- */

  const saveCourse = useMutation({
    mutationFn: async (f: CourseForm) => {
      const row = {
        code: f.code.trim(),
        title: f.title.trim(),
        department_id: f.department_id || null,
        lecture_units: Number(f.lecture),
        lab_units: Number(f.lab),
        required_facility: normFacility(f.room_type) || null,
      }
      if (f.id) await unwrap(supabase.from('courses').update(row).eq('id', f.id))
      else await unwrap(supabase.from('courses').insert({ ...row, tenant_id: profile!.tenant_id }))
      return f.id ? `Saved course ${row.code}.` : `Added course ${row.code}.`
    },
    onSuccess: (text) => {
      setCourseForm(null)
      setNotice({ tone: 'good', text })
      refresh()
    },
    onError: (err) => setFormError(friendlyError(err, 'The course was not saved.')),
  })

  const removeCourse = useMutation({
    mutationFn: async (id: string) => {
      await unwrap(supabase.rpc('delete_course', { p_course_id: id }))
    },
    onSuccess: () => {
      const code = courseForm?.code ?? 'course'
      setCourseForm(null)
      setNotice({ tone: 'good', text: `Deleted course ${code}.` })
      refresh()
    },
    onError: (err) => {
      setConfirmCourseDelete(false)
      setFormError(friendlyError(err, 'The course was not deleted.'))
    },
  })

  function submitCourse(e: FormEvent) {
    e.preventDefault()
    if (!courseForm) return
    setFormError(null)
    if (!courseForm.code.trim() || !courseForm.title.trim()) return setFormError('Give the course a code and a title.')
    const lec = num(courseForm.lecture)
    const lab = num(courseForm.lab)
    if (Number.isNaN(lec) || Number.isNaN(lab) || lec < 0 || lab < 0) return setFormError('Units must be numbers, 0 or more.')
    if (lec > 12 || lab > 12) return setFormError('That is a lot of units. Check the numbers.')
    if (lec + lab <= 0) return setFormError('A course needs lecture units, lab units, or both.')
    saveCourse.mutate(courseForm)
  }

  const openCourse = (c?: Course) => {
    setFormError(null)
    setNotice(null)
    setCourseForm(
      c
        ? { id: c.id, code: c.code, title: c.title, department_id: c.department_id ?? '', lecture: String(c.lecture_units), lab: String(c.lab_units), room_type: c.required_facility ?? '' }
        : { code: '', title: '', department_id: anyDepartment ? '' : (profile?.department_id ?? ''), lecture: '3', lab: '0', room_type: '' },
    )
  }

  const selectedCourse = classForm ? courses.data?.find((c) => c.id === classForm.course_id) : undefined
  const classPlan = selectedCourse ? meetingPlan(selectedCourse.lecture_units, selectedCourse.lab_units) : []
  const coursePlan = courseForm ? meetingPlan(Math.max(num(courseForm.lecture) || 0, 0), Math.max(num(courseForm.lab) || 0, 0)) : []

  const totalPlaced = classes.reduce((n, g) => n + g.placed, 0)
  const totalNeeded = classes.reduce((n, g) => n + g.needed, 0)
  const gaugeCells = Math.min(Math.max(totalNeeded, 1), 60)
  const noInstructor = classes.filter((g) => !g.instructorId).length
  const notPlaced = classes.filter((g) => g.placed === 0).length

  return (
    <>
      <header className="mb-7 max-w-[64ch]">
        <h1 className="font-display text-[34px] font-semibold leading-none tracking-[-0.02em]">Courses and classes</h1>
        <p className="mt-2 text-ink-500">
          What has to be scheduled this term. A class is a course taken by one student block. Lecture units (1 unit = 1 hour) and lab units (1 unit = 3 hours) become its weekly meetings, and a lab part goes in a room of the course’s room type.
        </p>
      </header>

      {notice && (
        <Notice tone={notice.tone} onDismiss={() => setNotice(null)}>
          {notice.text}
          {notice.items && notice.items.length > 0 && (
            <ul className="mt-1 list-disc pl-5 text-[13px]">
              {notice.items.map((i) => (
                <li key={i}>{i}</li>
              ))}
            </ul>
          )}
        </Notice>
      )}

      <div className="space-y-9">
        {/* ---------- the class register: a dark head with the term's progress, a toolbar, the rows ---------- */}
        <section className="overflow-hidden rounded-lg bg-white shadow-[0_16px_28px_-22px_rgb(11_21_36/0.55)] ring-1 ring-ink-200">
          <div className="relative bg-ink-900 px-5 pb-5 pt-4 text-white">
            <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-3">
              <div>
                <h2 className="font-display text-[24px] font-semibold leading-8">{term ? `Classes, ${term.name}` : 'Classes'}</h2>
                <p className="text-[13.5px] text-ink-300">
                  {classes.length === 0 ? 'No classes are set for this term yet.' : `${classes.length} ${classes.length === 1 ? 'class' : 'classes'} to put on the timetable.`}
                </p>
              </div>
              {classes.length > 0 && (
                <dl className="flex gap-7">
                  <div className="flex flex-col-reverse">
                    <dt className="text-[12.5px] leading-4 text-ink-300">Without an instructor</dt>
                    <dd className={cn('font-display text-[24px] font-semibold leading-7', noInstructor > 0 ? 'text-amber-300' : 'text-white')}>{noInstructor}</dd>
                  </div>
                  <div className="flex flex-col-reverse">
                    <dt className="text-[12.5px] leading-4 text-ink-300">Not placed yet</dt>
                    <dd className={cn('font-display text-[24px] font-semibold leading-7', notPlaced > 0 ? 'text-amber-300' : 'text-white')}>{notPlaced}</dd>
                  </div>
                </dl>
              )}
            </div>
            {classes.length > 0 && (
              <div className="mt-4">
                <div className="mb-1.5 flex items-baseline justify-between text-[13px]">
                  <span className="text-ink-300">Meetings placed</span>
                  <span className="font-medium">
                    {totalPlaced} of {totalNeeded}
                  </span>
                </div>
                <div className="flex h-3 gap-[2px] overflow-hidden rounded-[3px] bg-ink-950/60 p-[2px] ring-1 ring-ink-700" aria-hidden>
                  {Array.from({ length: gaugeCells }, (_, i) => (
                    <span key={i} className={cn('flex-1 rounded-[1px]', i < Math.round((totalPlaced / Math.max(totalNeeded, 1)) * gaugeCells) ? 'bg-brass-400' : 'bg-ink-700')} />
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-x-3 gap-y-2.5 border-b border-ink-100 px-4 py-3">
            <SearchInput value={search} onChange={setSearch} label="Search classes" className="w-56" shortcut />
            {classes.length > 0 && (
              <Segmented
                label="Show classes"
                value={classShow}
                onChange={setClassShow}
                options={[
                  { value: 'all', label: 'All', count: classes.length },
                  { value: 'unassigned', label: 'No instructor', count: noInstructor },
                  { value: 'unplaced', label: 'Not placed', count: notPlaced },
                ]}
              />
            )}
            {classFiltering && <ResultNote shown={shownClasses.length} total={classes.length} noun={['class', 'classes']} />}
            {canManage && (
              <div className="ml-auto flex flex-wrap items-center gap-2">
                <Button
                  variant="secondary"
                  onClick={() => {
                    setNotice(null)
                    setImportingClasses(true)
                  }}
                  disabled={!term}
                >
                  <FileUp className="size-4" aria-hidden />
                  Import CSV
                </Button>
                <Button onClick={() => openClass()} disabled={!term || programOptions.length === 0 || (courses.data ?? []).length === 0}>
                  <Plus className="size-4" aria-hidden />
                  Add class
                </Button>
              </div>
            )}
          </div>

          {sections.isLoading || !term ? (
            <Loading rows={4} />
          ) : sections.error ? (
            <div className="p-4">
              <ErrorNote error={sections.error} onRetry={() => void sections.refetch()} />
            </div>
          ) : shownClasses.length === 0 ? (
            <EmptyState
              title={classFiltering ? 'No classes match' : 'No classes this term'}
              action={
                classFiltering ? (
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setSearch('')
                      setClassShow('all')
                    }}
                  >
                    Clear search and filters
                  </Button>
                ) : undefined
              }
            >
              {classFiltering ? 'Try a different course, program or instructor.' : canManage ? (
                <>
                  Use Add class, Import CSV to add many at once, or import a whole teaching-load file from <Link to="/instructors" className="underline">Instructors</Link>.
                </>
              ) : (
                'Classes you can see for the active term are listed here.'
              )}
            </EmptyState>
          ) : (
            <Table>
              <THead>
                <tr>
                  <SortTh label="Course" k="course" sort={classSort} />
                  <SortTh label="Program and block" k="program" sort={classSort} />
                  <SortTh label="Students" k="students" sort={classSort} />
                  <th className={th}>Meets</th>
                  <SortTh label="Instructor" k="instructor" sort={classSort} />
                  <SortTh label="Timetable" k="placed" sort={classSort} />
                  {canManage && (
                    <th className={th}>
                      <span className="sr-only">Actions</span>
                    </th>
                  )}
                </tr>
              </THead>
              <TBody>
                {shownClasses.map((g) => {
                  const mine = canManage && canManageProgram(g.programId)
                  return (
                    <tr key={g.key}>
                      <td className={cn(td, 'relative')}>
                        {(!g.instructorId || g.placed === 0) && <span aria-hidden className="absolute inset-y-2 left-0 w-[3px] rounded-r bg-amber-400" />}
                        <div className="flex items-baseline gap-2">
                          <span className="rounded-[3px] bg-brass-100 px-1.5 font-mono text-[13px] font-medium leading-5 text-brass-800">{g.course?.code}</span>
                        </div>
                        <div className="mt-1 text-[13px] text-ink-500">{g.course?.title}</div>
                      </td>
                      <td className={td}>
                        {g.programCode}
                        {g.cohort ? `, block ${g.cohort}` : ''}
                      </td>
                      <td className={td}>{g.students}</td>
                      <td className={td}>
                        <div className="flex flex-col gap-0.5 text-[13px]">
                          {g.parts.map((p) => (
                            <span key={p.id} className="inline-flex items-center gap-1.5">
                              {p.component === 'lab' && <Badge tone="brass">Lab</Badge>}
                              {p.meetings_per_week} × {p.minutes_per_meeting} min
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className={td}>
                        {g.instructorName ?? <span className="rounded-full border border-dashed border-amber-400 bg-amber-50 px-2 py-0.5 text-[12.5px] text-amber-800">Unassigned</span>}
                      </td>
                      <td className={td}>
                        {g.placed === 0 ? (
                          <span className="text-ink-400">Not placed yet</span>
                        ) : (
                          <span className="inline-flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[13px]">
                            <MeetingPips placed={g.placed} needed={g.needed} published={g.statuses.has('published')} />
                            {g.placed} of {g.needed} placed
                            {g.statuses.has('published') && <Badge tone="brass">Published</Badge>}
                          </span>
                        )}
                      </td>
                      {canManage && (
                        <td className={`${td} whitespace-nowrap text-right`}>
                          {mine && (
                            <>
                              <Button variant="ghost" onClick={() => openClass(g)} aria-label={`Edit ${g.course?.code} ${g.programCode} ${g.cohort ?? ''}`}>
                                <Pencil className="size-4" aria-hidden />
                                Edit
                              </Button>
                              <Button variant="ghost" onClick={() => setRemoving(g)} aria-label={`Delete ${g.course?.code} ${g.programCode} ${g.cohort ?? ''}`}>
                                <Trash2 className="size-4" aria-hidden />
                              </Button>
                            </>
                          )}
                        </td>
                      )}
                    </tr>
                  )
                })}
              </TBody>
            </Table>
          )}
        </section>

        {/* ---------- the catalog: a card drawer. Each course is an index card in it. ---------- */}
        <section className="overflow-hidden rounded-lg ring-1 ring-ink-300 shadow-[0_16px_28px_-22px_rgb(11_21_36/0.55)]">
          <div className="bg-white px-5 py-4">
            <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
              <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
                {/* the little brass holder on a drawer front, with the label slid into it */}
                <div className="relative rounded-[3px] border-2 border-brass-400 bg-brass-50 px-7 py-1 shadow-[inset_0_0_0_2px_#fff,0_1px_0_rgb(11_21_36/0.12)]">
                  <Rivet light className="left-2 top-1/2 -translate-y-1/2" />
                  <Rivet light className="right-2 top-1/2 -translate-y-1/2" />
                  <h2 className="font-display text-[20px] font-semibold leading-7 text-brass-800">Course catalog</h2>
                </div>
                <p className="text-[13.5px] text-ink-500">
                  {allCourses.length === 0 ? 'Nothing filed yet.' : `${allCourses.length} ${allCourses.length === 1 ? 'course' : 'courses'} on file.`}
                </p>
              </div>
              {canManage && (
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setNotice(null)
                      setImportingCourses(true)
                    }}
                  >
                    <FileUp className="size-4" aria-hidden />
                    Import CSV
                  </Button>
                  <Button variant="secondary" onClick={() => openCourse()}>
                    <Plus className="size-4" aria-hidden />
                    Add course
                  </Button>
                </div>
              )}
            </div>
            {allCourses.length > 0 && (
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <SearchInput value={courseSearch} onChange={setCourseSearch} label="Search courses" placeholder="Search code, title or type" className="w-full sm:w-72" />
                {courseDepartments.length > 1 && (
                  <select value={courseDept} onChange={(e) => setCourseDept(e.target.value)} aria-label="Department" className={filterSelectCls}>
                    <option value="">All departments</option>
                    {courseDepartments.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                )}
                {courseFiltering && <ResultNote shown={shownCourses.length} total={allCourses.length} noun={['course', 'courses']} />}
                <Segmented
                  label="Catalog layout"
                  value={catalogLayout}
                  onChange={setCatalogLayout}
                  className="ml-auto"
                  options={[
                    {
                      value: 'cards',
                      label: (
                        <>
                          <LayoutGrid className="size-4" aria-hidden />
                          Cards
                        </>
                      ),
                    },
                    {
                      value: 'table',
                      label: (
                        <>
                          <Rows3 className="size-4" aria-hidden />
                          Table
                        </>
                      ),
                    },
                  ]}
                />
              </div>
            )}
          </div>

          {courses.isLoading ? (
            <div className="border-t border-ink-100 bg-white">
              <Loading rows={4} />
            </div>
          ) : courses.error ? (
            <div className="border-t border-ink-100 bg-white p-4">
              <ErrorNote error={courses.error} onRetry={() => void courses.refetch()} />
            </div>
          ) : allCourses.length === 0 ? (
            <div className="border-t border-ink-100 bg-white">
              <EmptyState title="No courses yet">{canManage ? 'Use Add course to create the first one, or Import CSV to add many at once.' : 'Courses added to the institution will be listed here.'}</EmptyState>
            </div>
          ) : shownCourses.length === 0 ? (
            <div className="border-t border-ink-100 bg-white">
              <EmptyState
                title="No courses match"
                action={
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setCourseSearch('')
                      setCourseDept('')
                    }}
                  >
                    Clear search and filters
                  </Button>
                }
              >
                Try a different code, title or department.
              </EmptyState>
            </div>
          ) : catalogLayout === 'cards' ? (
            <ul className="grid gap-4 border-t border-ink-300 bg-ink-200 p-5 shadow-[inset_0_6px_10px_-6px_rgb(11_21_36/0.4)] sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
              {shownCourses.map((c) => (
                <li key={c.id} className="index-card relative flex min-h-[176px] flex-col rounded-[3px] bg-white pb-8 shadow-[0_1px_0_rgb(11_21_36/0.1),0_10px_14px_-10px_rgb(11_21_36/0.55)]">
                  <div className="flex h-[38px] items-center justify-between gap-3 px-3.5">
                    <span className="font-mono text-[15px] font-semibold tracking-tight text-ink-900">{c.code}</span>
                    <span className="text-[12.5px] text-ink-500">{c.departments?.code}</span>
                  </div>
                  <div className="px-3.5 pt-2.5 font-display text-[17.5px] font-medium leading-[23px] text-ink-900">{c.title}</div>
                  <div className="mt-auto flex flex-wrap items-end gap-x-4 gap-y-1 px-3.5 pt-4">
                    <span className="flex items-baseline gap-1">
                      <b className="font-mono text-[19px] font-semibold leading-6">{c.lecture_units}</b>
                      <span className="text-[12.5px] text-ink-500">lecture</span>
                    </span>
                    <span className={cn('flex items-baseline gap-1', c.lab_units === 0 && 'text-ink-300')}>
                      <b className="font-mono text-[19px] font-semibold leading-6">{c.lab_units}</b>
                      <span className={cn('text-[12.5px]', c.lab_units === 0 ? 'text-ink-300' : 'text-ink-500')}>lab</span>
                    </span>
                    {canManage && canEditCourse(c) && (
                      <Button variant="ghost" className="-mr-2 ml-auto -mb-1" onClick={() => openCourse(c)} aria-label={`Edit course ${c.code}`}>
                        <Pencil className="size-4" aria-hidden />
                        Edit
                      </Button>
                    )}
                  </div>
                  <div className="px-3.5 pt-1.5 text-[12.5px] text-ink-600">
                    {c.required_facility ? (
                      <span title={c.lab_units > 0 ? 'Needed for the laboratory part only' : 'Needed for every meeting'}>
                        <Badge>{facilityLabel(c.required_facility)}</Badge>
                        {c.lab_units > 0 && <span className="ml-1.5 text-ink-500">lab part</span>}
                      </span>
                    ) : (
                      <span className="text-ink-400">Any room</span>
                    )}
                  </div>
                  <span aria-hidden className="absolute bottom-2.5 left-1/2 size-3 -translate-x-1/2 rounded-full bg-ink-200 shadow-[inset_0_1px_2px_rgb(11_21_36/0.5)]" />
                </li>
              ))}
            </ul>
          ) : (
            <div className="border-t border-ink-100 bg-white">
              <Table>
                <THead>
                  <tr>
                    <SortTh label="Code" k="code" sort={courseSort} />
                    <SortTh label="Title" k="title" sort={courseSort} />
                    <SortTh label="Department" k="dept" sort={courseSort} />
                    <SortTh label="Lecture units" k="lecture" sort={courseSort} />
                    <SortTh label="Lab units" k="lab" sort={courseSort} />
                    <th className={th}>Room type</th>
                    {canManage && (
                      <th className={th}>
                        <span className="sr-only">Actions</span>
                      </th>
                    )}
                  </tr>
                </THead>
                <TBody>
                {shownCourses.map((c) => (
                  <tr key={c.id}>
                    <td className={`${td} font-medium`}>{c.code}</td>
                    <td className={td}>{c.title}</td>
                    <td className={td}>{c.departments?.code}</td>
                    <td className={td}>{c.lecture_units}</td>
                    <td className={td}>{c.lab_units}</td>
                    <td className={td}>
                      {c.required_facility ? (
                        <span title={c.lab_units > 0 ? 'Needed for the laboratory part only' : 'Needed for every meeting'}>
                          <Badge>{facilityLabel(c.required_facility)}</Badge>
                          {c.lab_units > 0 && <span className="ml-1.5 text-[12px] text-ink-500">lab part</span>}
                        </span>
                      ) : (
                        <span className="text-ink-400">Any room</span>
                      )}
                    </td>
                    {canManage && (
                      <td className={`${td} text-right`}>
                        {canEditCourse(c) && (
                          <Button variant="ghost" onClick={() => openCourse(c)} aria-label={`Edit course ${c.code}`}>
                            <Pencil className="size-4" aria-hidden />
                            Edit
                          </Button>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
                </TBody>
              </Table>
            </div>
          )}
        </section>
      </div>

      {/* ---------- import from a file ---------- */}
      {canManage && (
        <>
          <ImportCoursesDialog
            open={importingCourses}
            onClose={() => setImportingCourses(false)}
            departments={departmentList}
            anyDepartment={anyDepartment}
            ownDepartmentId={profile?.department_id ?? null}
            existingCodes={existingCourseCodes}
            knownRoomTypes={roomsHaveTypes}
            onImported={(text) => {
              setNotice({ tone: 'good', text })
              refresh()
            }}
          />
          <ImportTeachingLoadDialog
            mode="classes"
            open={importingClasses}
            onClose={() => setImportingClasses(false)}
            onImported={(text) => {
              setNotice({ tone: 'good', text })
              refresh()
            }}
          />
        </>
      )}

      {/* ---------- add or edit a class ---------- */}
      <Modal
        open={classForm !== null}
        onClose={() => setClassForm(null)}
        title={classForm?.editing ? 'Edit class' : 'Add class'}
        footer={
          <>
            <Button variant="ghost" onClick={() => setClassForm(null)}>
              Cancel
            </Button>
            <Button type="submit" form="class-form" busy={saveClass.isPending}>
              Save
            </Button>
          </>
        }
      >
        {classForm && (
          <form id="class-form" onSubmit={submitClass} className="space-y-3">
            <label className="block">
              <span className="mb-1 block text-[13px] font-medium text-ink-700">Course</span>
              <select value={classForm.course_id} disabled={classForm.editing} onChange={(e) => setClassForm({ ...classForm, course_id: e.target.value })} className={inputCls}>
                <option value="">Choose a course</option>
                {(courses.data ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.code}: {c.title}
                  </option>
                ))}
              </select>
            </label>
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="block sm:col-span-1">
                <span className="mb-1 block text-[13px] font-medium text-ink-700">Program</span>
                <select value={classForm.program_id} disabled={classForm.editing} onChange={(e) => setClassForm({ ...classForm, program_id: e.target.value })} className={inputCls}>
                  {programOptions.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.code}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-[13px] font-medium text-ink-700">Year level</span>
                <select value={classForm.year} disabled={classForm.editing} onChange={(e) => setClassForm({ ...classForm, year: e.target.value })} className={inputCls}>
                  {[1, 2, 3, 4, 5, 6].map((y) => (
                    <option key={y} value={y}>
                      {y}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-[13px] font-medium text-ink-700">Section</span>
                <input value={classForm.block} disabled={classForm.editing} onChange={(e) => setClassForm({ ...classForm, block: e.target.value })} className={inputCls} placeholder="A" maxLength={12} />
              </label>
            </div>
            <div className="grid gap-3 sm:grid-cols-[8rem_1fr]">
              <label className="block">
                <span className="mb-1 block text-[13px] font-medium text-ink-700">Students</span>
                <input type="number" min={0} value={classForm.students} onChange={(e) => setClassForm({ ...classForm, students: e.target.value })} className={inputCls} placeholder="35" />
              </label>
              <label className="block">
                <span className="mb-1 block text-[13px] font-medium text-ink-700">Instructor</span>
                <select value={classForm.instructor_id} onChange={(e) => setClassForm({ ...classForm, instructor_id: e.target.value })} className={inputCls}>
                  <option value="">Not assigned yet</option>
                  {(instructors.data ?? []).map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.full_name}
                      {i.employment_type === 'part_time' ? ' (part-time)' : ''}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {selectedCourse && (
              <p className="rounded-md bg-ink-50 px-3 py-2 text-[13px] text-ink-700">
                {planText(classPlan)}
                {selectedCourse.required_facility && (
                  <>
                    . {selectedCourse.lab_units > 0 ? 'The lab part needs' : 'Every meeting needs'} a {facilityLabel(selectedCourse.required_facility).toLowerCase()} room.
                  </>
                )}
              </p>
            )}
            {classForm.editing && <p className="text-[13px] text-ink-500">The course, program, year and section identify the class, so they cannot change. To change one, delete the class and add it again.</p>}
            {formError && <Notice tone="bad">{formError}</Notice>}
          </form>
        )}
      </Modal>

      {/* ---------- delete a class ---------- */}
      <Modal
        open={removing !== null}
        onClose={() => setRemoving(null)}
        title="Delete class"
        footer={
          <>
            <Button variant="ghost" onClick={() => setRemoving(null)}>
              Cancel
            </Button>
            <Button variant="danger" busy={removeClass.isPending} onClick={() => removing && removeClass.mutate(removing)}>
              Delete class
            </Button>
          </>
        }
      >
        {removing && (
          <p className="text-[14px] text-ink-700">
            Delete {removing.course?.code} for {removing.programCode} {removing.cohort}? Its draft meetings are removed too. A class with submitted, approved or published meetings cannot be
            deleted until the timetable is reopened.
          </p>
        )}
      </Modal>

      {/* ---------- add or edit a course ---------- */}
      <Modal
        open={courseForm !== null}
        onClose={() => setCourseForm(null)}
        title={courseForm?.id ? `Edit course ${courseForm.code}` : 'Add course'}
        footer={
          <>
            {courseForm?.id && (
              <Button variant="ghost" className="mr-auto text-rose-700" onClick={() => setConfirmCourseDelete(true)} disabled={removeCourse.isPending}>
                <Trash2 className="size-4" aria-hidden />
                Delete course
              </Button>
            )}
            <Button variant="ghost" onClick={() => setCourseForm(null)}>
              Cancel
            </Button>
            <Button type="submit" form="course-form" busy={saveCourse.isPending}>
              Save
            </Button>
          </>
        }
      >
        {courseForm && (
          <form id="course-form" onSubmit={submitCourse} className="space-y-3">
            {confirmCourseDelete && courseForm.id && (
              <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2.5 text-[14px] text-rose-950" role="alertdialog" aria-label="Confirm delete">
                <div className="font-medium">Delete course {courseForm.code} for good?</div>
                <p className="mt-0.5 text-[13px]">This cannot be undone. A course that has classes cannot be deleted: delete those classes first.</p>
                <div className="mt-2 flex gap-2">
                  <Button type="button" variant="danger" busy={removeCourse.isPending} onClick={() => removeCourse.mutate(courseForm.id!)}>
                    Yes, delete it
                  </Button>
                  <Button type="button" variant="secondary" onClick={() => setConfirmCourseDelete(false)}>
                    Keep it
                  </Button>
                </div>
              </div>
            )}
            <div className="grid gap-3 sm:grid-cols-[9rem_1fr]">
              <label className="block">
                <span className="mb-1 block text-[13px] font-medium text-ink-700">Course code</span>
                <input required value={courseForm.code} onChange={(e) => setCourseForm({ ...courseForm, code: e.target.value })} className={inputCls} placeholder="CHEM 101" />
              </label>
              <label className="block">
                <span className="mb-1 block text-[13px] font-medium text-ink-700">Title</span>
                <input required value={courseForm.title} onChange={(e) => setCourseForm({ ...courseForm, title: e.target.value })} className={inputCls} placeholder="General Chemistry" />
              </label>
            </div>
            {anyDepartment ? (
              <label className="block">
                <span className="mb-1 block text-[13px] font-medium text-ink-700">Department</span>
                <select value={courseForm.department_id} onChange={(e) => setCourseForm({ ...courseForm, department_id: e.target.value })} className={inputCls}>
                  <option value="">No department</option>
                  {departmentList.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.code}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <p className="text-[13px] text-ink-500">The course is added to your department.</p>
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="mb-1 block text-[13px] font-medium text-ink-700">Lecture units</span>
                <input type="number" min={0} step={0.5} value={courseForm.lecture} onChange={(e) => setCourseForm({ ...courseForm, lecture: e.target.value })} className={inputCls} />
              </label>
              <label className="block">
                <span className="mb-1 block text-[13px] font-medium text-ink-700">Lab units</span>
                <input type="number" min={0} step={0.5} value={courseForm.lab} onChange={(e) => setCourseForm({ ...courseForm, lab: e.target.value })} className={inputCls} />
              </label>
            </div>
            <label className="block">
              <span className="mb-1 block text-[13px] font-medium text-ink-700">Room type needed</span>
              <input
                list="room-type-list"
                value={courseForm.room_type}
                onChange={(e) => setCourseForm({ ...courseForm, room_type: e.target.value })}
                className={inputCls}
                placeholder="Leave empty for any room"
              />
              <datalist id="room-type-list">
                {knownTypes.map((t) => (
                  <option key={t} value={facilityTitle(t)} />
                ))}
              </datalist>
              <span className="mt-1 block text-[13px] text-ink-500">
                {num(courseForm.lab) > 0 ? 'Needed for the lab part; the lecture part can use any room.' : 'Needed for every meeting of this course.'}
              </span>
            </label>
            <p className="rounded-md bg-ink-50 px-3 py-2 text-[13px] text-ink-700">
              {coursePlan.length === 0 ? 'Enter the units to see the weekly meetings.' : `${weeklyHours(Math.max(num(courseForm.lecture) || 0, 0), Math.max(num(courseForm.lab) || 0, 0))} hours a week: ${planText(coursePlan)}`}
            </p>
            {courseForm.id && (
              <p className="text-[13px] text-ink-500">Classes that already exist keep their meetings until you open them and press Save, which applies the new units.</p>
            )}
            {formError && <Notice tone="bad">{formError}</Notice>}
          </form>
        )}
      </Modal>
    </>
  )
}
