import { Fragment, useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Pencil, Printer, Sparkles } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '@/auth/AuthProvider'
import { Modal } from '@/components/Modal'
import { ScheduleEditor, type MoveTarget } from '@/components/ScheduleEditor'
import { ScheduleStatusBadge } from '@/components/StatusBadges'
import { WeeklyGrid } from '@/components/WeeklyGrid'
import { Button, Card, EmptyState, ErrorNote, inputCls, Loading, Notice } from '@/components/ui'
import { useNow } from '@/hooks/useRealtimeSync'
import { cn } from '@/lib/cn'
import { fetchAll, unwrap, usePrograms, useRooms, useTerms } from '@/lib/api'
import { friendlyError, isDoubleBooking } from '@/lib/errors'
import { onGenerateSaved, openGenerate } from '@/lib/generateBus'
import { STATUS_LABEL } from '@/lib/format'
import { isApprover, PLANNER_ROLES } from '@/lib/roles'
import { supabase } from '@/lib/supabase'
import { DAY_SHORT, fmtDateTime, fmtRange, fmtTime, nowIn } from '@/lib/time'
import type { BusyRow, OverrideRow, ReviewNote, ScheduleEntryRow, ScheduleStatus } from '@/lib/types'

const STATUS_ORDER: ScheduleStatus[] = ['draft', 'returned', 'submitted', 'approved', 'published']

/** Only drafts and rejected meetings may be moved: everything later is under review or live. */
const MOVABLE: ScheduleStatus[] = ['draft', 'returned']

/** Submitted, approved and published meetings are locked; a dean or administrator can still override one. */
const LOCKED: ScheduleStatus[] = ['submitted', 'approved', 'published']

const ENTRY_COLUMNS =
  'id, term_id, section_id, program_id, instructor_id, cohort_key, room_id, day_of_week, start_time, end_time, status, is_override, is_pinned, sections(code, courses(code, title)), instructors(full_name), rooms(code, name)'

function SelectField({
  label,
  value,
  onChange,
  children,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  children: React.ReactNode
}) {
  return (
    <label className="block min-w-[170px]">
      <span className="mb-1 block text-[13px] font-medium text-ink-300">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} className={inputCls}>
        {children}
      </select>
    </label>
  )
}

