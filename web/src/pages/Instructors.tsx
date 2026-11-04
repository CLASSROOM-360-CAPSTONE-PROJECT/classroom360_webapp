import { useMemo, useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { FileUp, LayoutGrid, Plus, Rows3 } from 'lucide-react'
import { useAuth } from '@/auth/AuthProvider'
import { ImportTeachingLoadDialog } from '@/components/ImportTeachingLoadDialog'
import { Modal } from '@/components/Modal'
import { ResultNote, SearchInput, Segmented, SortTh, useSort } from '@/components/controls'
import { Badge, Button, Card, EmptyState, ErrorNote, filterSelectCls, inputCls, Loading, Notice, Table, TBody, td, th, THead } from '@/components/ui'
import { useStoredState } from '@/hooks/useStoredState'
import { cn } from '@/lib/cn'
import { DAY_SHORT } from '@/lib/time'
import { windowHours, WorkHoursEditor, workHoursProblem } from '@/components/WorkHoursEditor'
import { unwrap, useActiveDepartments } from '@/lib/api'
import { friendlyError } from '@/lib/errors'
import { formatWorkHours, mergeWindows, type WorkWindow } from '@/lib/import/workHours'
import { supabase } from '@/lib/supabase'
import { matchesQuery, sortRows } from '@/lib/tableView'
import type { EmploymentType, Instructor, SchoolHour } from '@/lib/types'

interface Form {
  id?: string
  full_name: string
  employee_no: string
  email: string
  employment: EmploymentType
  max_weekly_hours: string
  department_id: string
  is_active: boolean
  restricted: boolean
  windows: WorkWindow[]
}

const DEFAULT_HOURS: Record<EmploymentType, string> = { full_time: '24', part_time: '12' }

const hhmm = (t: string) => t.slice(0, 5)

function blankForm(department_id: string): Form {
  return {
    full_name: '',
    employee_no: '',
    email: '',
    employment: 'full_time',
    max_weekly_hours: DEFAULT_HOURS.full_time,
    department_id,
    is_active: true,
    restricted: false,
    windows: [],
  }
}

function formFor(i: Instructor): Form {
  const windows = (i.instructor_work_hours ?? []).map((w) => ({ day_of_week: w.day_of_week, start_time: hhmm(w.start_time), end_time: hhmm(w.end_time) }))
  return {
    id: i.id,
    full_name: i.full_name,
    employee_no: i.employee_no ?? '',
    email: i.email ?? '',
    employment: i.employment_type,
    max_weekly_hours: String(i.max_weekly_hours),
    department_id: i.department_id ?? '',
    is_active: i.is_active,
    restricted: windows.length > 0,
    windows: mergeWindows(windows),
  }
}

const initialsOf = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .filter((_, i, all) => i === 0 || i === all.length - 1)
    .map((w) => w[0]!.toUpperCase())
    .join('')

const minutesOf = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5))

/**
 * The hours someone works, drawn as a week: one tall slot for each day from 7 AM to 9 PM, with the stretch they work
 * laid in brass. A person with no set hours has every slot hatched: any time the school is open.
 */
function WeekStrip({ windows }: { windows: Array<{ day_of_week: number; start_time: string; end_time: string }> }) {
  const from = 7 * 60
  const to = 21 * 60
  const any = windows.length > 0
  return (
    <div className="flex items-start gap-1.5" aria-hidden>
      {[1, 2, 3, 4, 5, 6].map((d) => (
        <div key={d} className="flex flex-1 flex-col items-center gap-1">
          <div className={cn('relative h-14 w-full overflow-hidden rounded-[3px] ring-1 ring-inset ring-ink-200', any ? 'bg-ink-50' : 'closed-hours')}>
            {windows
              .filter((w) => w.day_of_week === d)
              .map((w, i) => {
                const a = Math.min(Math.max(minutesOf(w.start_time), from), to)
                const b = Math.min(Math.max(minutesOf(w.end_time), from), to)
                return <span key={i} className="absolute inset-x-0 bg-brass-400" style={{ top: `${((a - from) / (to - from)) * 100}%`, height: `${Math.max(((b - a) / (to - from)) * 100, 3)}%` }} />
              })}
          </div>
          <span className="text-[11px] leading-3 text-ink-400">{DAY_SHORT[d - 1]!.slice(0, 1)}</span>
        </div>
      ))}
    </div>
  )
}