export default function Schedules() {
  const { profile } = useAuth()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const role = profile?.role
  const tz = profile?.tenants?.timezone ?? 'Asia/Manila'
  const clock = useNow(60_000)
  const isPlanner = Boolean(role && PLANNER_ROLES.includes(role))
  const approver = isApprover(role)
  const terms = useTerms()
  const programs = usePrograms()
  const roomList = useRooms()

  const [termSel, setTermSel] = useState('')
  const [programId, setProgramId] = useState('all')
  const [roomId, setRoomId] = useState('all')
  const [editing, setEditing] = useState(false)
  const [notice, setNotice] = useState<{ tone: 'good' | 'warn' | 'bad'; text: string } | null>(null)
  const [blocked, setBlocked] = useState<string[] | null>(null)
  const [rejecting, setRejecting] = useState(false)
  const [reopening, setReopening] = useState(false)
  const [note, setNote] = useState('')
  const [statusShow, setStatusShow] = useState<ScheduleStatus | 'all'>('all')

  const termId = termSel || terms.data?.find((t) => t.is_active)?.id || terms.data?.[0]?.id || ''

  const myPrograms = useMemo(
    () => (programs.data ?? []).filter((p) => role !== 'program_chair' || p.department_id === profile?.department_id),
    [programs.data, role, profile?.department_id],
  )

  const entryKey = ['schedule-entries', termId, programId] as const
  const entries = useQuery({
    queryKey: entryKey,
    enabled: Boolean(termId),
    // a page of 1000 at a time: with several departments a term holds more meetings than the server sends in one answer
    queryFn: () =>
      fetchAll<ScheduleEntryRow>((from, to) => {
        let q = supabase
          .from('schedule_entries')
          .select(ENTRY_COLUMNS)
          .eq('term_id', termId)
          .order('day_of_week')
          .order('start_time')
          .order('id')
        if (programId !== 'all') q = q.eq('program_id', programId)
        return q.range(from, to)
      }),
  })

  // what is already booked, across every department (only needed while editing)
  const busy = useQuery({
    queryKey: ['schedule-busy', termId],
    enabled: Boolean(termId) && editing && isPlanner,
    queryFn: () => unwrap<BusyRow[]>(supabase.rpc('schedule_busy', { p_term_id: termId })),
  })

  // the dean's inbox: programs with submitted meetings
  const waiting = useQuery({
    queryKey: ['schedule-entries', 'waiting', termId],
    enabled: Boolean(termId) && approver,
    queryFn: () =>
      unwrap<{ program_id: string | null }[]>(
        supabase.from('schedule_entries').select('program_id').eq('term_id', termId).eq('status', 'submitted'),
      ),
  })

  const all = entries.data ?? []
  const counts = useMemo(() => {
    const c: Record<ScheduleStatus, number> = { draft: 0, returned: 0, submitted: 0, approved: 0, published: 0 }
    all.forEach((e) => (c[e.status] += 1))
    return c
  }, [all])

  const waitingList = useMemo(() => {
    const m = new Map<string, number>()
    ;(waiting.data ?? []).forEach((r) => r.program_id && m.set(r.program_id, (m.get(r.program_id) ?? 0) + 1))
    return [...m.entries()]
      .map(([id, n]) => ({ program: programs.data?.find((p) => p.id === id), n }))
      .filter((x): x is { program: NonNullable<typeof x.program>; n: number } => Boolean(x.program))
      .sort((a, b) => a.program.code.localeCompare(b.program.code))
  }, [waiting.data, programs.data])

  const rooms = roomList.data ?? []
  const shown = roomId === 'all' ? all : all.filter((e) => e.room_id === roomId)
  // the status chips narrow the weekly view; editing always shows everything so nothing is hidden while moving meetings
  const gridEntries = statusShow === 'all' || counts[statusShow] === 0 ? shown : shown.filter((e) => e.status === statusShow)

  const selected = programs.data?.find((p) => p.id === programId)
  const oneProgram = programId !== 'all'
  const ownsProgram = role === 'program_chair' ? selected?.department_id === profile?.department_id : true
  const canSubmit = oneProgram && isPlanner && ownsProgram && counts.draft + counts.returned > 0
  // one program, or several planned together (the dialog lets the person tick which)
  const canGenerate = isPlanner && myPrograms.length > 0 && Boolean(termId) && (oneProgram ? ownsProgram && Boolean(selected) : true)
  const canDecide = oneProgram && approver && counts.submitted > 0
  const canPublish = oneProgram && approver && counts.approved > 0
  // a dean or administrator takes a timetable back for editing (with a reason); a chair can only take back what they submitted
  const canReopen = oneProgram && approver && counts.submitted + counts.approved + counts.published > 0
  const canWithdraw = oneProgram && !approver && isPlanner && ownsProgram && counts.submitted > 0

  // why the schedule came back (read by the chair; also useful to the dean)
  const review = useQuery({
    queryKey: ['schedule-review', termId, programId],
    enabled: Boolean(termId) && oneProgram && isPlanner && counts.returned + counts.draft > 0,
    queryFn: async () => {
      const rows = await unwrap<ReviewNote[]>(
        supabase.rpc('schedule_review_note', { p_term_id: termId, p_program_id: programId }),
      )
      return rows[0] ?? null
    },
  })
  const rejection = review.data?.action === 'SCHEDULE_RETURNED' && counts.returned > 0 ? review.data : null
  const reopened = review.data?.action === 'SCHEDULE_DRAFT' && counts.draft > 0 ? review.data : null

  // locked meetings that were moved afterwards, with the reason (everyone who can see the meeting can see why)
  const overrides = useQuery({
    queryKey: ['schedule-overrides', termId, programId],
    enabled: Boolean(termId),
    queryFn: () =>
      unwrap<OverrideRow[]>(
        supabase.rpc('schedule_overrides', { p_term_id: termId, p_program_id: programId === 'all' ? null : programId }),
      ),
  })

  const shownIds = useMemo(() => new Set(shown.map((e) => e.id)), [shown])
  const overrideList = useMemo(() => (overrides.data ?? []).filter((o) => shownIds.has(o.entry_id)), [overrides.data, shownIds])

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['schedule-overrides'] })
    void qc.invalidateQueries({ queryKey: ['schedule-entries'] })
    void qc.invalidateQueries({ queryKey: ['schedule-busy'] })
    void qc.invalidateQueries({ queryKey: ['schedule-review'] })
    void qc.invalidateQueries({ queryKey: ['audit'] })
  }

  // the Generate schedule window lives in the app's frame; it says here when a plan was saved, also when it was saved from another page
  useEffect(
    () =>
      onGenerateSaved(({ inserted, replaced, unplaced, programs: codes }) => {
        setNotice({
          tone: 'good',
          text:
            `Saved ${inserted} draft meeting${inserted === 1 ? '' : 's'} for ${codes.length <= 3 ? codes.join(', ') : `${codes.length} programs`}` +
            (replaced > 0 ? `, replacing ${replaced} earlier one${replaced === 1 ? '' : 's'}` : '') +
            '.' +
            (unplaced > 0
              ? ` ${unplaced} could not be placed: run Generate again after fixing the cause, or add them by hand.`
              : ' Review them, adjust with Edit timetable, then submit for approval.'),
        })
        refresh()
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  const rpcStatus = (to: ScheduleStatus, text?: string) =>
    unwrap<number>(
      supabase.rpc('set_schedule_status', { p_term_id: termId, p_program_id: programId, p_to: to, p_note: text ?? null }),
    )

  const change = useMutation({
    mutationFn: async ({ to, text }: { to: ScheduleStatus | 'accepted'; text?: string }) => {
      if (to !== 'accepted') return { n: await rpcStatus(to, text), to }
      // accepting means approving and putting it live in one step
      const n = await rpcStatus('approved')
      try {
        await rpcStatus('published')
      } catch (err) {
        throw new Error(`Approved ${n} meetings, but publishing failed: ${friendlyError(err)} Use Publish to try again.`)
      }
      return { n, to }
    },
    onSuccess: ({ n, to }) => {
      const verb: Record<string, string> = {
        submitted: 'Submitted for approval',
        returned: 'Rejected and sent back to the program chair',
        accepted: 'Accepted and published to the locker station',
        published: 'Published to the locker station',
        draft: approver
          ? 'Reopened for editing. The locker station no longer follows these classes until the timetable is published again'
          : 'Taken back to draft',
      }
      setNotice({ tone: 'good', text: `${verb[to] ?? 'Updated'}: ${n} class meeting${n === 1 ? '' : 's'} for ${selected?.code}.` })
      refresh()
    },
    onError: (err, { to }) => {
      const hint =
        to === 'submitted' && isDoubleBooking(err)
          ? ' Another booking now clashes with some of these meetings. Choose Edit timetable: the clashing ones are outlined in red.'
          : ''
      setNotice({ tone: 'bad', text: friendlyError(err) + hint })
      refresh()
    },
  })

  function run(to: ScheduleStatus | 'accepted', text?: string) {
    setNotice(null)
    setBlocked(null)
    change.mutate({ to, text })
  }

  const move = useMutation({
    mutationFn: async ({ entry, to }: { entry: ScheduleEntryRow; to: MoveTarget }) => {
      const rows = await unwrap<{ id: string }[]>(
        supabase.from('schedule_entries').update(to).eq('id', entry.id).select('id'),
      )
      if (rows.length === 0) throw new Error('You cannot change this meeting.')
    },
    onMutate: async ({ entry, to }) => {
      await qc.cancelQueries({ queryKey: entryKey })
      const prev = qc.getQueryData<ScheduleEntryRow[]>(entryKey)
      const room = rooms.find((r) => r.id === to.room_id)
      qc.setQueryData<ScheduleEntryRow[]>(entryKey, (old) =>
        old?.map((e) =>
          e.id === entry.id ? { ...e, ...to, rooms: room ? { code: room.code, name: room.name } : e.rooms } : e,
        ),
      )
      return { prev }
    },
    onError: (err, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(entryKey, ctx.prev)
      setNotice({ tone: 'bad', text: friendlyError(err) })
    },
    onSettled: refresh,
  })

  // a chair marks a draft meeting as "keep it where it is" for the next Generate
  const pin = useMutation({
    mutationFn: async ({ entry, pinned }: { entry: ScheduleEntryRow; pinned: boolean }) => {
      const rows = await unwrap<{ id: string }[]>(
        supabase.from('schedule_entries').update({ is_pinned: pinned }).eq('id', entry.id).select('id'),
      )
      if (rows.length === 0) throw new Error('You cannot change this meeting.')
    },
    onMutate: async ({ entry, pinned }) => {
      await qc.cancelQueries({ queryKey: entryKey })
      const prev = qc.getQueryData<ScheduleEntryRow[]>(entryKey)
      qc.setQueryData<ScheduleEntryRow[]>(entryKey, (old) => old?.map((e) => (e.id === entry.id ? { ...e, is_pinned: pinned } : e)))
      return { prev }
    },
    onError: (err, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(entryKey, ctx.prev)
      setNotice({ tone: 'bad', text: friendlyError(err) })
    },
    onSettled: refresh,
  })

  // a dean or administrator moves one locked meeting; the reason is required and kept in the audit log
  async function overrideEntry(entry: ScheduleEntryRow, to: MoveTarget, justification: string) {
    const r = await unwrap<{ warnings: string[] }>(
      supabase.rpc('override_schedule_entry', {
        p_entry_id: entry.id,
        p_room_id: to.room_id,
        p_day: to.day_of_week,
        p_start: to.start_time,
        p_end: to.end_time,
        p_justification: justification,
      }),
    )
    const room = rooms.find((x) => x.id === to.room_id)?.code ?? 'the new room'
    const course = entry.sections?.courses?.code ?? entry.sections?.code ?? 'The meeting'
    const warnings = r.warnings ?? []
    setNotice({
      tone: warnings.length ? 'warn' : 'good',
      text:
        `${course} now meets ${DAY_SHORT[to.day_of_week - 1]} ${fmtTime(to.start_time)} to ${fmtTime(to.end_time)} in ${room} and stays ${STATUS_LABEL[entry.status].toLowerCase()}. ` +
        'Your reason is in the audit log.' +
        (warnings.length ? ` Check this: ${warnings.join(' ')}` : ''),
    })
    refresh()
  }

  const canEdit = (e: ScheduleEntryRow) => MOVABLE.includes(e.status)
  const canOverride = (e: ScheduleEntryRow) => approver && LOCKED.includes(e.status)
  const movable = all.filter(canEdit).length

  const description =
    role === 'instructor'
      ? 'Your published classes for the term.'
      : 'Review each program’s timetable, then send it through approval. Only published meetings open a locker.'

  return (
    <>
      <header className="mb-6 flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
        <div className="min-w-0 max-w-[62ch]">
          <h1 className="font-display text-[34px] font-semibold leading-none tracking-[-0.02em]">Schedules</h1>
          <p className="mt-2 text-ink-500">{description}</p>
          {all.length > 0 && (
            <dl className="mt-4 flex flex-wrap gap-x-7 gap-y-2">
              {[
                { label: all.length === 1 ? 'Meeting' : 'Meetings', value: all.length },
                { label: 'Rooms used', value: new Set(all.map((e) => e.room_id)).size },
                { label: 'Instructors teaching', value: new Set(all.map((e) => e.instructor_id).filter(Boolean)).size },
                { label: 'Published', value: counts.published },
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
            <Button
              variant="secondary"
              disabled={!termId}
              title="Print this timetable, save it as a PDF, or download it for Excel"
              onClick={() => navigate(`/timetables?term=${termId}&program=${programId}`)}
            >
              <Printer className="size-4" aria-hidden />
              {role === 'instructor' ? 'Print' : 'Print or export'}
            </Button>
            {isPlanner && (
            <>
              <Button
                variant={editing ? 'primary' : 'secondary'}
                onClick={() => {
                  setEditing((v) => !v)
                  setBlocked(null)
                }}
              >
                <Pencil className="size-4" aria-hidden />
                {editing ? 'Done editing' : 'Edit timetable'}
              </Button>
              <Button
                variant="secondary"
                disabled={!canGenerate}
                title={
                  canGenerate
                    ? oneProgram
                      ? 'Build a timetable for this program automatically'
                      : 'Build timetables for several programs together'
                    : 'You have no program to plan'
                }
                onClick={() => {
                  setNotice(null)
                  setBlocked(null)
                  setEditing(false)
                  openGenerate({ termId, programs: myPrograms, initialIds: selected ? [selected.id] : myPrograms.map((p) => p.id) })
                }}
              >
                <Sparkles className="size-4" aria-hidden />
                Generate schedule
              </Button>
            </>
            )}
          </>
        </div>
      </header>

      {approver && waitingList.length > 0 && (
        <section aria-labelledby="waiting-title" className="mb-6 rounded-lg bg-brass-50 px-4 py-3.5 ring-1 ring-brass-300">
          <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
            <div className="flex items-center gap-3">
              <span aria-hidden className="size-3.5 shrink-0 rounded-full bg-canvas shadow-[inset_0_1px_2px_rgb(11_21_36/0.3)] ring-1 ring-brass-300" />
              <div>
                <h2 id="waiting-title" className="font-display text-[19px] font-semibold leading-6 text-brass-700">
                  Waiting for your decision
                </h2>
                <p className="text-[13px] text-brass-700/80">Schedules the program chairs have submitted.</p>
              </div>
            </div>
            <ul className="flex flex-wrap gap-2.5">
              {waitingList.map(({ program, n }) => (
                <li key={program.id} className="flex items-center gap-3 rounded-md bg-white py-1.5 pl-3 pr-1.5 ring-1 ring-brass-200">
                  <div>
                    <span className="font-medium">{program.code}</span>
                    <span className="ml-2 text-[13px] text-ink-500">
                      {n} class meeting{n === 1 ? '' : 's'}
                    </span>
                  </div>
                  <Button variant={program.id === programId ? 'secondary' : 'primary'} onClick={() => setProgramId(program.id)}>
                    {program.id === programId ? 'Reviewing' : 'Review'}
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}

      {notice && (
        <Notice tone={notice.tone} onDismiss={() => setNotice(null)}>
          {notice.text}
        </Notice>
      )}
      {blocked && (
        <div className="mb-4 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-[14px] text-rose-900" role="alert">
          <div className="font-medium">That move was not made.</div>
          <ul className="mt-0.5 list-disc pl-5 text-[13px]">
            {blocked.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        </div>
      )}

      {rejection && oneProgram && (
        <div className="mb-4 rounded-md border border-rose-200 bg-rose-50 px-3 py-2.5 text-rose-900" role="status">
          <div className="font-medium">
            Rejected{rejection.actor_name ? ` by ${rejection.actor_name}` : ''}, {fmtDateTime(rejection.created_at, tz)}
          </div>
          <div className="mt-0.5 text-[14px]">{rejection.note}</div>
          {isPlanner && role !== 'instructor' && (
            <div className="mt-1 text-[13px] text-rose-800">
              Fix the meetings (Edit timetable), then Submit for approval again.
            </div>
          )}
        </div>
      )}

      {reopened && oneProgram && (
        <div className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2.5 text-amber-950" role="status">
          <div className="font-medium">
            Reopened for editing{reopened.actor_name ? ` by ${reopened.actor_name}` : ''}, {fmtDateTime(reopened.created_at, tz)}
          </div>
          {reopened.note && <div className="mt-0.5 text-[14px]">{reopened.note}</div>}
          <div className="mt-1 text-[13px] text-amber-900">Make the changes (Edit timetable or Generate schedule), then Submit for approval again.</div>
        </div>
      )}

      {role !== 'instructor' && oneProgram && counts.published > 0 && (
        <p className="mb-3 text-[13px] text-ink-500">
          Published classes are locked: the key locker follows them, so they are not moved or regenerated by the usual editing.
          {canReopen
            ? ' To change the whole timetable, use Reopen for editing; to move one meeting, choose Edit timetable and override it with a reason.'
            : isPlanner
              ? ' A dean or administrator can reopen the timetable for editing, or override a single meeting.'
              : ''}
        </p>
      )}

      {editing && isPlanner && movable === 0 && all.length > 0 && (
        <p className="mb-3 rounded-md border border-ink-200 bg-white px-3 py-2 text-[13px] text-ink-600">
          Nothing here can be moved right now: only draft and rejected meetings can be edited.{' '}
          {approver
            ? 'To change one locked meeting, click it and override it with a reason; to change the whole timetable, use Reopen for editing.'
            : 'To change a submitted, approved or published schedule, a dean or administrator reopens it first (Reopen for editing) or overrides a single meeting.'}
        </p>
      )}
      {editing && isPlanner && programId === 'all' && roomId === 'all' && all.length > 0 && (
        <p className="mb-3 text-[13px] text-ink-500">Tip: choose a program or a room to see a clearer week.</p>
      )}

      <section aria-label="Timetable" className="overflow-hidden rounded-lg bg-white shadow-[0_14px_26px_-20px_rgb(11_21_36/0.55)] ring-1 ring-ink-300">
      <div className="flex flex-wrap items-end gap-3 bg-ink-900 px-4 py-3">
        <SelectField label="Term" value={termId} onChange={(v) => setTermSel(v)}>
          {(terms.data ?? []).map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </SelectField>
        {role !== 'instructor' && (
          <SelectField label="Program" value={programId} onChange={setProgramId}>
            <option value="all">{role === 'program_chair' ? 'All my programs' : 'All programs'}</option>
            {myPrograms.map((p) => (
              <option key={p.id} value={p.id}>
                {p.code}
              </option>
            ))}
          </SelectField>
        )}
        <SelectField label="Room" value={roomId} onChange={setRoomId}>
          <option value="all">All rooms</option>
          {rooms.map((r) => (
            <option key={r.id} value={r.id}>
              {r.code}
            </option>
          ))}
        </SelectField>
      </div>

      {role !== 'instructor' && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-ink-200 bg-ink-50 px-4 py-2.5">
          <div className="flex flex-wrap items-center gap-y-2">
            {STATUS_ORDER.filter((s) => counts[s] > 0).map((s, i) => {
              const on = statusShow === s && counts[s] > 0
              return (
                <Fragment key={s}>
                {i > 0 && <span aria-hidden className="mx-1 h-px w-7 bg-ink-300" />}
                <button
                  type="button"
                  aria-pressed={on}
                  disabled={editing}
                  title={editing ? 'Finish editing to filter the week by status' : on ? 'Show every status again' : `Show only ${STATUS_LABEL[s].toLowerCase()} meetings`}
                  onClick={() => setStatusShow(on ? 'all' : s)}
                  className={cn(
                    'inline-flex items-center gap-1.5 rounded-full border py-0.5 pl-0.5 pr-2 transition-colors disabled:cursor-default',
                    on ? 'border-ink-900 bg-white shadow-[0_0_0_1px_var(--color-ink-900)]' : 'border-transparent enabled:hover:bg-ink-100',
                  )}
                >
                  <ScheduleStatusBadge status={s} />
                  <span className="text-[13px] text-ink-500">{counts[s]}</span>
                </button>
                </Fragment>
              )
            })}
            {all.length === 0 && !entries.isLoading && <span className="text-ink-500">No class meetings yet.</span>}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {canSubmit && (
              <Button busy={change.isPending} onClick={() => run('submitted')}>
                Submit for approval
              </Button>
            )}
            {canDecide && (
              <>
                <Button variant="danger" disabled={change.isPending} onClick={() => setRejecting(true)}>
                  Reject
                </Button>
                <Button busy={change.isPending} onClick={() => run('accepted')}>
                  Accept and publish
                </Button>
              </>
            )}
            {canPublish && (
              <Button busy={change.isPending} onClick={() => run('published')}>
                Publish
              </Button>
            )}
            {canReopen && (
              <Button variant="secondary" disabled={change.isPending} onClick={() => setReopening(true)}>
                Reopen for editing
              </Button>
            )}
            {canWithdraw && (
              <Button variant="secondary" busy={change.isPending} onClick={() => run('draft')}>
                Withdraw submission
              </Button>
            )}
            {!oneProgram && all.length > 0 && (
              <span className="text-[13px] text-ink-500">Choose one program to submit, accept, reject or reopen.</span>
            )}
          </div>
        </div>
      )}

        {entries.isLoading || terms.isLoading ? (
          <Loading rows={5} />
        ) : entries.error ? (
          <div className="p-4">
            <ErrorNote error={entries.error} />
          </div>
        ) : editing && isPlanner ? (
          busy.isLoading || roomList.isLoading ? (
            <Loading label="Checking other departments’ bookings" />
          ) : busy.error ? (
            <div className="p-4">
              <ErrorNote error={busy.error} />
            </div>
          ) : (
            <ScheduleEditor
              entries={shown}
              busy={busy.data ?? []}
              rooms={rooms}
              roomFilter={roomId}
              ownDepartmentId={profile?.department_id ?? null}
              canEdit={canEdit}
              canOverride={canOverride}
              onMove={(entry, to) => {
                setNotice(null)
                setBlocked(null)
                move.mutate({ entry, to })
              }}
              onOverride={overrideEntry}
              onPin={(entry, pinned) => pin.mutate({ entry, pinned })}
              onBlocked={setBlocked}
            />
          )
        ) : shown.length === 0 ? (
          <EmptyState title="Nothing scheduled here">
            {role === 'instructor'
              ? 'Classes appear here once your program’s timetable is published.'
              : 'Change the term, program or room filter, or use Generate schedule to build a timetable for a program.'}
          </EmptyState>
        ) : (
          <WeeklyGrid entries={editing ? shown : gridEntries} now={nowIn(tz, clock)} />
        )}
      </section>

      {overrideList.length > 0 && (
        <Card
          title="Changed after approval"
          description="Meetings a dean or administrator moved on their own. Each has the reason it was moved."
          className="mt-4"
          flush
        >
          <ul className="divide-y divide-ink-100" aria-label="Overridden meetings">
            {overrideList.map((o) => (
              <li key={o.entry_id} className="px-4 py-3 text-[14px]">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-medium">{o.course_code ?? o.section_code}</span>
                  <span className="text-[13px] text-ink-500">
                    {o.section_code}
                    {o.instructor_name ? `, ${o.instructor_name}` : ''}
                  </span>
                </div>
                <div className="text-[13px] text-ink-700">
                  {DAY_SHORT[o.from_day - 1]} {fmtRange(o.from_start, o.from_end)}, {o.from_room} → {DAY_SHORT[o.to_day - 1]}{' '}
                  {fmtRange(o.to_start, o.to_end)}, {o.to_room}
                </div>
                <div className="mt-0.5 text-[13px] text-ink-600">
                  “{o.justification}”{' '}
                  <span className="text-ink-400">
                    {o.actor_name ?? 'Someone'}, {fmtDateTime(o.created_at, tz)}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <p className="mt-3 text-[13px] text-ink-500">
        Double bookings of a room, an instructor or a student block, even across departments, are refused by the
        database, so a saved timetable cannot contain one.
      </p>


      <Modal
        open={reopening}
        onClose={() => setReopening(false)}
        title={`Reopen ${selected?.code ?? 'schedule'} for editing`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setReopening(false)}>
              Cancel
            </Button>
            <Button
              disabled={note.trim() === ''}
              onClick={() => {
                run('draft', note.trim())
                setReopening(false)
                setNote('')
              }}
            >
              Reopen
            </Button>
          </>
        }
      >
        <p className="mb-3 text-[14px] text-ink-700">
          Every {counts.submitted + counts.approved + counts.published} submitted, approved or published meeting of {selected?.code} becomes a draft again, so the
          program chair can edit or regenerate it. The key locker stops following these classes until the timetable is approved and published again.
        </p>
        <label className="block text-[13px] font-medium text-ink-700" htmlFor="reopen-note">
          Why is it being reopened?
        </label>
        <textarea
          id="reopen-note"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={3}
          className={`${inputCls} mt-1 h-auto py-2`}
          placeholder="The chair sees this note, and it is saved in the audit log."
        />
      </Modal>

      <Modal
        open={rejecting}
        onClose={() => setRejecting(false)}
        title={`Reject ${selected?.code ?? 'schedule'}`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setRejecting(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={note.trim() === ''}
              onClick={() => {
                run('returned', note.trim())
                setRejecting(false)
                setNote('')
              }}
            >
              Reject schedule
            </Button>
          </>
        }
      >
        <label className="block text-[13px] font-medium text-ink-700" htmlFor="return-note">
          What should the program chair fix?
        </label>
        <textarea
          id="return-note"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={4}
          className={`${inputCls} mt-1 h-auto py-2`}
          placeholder="The chair sees this note, and it is saved in the audit log."
        />
      </Modal>
    </>
  )
}