export default function Instructors() {
  const { profile } = useAuth()
  const qc = useQueryClient()
  const role = profile?.role
  const canSeeCards = role === 'admin' || role === 'dean'
  const anyDepartment = role === 'admin' || role === 'dean'
  const departments = useActiveDepartments()

  const [notice, setNotice] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null)
  const [form, setForm] = useState<Form | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const [search, setSearch] = useState('')
  const [kind, setKind] = useState<'all' | 'full' | 'part' | 'inactive'>('all')
  const [deptFilter, setDeptFilter] = useState('')
  const [layout, setLayout] = useStoredState('c360.instructors.layout', 'cards', ['cards', 'table'] as const)
  const sort = useSort<'name' | 'no' | 'dept' | 'type' | 'hours'>('name')

  const q = useQuery({
    queryKey: ['instructors'],
    queryFn: () =>
      unwrap<Instructor[]>(
        supabase
          .from('instructors')
          .select(
            'id, employee_no, full_name, email, max_weekly_hours, employment_type, is_active, profile_id, department_id, departments(code), rfid_cards(is_active), instructor_work_hours(day_of_week, start_time, end_time)',
          )
          .order('full_name'),
      ),
  })
  const schoolHours = useQuery({
    queryKey: ['school-hours'],
    queryFn: () => unwrap<SchoolHour[]>(supabase.from('school_hours').select('day_of_week, opens_at, closes_at').order('day_of_week')),
  })

  const canEdit = (i: Instructor) => anyDepartment || (role === 'program_chair' && i.department_id === profile?.department_id)

  const save = useMutation({
    mutationFn: async (f: Form) => {
      const windows = f.restricted ? mergeWindows(f.windows) : []
      await unwrap(
        supabase.rpc('save_instructor', {
          p_id: f.id ?? null,
          p_full_name: f.full_name,
          p_employee_no: f.employee_no,
          p_email: f.email,
          p_employment: f.employment,
          p_max_weekly_hours: Number(f.max_weekly_hours),
          p_work_hours: windows,
          p_department_id: anyDepartment && f.department_id ? f.department_id : null,
          p_is_active: f.is_active,
        }),
      )
      return f.id ? `Saved ${f.full_name.trim()}.` : `Added ${f.full_name.trim()}.`
    },
    onSuccess: (text) => {
      setForm(null)
      setNotice({ tone: 'good', text })
      void qc.invalidateQueries({ queryKey: ['instructors'] })
      void qc.invalidateQueries({ queryKey: ['audit'] })
    },
    onError: (err) => setFormError(friendlyError(err, 'The instructor was not saved.')),
  })

  function submit(e: FormEvent) {
    e.preventDefault()
    if (!form) return
    setFormError(null)
    const hours = Number(form.max_weekly_hours)
    if (!Number.isInteger(hours) || hours < 1 || hours > 60) {
      setFormError('Weekly teaching hours must be a whole number from 1 to 60.')
      return
    }
    if (form.restricted) {
      if (form.windows.length === 0) {
        setFormError('Tick at least one working day, or choose “Any time the school is open”.')
        return
      }
      const problem = workHoursProblem(form.windows)
      if (problem) {
        setFormError(problem)
        return
      }
    }
    save.mutate(form)
  }

  const everyone = q.data ?? []
  const filtering = Boolean(search.trim()) || kind !== 'all' || deptFilter !== ''
  const departmentsInUse = useMemo(() => [...new Set(everyone.map((i) => i.departments?.code).filter((c): c is string => Boolean(c)))].sort(), [everyone])
  const counts = useMemo(
    () => ({
      all: everyone.length,
      full: everyone.filter((i) => i.employment_type === 'full_time').length,
      part: everyone.filter((i) => i.employment_type === 'part_time').length,
      inactive: everyone.filter((i) => !i.is_active).length,
    }),
    [everyone],
  )
  const list = useMemo(() => {
    const kept = everyone.filter(
      (i) =>
        (kind === 'all' || (kind === 'full' ? i.employment_type === 'full_time' : kind === 'part' ? i.employment_type === 'part_time' : !i.is_active)) &&
        (!deptFilter || i.departments?.code === deptFilter) &&
        matchesQuery(`${i.full_name} ${i.employee_no ?? ''} ${i.email ?? ''}`, search),
    )
    if (!sort.key) return kept
    const get = {
      name: (i: Instructor) => i.full_name,
      no: (i: Instructor) => i.employee_no,
      dept: (i: Instructor) => i.departments?.code,
      type: (i: Instructor) => i.employment_type,
      hours: (i: Instructor) => i.max_weekly_hours,
    }[sort.key]
    return sortRows(kept, get, sort.dir)
  }, [everyone, kind, deptFilter, search, sort.key, sort.dir])
  const clearFilters = () => {
    setSearch('')
    setKind('all')
    setDeptFilter('')
  }

  const formHours = form?.restricted ? windowHours(form.windows) : null
  const limit = Number(form?.max_weekly_hours)

  return (
    <>
      <header className="mb-7 flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
        <div className="min-w-0 max-w-[62ch]">
          <h1 className="font-display text-[34px] font-semibold leading-none tracking-[-0.02em]">Instructors</h1>
          <p className="mt-2 text-ink-500">
            Teaching staff the scheduler can assign. Full-time and part-time instructors, the hours each one works, and how many hours they may teach in a week all shape the timetable.
          </p>
          {everyone.length > 0 && (
            <dl className="mt-4 flex flex-wrap gap-x-7 gap-y-2">
              {[
                { label: everyone.length === 1 ? 'Instructor' : 'Instructors', value: everyone.length },
                { label: 'Full-time', value: counts.full },
                { label: 'Part-time', value: counts.part },
                { label: 'Teaching hours a week, at most', value: everyone.filter((i) => i.is_active).reduce((n, i) => n + i.max_weekly_hours, 0) },
              ].map((f) => (
                <div key={f.label} className="flex flex-col-reverse">
                  <dt className="text-[12.5px] leading-4 text-ink-500">{f.label}</dt>
                  <dd className="font-display text-[26px] font-semibold leading-8">{f.value}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <>
            <Button variant="secondary" onClick={() => setImporting(true)}>
              <FileUp className="size-4" aria-hidden />
              Import from file
            </Button>
            <Button
              onClick={() => {
                setNotice(null)
                setFormError(null)
                setForm(blankForm(profile?.department_id ?? ''))
              }}
            >
              <Plus className="size-4" aria-hidden />
              Add instructor
            </Button>
          </>
        </div>
      </header>

      {notice && (
        <Notice tone={notice.tone} onDismiss={() => setNotice(null)}>
          {notice.text}
        </Notice>
      )}

      {everyone.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <SearchInput value={search} onChange={setSearch} label="Search instructors" placeholder="Search name, number or email" className="w-full sm:w-80" shortcut />
          <Segmented
            label="Show instructors"
            value={kind}
            onChange={setKind}
            options={[
              { value: 'all', label: 'All', count: counts.all },
              { value: 'full', label: 'Full-time', count: counts.full },
              { value: 'part', label: 'Part-time', count: counts.part },
              ...(counts.inactive > 0 ? [{ value: 'inactive' as const, label: 'Inactive', count: counts.inactive }] : []),
            ]}
          />
          {departmentsInUse.length > 1 && (
            <select value={deptFilter} onChange={(e) => setDeptFilter(e.target.value)} aria-label="Department" className={filterSelectCls}>
              <option value="">All departments</option>
              {departmentsInUse.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          )}
          {filtering && <ResultNote shown={list.length} total={everyone.length} noun={['instructor', 'instructors']} />}
          <Segmented
            label="Instructors layout"
            value={layout}
            onChange={setLayout}
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

      {layout === 'cards' && !q.isLoading && !q.error && list.length > 0 ? (
        <ul className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
          {list.map((i) => {
            const cardsOf = i.rfid_cards ?? []
            const works = formatWorkHours(i.instructor_work_hours ?? [])
            return (
              <li key={i.id} className={cn('flex flex-col overflow-hidden rounded-xl shadow-[0_14px_24px_-18px_rgb(11_21_36/0.55)] ring-1 ring-ink-200', i.is_active ? 'bg-white' : 'bg-ink-50')}>
                {/* the badge's head: a punched lanyard slot, the staff number, a brass edge */}
                <div className={cn('relative h-12 shrink-0', i.is_active ? 'bg-ink-900' : 'bg-ink-400')}>
                  <span aria-hidden className="absolute left-1/2 top-2.5 h-2.5 w-14 -translate-x-1/2 rounded-full bg-ink-50 shadow-[inset_0_1px_2px_rgb(11_21_36/0.55)]" />
                  <span className="absolute right-4 top-3 font-mono text-[12.5px] leading-5 tracking-[0.04em] text-brass-300">{i.employee_no}</span>
                  <span aria-hidden className={cn('absolute inset-x-0 bottom-0 h-[3px]', i.is_active ? 'bg-brass-400' : 'bg-ink-300')} />
                </div>
                <div className="flex flex-1 flex-col px-4 pb-4">
                  <div className="flex items-start gap-3">
                    <span aria-hidden className={cn('relative -mt-7 grid size-14 shrink-0 place-items-center rounded-full font-display text-[20px] font-semibold ring-4 ring-white', i.is_active ? 'bg-brass-100 text-brass-800' : 'bg-ink-200 text-ink-600')}>
                      {initialsOf(i.full_name)}
                    </span>
                    <div className="min-w-0 flex-1 pt-2">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className={cn('font-display text-[19px] font-semibold leading-6', !i.is_active && 'text-ink-600')}>{i.full_name}</span>
                        {!i.is_active && <Badge>Inactive</Badge>}
                      </div>
                      <div className="truncate text-[13px] text-ink-500">{i.email}</div>
                      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-ink-600">
                        <span className="font-medium">{i.departments?.code}</span>
                        {i.employment_type === 'part_time' ? <Badge tone="brass">Part-time</Badge> : <Badge>Full-time</Badge>}
                      </div>
                    </div>
                  </div>

                <div className="mt-4">
                  <div className="mb-1.5 flex items-baseline justify-between text-[13px]">
                    <span className="text-ink-500">Works</span>
                    <span className="text-ink-700">{works || <span className="text-ink-400">Any time the school is open</span>}</span>
                  </div>
                  <WeekStrip windows={i.instructor_work_hours ?? []} />
                </div>

                <div className="mt-3 flex items-baseline justify-between border-t border-ink-100 pt-3 text-[13px]">
                  <span className="text-ink-500">May teach</span>
                  <span className="font-medium text-ink-900">{i.max_weekly_hours} h a week</span>
                </div>

                <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-1.5">
                    {i.profile_id ? <Badge tone="good">Linked</Badge> : <Badge>Not signed up</Badge>}
                    {canSeeCards &&
                      (cardsOf.some((c) => c.is_active) ? <Badge tone="good">Active</Badge> : cardsOf.length > 0 ? <Badge tone="warn">Deactivated</Badge> : <Badge>No card</Badge>)}
                  </div>
                  {canEdit(i) && (
                    <Button
                      variant="ghost"
                      className="-mr-2"
                      onClick={() => {
                        setNotice(null)
                        setFormError(null)
                        setForm(formFor(i))
                      }}
                      aria-label={`Edit ${i.full_name}`}
                    >
                      Edit
                    </Button>
                  )}
                </div>
                </div>
              </li>
            )
          })}
        </ul>
      ) : (
      <Card flush>
        {q.isLoading ? (
          <Loading rows={5} />
        ) : q.error ? (
          <div className="p-4">
            <ErrorNote error={q.error} onRetry={() => void q.refetch()} />
          </div>
        ) : list.length === 0 ? (
          <EmptyState
            title={filtering ? 'No instructor matches' : 'No instructors yet'}
            action={filtering ? <Button variant="secondary" onClick={clearFilters}>Clear search and filters</Button> : undefined}
          >
            {filtering ? 'Try another name or number.' : 'Add an instructor, or import a teaching-load file to add instructors, courses and sections in one go.'}
          </EmptyState>
        ) : (
          <Table>
            <THead>
              <tr>
                <SortTh label="Name" k="name" sort={sort} />
                <SortTh label="Employee no." k="no" sort={sort} />
                <SortTh label="Department" k="dept" sort={sort} />
                <SortTh label="Type" k="type" sort={sort} />
                <SortTh label="May teach" k="hours" sort={sort} />
                <th className={th}>Works</th>
                <th className={th}>App login</th>
                {canSeeCards && <th className={th}>ID card</th>}
                <th className={th}>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </THead>
            <TBody>
              {list.map((i) => {
                const cards = i.rfid_cards ?? []
                const works = formatWorkHours(i.instructor_work_hours ?? [])
                return (
                  <tr key={i.id} className={i.is_active ? '' : 'bg-ink-50/60 text-ink-500'}>
                    <td className={td}>
                      <div className="font-medium">
                        {i.full_name}
                        {!i.is_active && <span className="ml-2 align-middle"><Badge>Inactive</Badge></span>}
                      </div>
                      <div className="text-[13px] text-ink-500">{i.email}</div>
                    </td>
                    <td className={td}>{i.employee_no}</td>
                    <td className={td}>{i.departments?.code}</td>
                    <td className={td}>{i.employment_type === 'part_time' ? <Badge tone="brass">Part-time</Badge> : <Badge>Full-time</Badge>}</td>
                    <td className={td}>{i.max_weekly_hours} h a week</td>
                    <td className={`${td} min-w-[12rem]`}>{works || <span className="text-ink-400">Any time the school is open</span>}</td>
                    <td className={td}>{i.profile_id ? <Badge tone="good">Linked</Badge> : <Badge>Not signed up</Badge>}</td>
                    {canSeeCards && (
                      <td className={td}>
                        {cards.some((c) => c.is_active) ? (
                          <Badge tone="good">Active</Badge>
                        ) : cards.length > 0 ? (
                          <Badge tone="warn">Deactivated</Badge>
                        ) : (
                          <Badge>No card</Badge>
                        )}
                      </td>
                    )}
                    <td className={`${td} text-right`}>
                      {canEdit(i) && (
                        <Button
                          variant="ghost"
                          onClick={() => {
                            setNotice(null)
                            setFormError(null)
                            setForm(formFor(i))
                          }}
                          aria-label={`Edit ${i.full_name}`}
                        >
                          Edit
                        </Button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </TBody>
          </Table>
        )}
      </Card>
      )}

      <p className="mt-6 max-w-[64ch] text-[13px] text-ink-500">
        An instructor with no set hours can be scheduled whenever the school is open. With set hours, the scheduler only places their classes inside
        them. Part-time instructors are also kept to as few teaching days as possible.
        {role === 'program_chair' && ' You can change the instructors of your own department.'}
      </p>

      <Modal
        open={form !== null}
        onClose={() => setForm(null)}
        wide
        title={form?.id ? 'Edit instructor' : 'Add instructor'}
        footer={
          <>
            <Button variant="ghost" onClick={() => setForm(null)}>
              Cancel
            </Button>
            <Button type="submit" form="instructor-form" busy={save.isPending}>
              Save
            </Button>
          </>
        }
      >
        {form && (
          <form id="instructor-form" onSubmit={submit} className="grid gap-x-8 gap-y-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
            <div className="space-y-3">
              <label className="block">
                <span className="mb-1 block text-[13px] font-medium text-ink-700">Full name</span>
                <input required value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} className={inputCls} placeholder="Juan Dela Cruz" />
              </label>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block">
                  <span className="mb-1 block text-[13px] font-medium text-ink-700">Employee number</span>
                  <input value={form.employee_no} onChange={(e) => setForm({ ...form, employee_no: e.target.value })} className={inputCls} placeholder="E-101" />
                </label>
                <label className="block">
                  <span className="mb-1 block text-[13px] font-medium text-ink-700">Email</span>
                  <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} className={inputCls} placeholder="name@school.edu" />
                </label>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block">
                  <span className="mb-1 block text-[13px] font-medium text-ink-700">Employment</span>
                  <select
                    value={form.employment}
                    onChange={(e) => {
                      const employment = e.target.value as EmploymentType
                      // follow the usual limit for the type while the chair has not typed their own
                      const untouched = form.max_weekly_hours === DEFAULT_HOURS[form.employment]
                      setForm({ ...form, employment, max_weekly_hours: untouched ? DEFAULT_HOURS[employment] : form.max_weekly_hours })
                    }}
                    className={inputCls}
                  >
                    <option value="full_time">Full-time</option>
                    <option value="part_time">Part-time</option>
                  </select>
                </label>
                <label className="block">
                  <span className="mb-1 block text-[13px] font-medium text-ink-700">May teach, hours a week</span>
                  <input
                    required
                    type="number"
                    min={1}
                    max={60}
                    inputMode="numeric"
                    value={form.max_weekly_hours}
                    onChange={(e) => setForm({ ...form, max_weekly_hours: e.target.value })}
                    className={inputCls}
                  />
                </label>
              </div>
              {anyDepartment && (
                <label className="block">
                  <span className="mb-1 block text-[13px] font-medium text-ink-700">Department</span>
                  <select value={form.department_id} onChange={(e) => setForm({ ...form, department_id: e.target.value })} className={inputCls}>
                    <option value="">No department</option>
                    {departments.data.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.code}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {form.id && (
                <label className="flex items-center gap-2 text-[14px]">
                  <input type="checkbox" checked={form.is_active} onChange={(e) => setForm({ ...form, is_active: e.target.checked })} className="size-4 accent-ink-900" />
                  Still teaching (untick when they have left; their past schedules stay)
                </label>
              )}
            </div>

            <fieldset className="space-y-3">
              <legend className="mb-1 text-[13px] font-medium text-ink-700">Working hours</legend>
              <label className="flex items-start gap-2 text-[14px]">
                <input type="radio" name="restricted" checked={!form.restricted} onChange={() => setForm({ ...form, restricted: false })} className="mt-1 size-4 accent-ink-900" />
                <span>
                  Any time the school is open
                  <span className="block text-[13px] text-ink-500">Typical for full-time staff.</span>
                </span>
              </label>
              <label className="flex items-start gap-2 text-[14px]">
                <input
                  type="radio"
                  name="restricted"
                  checked={form.restricted}
                  onChange={() =>
                    setForm({
                      ...form,
                      restricted: true,
                      windows: form.windows.length ? form.windows : form.employment === 'part_time' ? [] : [1, 2, 3, 4, 5].map((d) => ({ day_of_week: d, start_time: '08:00', end_time: '17:00' })),
                    })
                  }
                  className="mt-1 size-4 accent-ink-900"
                />
                <span>
                  Only during set hours
                  <span className="block text-[13px] text-ink-500">Classes are placed inside these hours only.</span>
                </span>
              </label>
              {form.restricted && <WorkHoursEditor value={form.windows} onChange={(windows) => setForm({ ...form, windows })} schoolHours={schoolHours.data} />}
              {formHours !== null && formHours > 0 && Number.isFinite(limit) && limit > formHours && (
                <p className="text-[13px] text-amber-800">
                  The weekly limit ({limit} h) is more than the {Math.round(formHours * 10) / 10} h they work, so the working hours are the real limit.
                </p>
              )}
            </fieldset>

            {formError && (
              <div className="lg:col-span-2">
                <Notice tone="bad">{formError}</Notice>
              </div>
            )}
          </form>
        )}
      </Modal>

      <ImportTeachingLoadDialog
        open={importing}
        onClose={() => setImporting(false)}
        onImported={(text) => {
          setNotice({ tone: 'good', text })
          void qc.invalidateQueries({ queryKey: ['instructors'] })
          void qc.invalidateQueries({ queryKey: ['courses'] })
          void qc.invalidateQueries({ queryKey: ['sections'] })
          void qc.invalidateQueries({ queryKey: ['audit'] })
        }}
      />
    </>
  )
}
