import { useMemo, useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@/auth/AuthProvider'
import { KeyTag } from '@/components/KeyTag'
import { Modal } from '@/components/Modal'
import { Segmented } from '@/components/controls'
import { Notches, Spike, Stamp, DayBar } from '@/components/surfaces'
import { Badge, Button, EmptyState, ErrorNote, inputCls, Loading, Notice } from '@/components/ui'
import { REQUEST_STATUS_LABEL } from '@/lib/format'
import { unwrap } from '@/lib/api'
import { friendlyError } from '@/lib/errors'
import { isOps } from '@/lib/roles'
import { supabase } from '@/lib/supabase'
import { fmtDate, fmtDateTime, fmtRange, todayIn } from '@/lib/time'
import type { FreeRoom, RequestStatus, RoomRequestRow } from '@/lib/types'

/** "08:30" plus 90 minutes is "10:00"; null when that runs past the end of the day. */
function addMinutes(hhmm: string, minutes: number): string | null {
  const m = /^(\d{2}):(\d{2})/.exec(hhmm)
  if (!m) return null
  const total = Number(m[1]) * 60 + Number(m[2]) + minutes
  if (total > 23 * 60 + 59) return null
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

const LENGTHS: Array<[label: string, minutes: number]> = [
  ['1 hour', 60],
  ['1.5 hours', 90],
  ['2 hours', 120],
  ['3 hours', 180],
]

/** A request for today or tomorrow is the one to decide first. */
function DayBadge({ date, today }: { date: string; today: string }) {
  if (date === today) return <Badge tone="warn" dot>Today</Badge>
  const next = new Date(`${today}T00:00:00Z`)
  next.setUTCDate(next.getUTCDate() + 1)
  return date === next.toISOString().slice(0, 10) ? <Badge tone="brass" dot>Tomorrow</Badge> : null
}

const STAMP_TONE: Record<RequestStatus, 'good' | 'bad' | 'warn' | 'neutral'> = { pending: 'warn', approved: 'good', rejected: 'bad', cancelled: 'neutral' }

/** The decision on a slip, pressed on as a rubber stamp. */
function StatusStamp({ status }: { status: RequestStatus }) {
  return <Stamp tone={STAMP_TONE[status]}>{REQUEST_STATUS_LABEL[status]}</Stamp>
}

/** The left part of a slip, torn off along a dotted line: a punched hole, the room's code and its name. */
function SlipStub({ code, name, tone = 'brass' }: { code?: string; name?: string; tone?: 'brass' | 'ink' }) {
  return (
    <div
      className={`relative flex w-[104px] shrink-0 flex-col items-center gap-3 rounded-l-md border-r-2 border-dashed px-2 pb-4 pt-3.5 ${
        tone === 'brass' ? 'border-brass-300 bg-brass-50' : 'border-ink-200 bg-ink-50'
      }`}
    >
      <Notches className="-right-2" />
      <span aria-hidden className="size-3.5 rounded-full bg-canvas shadow-[inset_0_1px_2px_rgb(11_21_36/0.25)] ring-1 ring-brass-300" />
      <div className="text-center">
        <div className={`whitespace-nowrap font-display text-[20px] font-semibold leading-6 ${tone === 'brass' ? 'text-brass-700' : 'text-ink-700'}`}>{code ?? 'Room'}</div>
        {name && <div className="mt-0.5 text-[12px] leading-4 text-ink-500">{name}</div>}
      </div>
    </div>
  )
}

const slipCls =
  'relative flex rounded-md bg-[#fffdf7] ring-1 ring-ink-200 shadow-[0_1px_0_rgb(11_21_36/0.04),0_12px_20px_-16px_rgb(11_21_36/0.5)]'

const REQUEST_COLUMNS =
  'id, instructor_id, room_id, requested_for, start_time, end_time, reason, status, decided_at, decision_note, created_at, instructors(full_name), rooms(code, name)'

export default function Requests() {
  const { profile } = useAuth()
  return isOps(profile?.role) ? <ApproverView /> : <InstructorView />
}

/* ------------------------------------------------------------------ */
/* Instructor: ask for a free room                                     */
/* ------------------------------------------------------------------ */

function InstructorView() {
  const { profile } = useAuth()
  const qc = useQueryClient()
  const tz = profile?.tenants?.timezone ?? 'Asia/Manila'
  const today = todayIn(tz)

  const [date, setDate] = useState(today)
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [roomId, setRoomId] = useState('')
  const [reason, setReason] = useState('')
  const [notice, setNotice] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null)

  const ready = Boolean(date && start && end && end > start && date >= today)

  const free = useQuery({
    queryKey: ['free-rooms', date, start, end],
    enabled: ready,
    queryFn: () => unwrap<FreeRoom[]>(supabase.rpc('free_rooms', { p_date: date, p_start: start, p_end: end })),
  })

  const mine = useQuery({
    queryKey: ['room-requests', 'mine'],
    queryFn: () =>
      unwrap<RoomRequestRow[]>(
        supabase
          .from('room_requests')
          .select(REQUEST_COLUMNS)
          .order('requested_for', { ascending: false })
          .order('start_time', { ascending: false })
          .limit(50),
      ),
  })

  const send = useMutation({
    mutationFn: () =>
      unwrap<string>(
        supabase.rpc('create_room_request', {
          p_room_id: roomId,
          p_date: date,
          p_start: start,
          p_end: end,
          p_reason: reason,
        }),
      ),
    onSuccess: () => {
      const room = free.data?.find((r) => r.room_id === roomId)?.code
      setNotice({ tone: 'good', text: `Request sent for ${room ?? 'the room'}. You will see the decision here.` })
      setRoomId('')
      setReason('')
      void qc.invalidateQueries({ queryKey: ['room-requests'] })
      void qc.invalidateQueries({ queryKey: ['free-rooms'] })
    },
    onError: (err) => {
      setNotice({ tone: 'bad', text: friendlyError(err, 'The request was not sent.') })
      void qc.invalidateQueries({ queryKey: ['free-rooms'] })
    },
  })

  const cancel = useMutation({
    mutationFn: (id: string) => unwrap(supabase.rpc('cancel_room_request', { p_request_id: id })),
    onSuccess: () => {
      setNotice({ tone: 'good', text: 'Request cancelled.' })
      void qc.invalidateQueries({ queryKey: ['room-requests'] })
      void qc.invalidateQueries({ queryKey: ['free-rooms'] })
    },
    onError: (err) => setNotice({ tone: 'bad', text: friendlyError(err, 'Could not cancel the request.') }),
  })

  const [mineShow, setMineShow] = useState<'all' | 'pending' | 'approved'>('all')
  const myRequests = (mine.data ?? []).filter((r) => mineShow === 'all' || r.status === mineShow)

  const rooms = free.data ?? []
  // a selection that is no longer free (the list refreshed) should not be sent
  const chosen = rooms.some((r) => r.room_id === roomId) ? roomId : ''

  function submit(e: FormEvent) {
    e.preventDefault()
    setNotice(null)
    send.mutate()
  }

  const chosenRoom = rooms.find((r) => r.room_id === chosen)
  const mineCount = (mine.data ?? []).length

  return (
    <>
      <header className="mb-8 max-w-[68ch]">
        <h1 className="font-display text-[34px] font-semibold leading-none tracking-[-0.02em]">Request a room</h1>
        <p className="mt-2 text-ink-500">
          Need a room that happens to be free, for a make-up class or a consultation? Ask here. A dean or administrator decides, and the room key opens for you only during the approved time.
        </p>
      </header>

      {notice && (
        <Notice tone={notice.tone} onDismiss={() => setNotice(null)}>
          {notice.text}
        </Notice>
      )}

      <div className="grid grid-cols-1 gap-8 xl:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)] xl:items-start">
        <section aria-labelledby="new-request" className={slipCls}>
          <div className="hidden sm:block">
            <SlipStub code={chosenRoom?.code ?? 'No room yet'} name={chosenRoom ? `Seats ${chosenRoom.capacity}` : 'Pick one below'} />
          </div>
          <div className="min-w-0 flex-1 p-5">
            <h2 id="new-request" className="mb-4 font-display text-[21px] font-semibold leading-6">
              New request
            </h2>
            <form onSubmit={submit} className="space-y-4">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <label className="block">
                  <span className="mb-1 block text-[13px] font-medium text-ink-700">Date</span>
                  <input type="date" required min={today} value={date} onChange={(e) => setDate(e.target.value)} className={inputCls} />
                </label>
                <label className="block">
                  <span className="mb-1 block text-[13px] font-medium text-ink-700">From</span>
                  <input type="time" required step={900} value={start} onChange={(e) => setStart(e.target.value)} className={inputCls} />
                </label>
                <label className="block">
                  <span className="mb-1 block text-[13px] font-medium text-ink-700">Until</span>
                  <input type="time" required step={900} value={end} onChange={(e) => setEnd(e.target.value)} className={inputCls} />
                </label>
              </div>

              {start && end && end > start && <DayBar start={start} end={end} />}

              {start && (
                <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Length of the booking">
                  <span className="text-[13px] text-ink-500">Length</span>
                  {LENGTHS.map(([label, minutes]) => {
                    const to = addMinutes(start, minutes)
                    return (
                      <button
                        key={label}
                        type="button"
                        disabled={!to}
                        aria-pressed={Boolean(to) && end === to}
                        onClick={() => to && setEnd(to)}
                        className={`h-8 rounded-md border px-2.5 text-[13px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                          to && end === to ? 'border-ink-900 bg-ink-900 text-white' : 'border-ink-200 bg-white text-ink-700 hover:bg-ink-50'
                        }`}
                      >
                        {label}
                      </button>
                    )
                  })}
                </div>
              )}

              <fieldset>
                <legend className="mb-1.5 text-[13px] font-medium text-ink-700">Rooms free at that time</legend>
                {!ready ? (
                  <p className="rounded-md border border-dashed border-ink-200 px-3 py-3 text-[13px] text-ink-500">
                    {start && end && end <= start ? 'The end time must be after the start time.' : 'Choose a date and a time range to see which rooms are free.'}
                  </p>
                ) : free.isLoading ? (
                  <Loading label="Checking the timetable" />
                ) : free.error ? (
                  <ErrorNote error={free.error} />
                ) : rooms.length === 0 ? (
                  <p className="text-[13px] text-ink-600">No room is free for that whole time. Try a different time.</p>
                ) : (
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                    {rooms.map((r) => (
                      <label
                        key={r.room_id}
                        className={`relative flex cursor-pointer flex-col rounded-md border-2 px-3 py-2 transition-colors focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-brass-500 ${
                          chosen === r.room_id ? 'border-brass-500 bg-brass-50' : 'border-ink-200 bg-white hover:border-ink-300 hover:bg-ink-50'
                        }`}
                      >
                        <input type="radio" name="room" value={r.room_id} checked={chosen === r.room_id} onChange={() => setRoomId(r.room_id)} className="sr-only" />
                        <span aria-hidden className={`absolute right-2 top-2 size-2.5 rounded-full ring-1 ${chosen === r.room_id ? 'bg-brass-500 shadow-[0_0_6px_1px_rgb(210_154_63/0.6)] ring-brass-600' : 'bg-white ring-ink-300'}`} />
                        <span className="font-display text-[18px] font-semibold leading-6">{r.code}</span>
                        <span className="text-[13px] text-ink-500">seats {r.capacity}</span>
                      </label>
                    ))}
                  </div>
                )}
              </fieldset>

              <label className="block">
                <span className="mb-1 block text-[13px] font-medium text-ink-700">Reason</span>
                <textarea
                  required
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  rows={3}
                  className={`${inputCls} h-auto bg-[linear-gradient(transparent_23px,var(--color-ink-100)_24px)] bg-[length:100%_24px] py-[3px] leading-6`}
                  placeholder="What will the room be used for?"
                />
              </label>

              <Button type="submit" busy={send.isPending} disabled={!chosen || reason.trim() === ''}>
                Send request
              </Button>
            </form>
          </div>
        </section>

        <section aria-labelledby="my-requests">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <h2 id="my-requests" className="font-display text-[21px] font-semibold leading-6">
              Your requests
              {mineCount > 0 && <span className="ml-2 text-[15px] font-normal text-ink-400">{mineCount}</span>}
            </h2>
            {mineCount > 2 && (
              <Segmented
                label="Show requests"
                value={mineShow}
                onChange={setMineShow}
                options={[
                  { value: 'all', label: 'All' },
                  { value: 'pending', label: 'Waiting', count: (mine.data ?? []).filter((r) => r.status === 'pending').length },
                  { value: 'approved', label: 'Approved', count: (mine.data ?? []).filter((r) => r.status === 'approved').length },
                ]}
              />
            )}
          </div>
          {mine.isLoading ? (
            <Loading rows={3} />
          ) : mine.error ? (
            <ErrorNote error={mine.error} onRetry={() => void mine.refetch()} />
          ) : mineCount === 0 ? (
            <div className="rounded-md border border-dashed border-ink-300 bg-white/50">
              <EmptyState title="No requests yet">Requests you send appear here with the decision.</EmptyState>
            </div>
          ) : myRequests.length === 0 ? (
            <div className="rounded-md border border-dashed border-ink-300 bg-white/50">
              <EmptyState title="Nothing here">No request of yours is {mineShow === 'pending' ? 'waiting' : 'approved'} right now.</EmptyState>
            </div>
          ) : (
            <ul className="space-y-4">
              {myRequests.map((r) => (
                <li key={r.id} className={slipCls}>
                  <div className="hidden sm:block">
                    <SlipStub code={r.rooms?.code} name={r.rooms?.name} tone={r.status === 'approved' || r.status === 'pending' ? 'brass' : 'ink'} />
                  </div>
                  <div className="flex min-w-0 flex-1 flex-wrap items-start justify-between gap-3 p-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="sm:hidden">{r.rooms && <KeyTag code={r.rooms.code} />}</span>
                        <span className="font-medium">{fmtDate(r.requested_for)}</span>
                        <span className="text-ink-600">{fmtRange(r.start_time, r.end_time)}</span>
                      </div>
                      <DayBar start={r.start_time} end={r.end_time} labels={false} className="mt-2 max-w-[260px]" tone={r.status === 'approved' ? 'good' : r.status === 'pending' ? 'brass' : 'ink'} />
                      <div className="mt-2 text-[13px] text-ink-600">{r.reason}</div>
                      {r.decision_note && (
                        <div className="mt-1.5 border-l-2 border-brass-300 pl-2 text-[13px] text-ink-800">
                          <span className="font-medium">Dean’s note:</span> {r.decision_note}
                        </div>
                      )}
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-2">
                      <StatusStamp status={r.status} />
                      {(r.status === 'pending' || r.status === 'approved') && r.requested_for >= today && (
                        <Button variant="ghost" busy={cancel.isPending && cancel.variables === r.id} onClick={() => cancel.mutate(r.id)}>
                          Cancel
                        </Button>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  )
}

/* ------------------------------------------------------------------ */
/* Dean / administrator: accept or reject                              */
/* ------------------------------------------------------------------ */

function ApproverView() {
  const { profile } = useAuth()
  const qc = useQueryClient()
  const tz = profile?.tenants?.timezone ?? 'Asia/Manila'
  const [notice, setNotice] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null)
  const [rejecting, setRejecting] = useState<RoomRequestRow | null>(null)
  const [note, setNote] = useState('')

  const pending = useQuery({
    queryKey: ['room-requests', 'pending'],
    queryFn: () =>
      unwrap<RoomRequestRow[]>(
        supabase
          .from('room_requests')
          .select(REQUEST_COLUMNS)
          .eq('status', 'pending')
          .order('requested_for')
          .order('start_time'),
      ),
  })
  const decided = useQuery({
    queryKey: ['room-requests', 'decided'],
    queryFn: () =>
      unwrap<RoomRequestRow[]>(
        supabase
          .from('room_requests')
          .select(REQUEST_COLUMNS)
          .neq('status', 'pending')
          .order('decided_at', { ascending: false, nullsFirst: false })
          .order('created_at', { ascending: false })
          .limit(30),
      ),
  })

  const decide = useMutation({
    mutationFn: ({ id, approve, text }: { id: string; approve: boolean; text?: string }) =>
      unwrap(supabase.rpc('decide_room_request', { p_request_id: id, p_approve: approve, p_note: text ?? null })),
    onSuccess: (_d, { approve }) => {
      setNotice({
        tone: 'good',
        text: approve ? 'Approved. The room key will open for the instructor during that time.' : 'Rejected. The instructor can see your note.',
      })
      void qc.invalidateQueries({ queryKey: ['room-requests'] })
      void qc.invalidateQueries({ queryKey: ['free-rooms'] })
      void qc.invalidateQueries({ queryKey: ['audit'] })
    },
    onError: (err) => {
      setNotice({ tone: 'bad', text: friendlyError(err, 'The decision was not saved.') })
      void qc.invalidateQueries({ queryKey: ['room-requests'] })
    },
  })

  const waiting = pending.data ?? []
  const history = decided.data ?? []
  const busyId = decide.isPending ? decide.variables?.id : undefined
  const sorted = useMemo(() => waiting, [waiting])
  const [decisionShow, setDecisionShow] = useState<'all' | 'approved' | 'rejected'>('all')
  const shownHistory = history.filter((r) => decisionShow === 'all' || r.status === decisionShow)

  const accepted = history.filter((r) => r.status === 'approved').length
  const declined = history.filter((r) => r.status === 'rejected').length
  const todayYmd = todayIn(tz)

  return (
    <>
      <header className="mb-9 flex flex-wrap items-end justify-between gap-x-10 gap-y-5">
        <div className="min-w-0 max-w-[60ch]">
          <h1 className="font-display text-[34px] font-semibold leading-none tracking-[-0.02em]">Room requests</h1>
          <p className="mt-2 text-ink-500">
            Instructors ask for rooms that are free at the time. Accepting opens that room’s key for them during the approved time, and the room is taken off the free list.
          </p>
        </div>
        {pending.data && decided.data && (
          <div className="flex items-end gap-4">
            <Spike count={waiting.length} />
            <dl className="flex gap-6 pb-2.5">
              <div className="flex flex-col-reverse">
                <dt className="text-[12.5px] leading-4 text-ink-500">On the spike</dt>
                <dd className="font-display text-[34px] font-semibold leading-9">{waiting.length}</dd>
              </div>
              <div className="flex flex-col-reverse border-l border-ink-200 pl-6">
                <dt className="text-[12.5px] leading-4 text-ink-500">Accepted lately</dt>
                <dd className="font-display text-[34px] font-semibold leading-9 text-emerald-700">{accepted}</dd>
              </div>
              <div className="flex flex-col-reverse border-l border-ink-200 pl-6">
                <dt className="text-[12.5px] leading-4 text-ink-500">Declined lately</dt>
                <dd className="font-display text-[34px] font-semibold leading-9 text-rose-700">{declined}</dd>
              </div>
            </dl>
          </div>
        )}
      </header>

      {notice && (
        <Notice tone={notice.tone} onDismiss={() => setNotice(null)}>
          {notice.text}
        </Notice>
      )}

      <div className="grid gap-9 xl:grid-cols-[minmax(0,1fr)_372px] xl:items-start">
        <section aria-labelledby="waiting-title">
          <h2 id="waiting-title" className="mb-4 font-display text-[21px] font-semibold leading-6">
            Waiting for a decision
          </h2>
          {pending.isLoading ? (
            <Loading rows={3} />
          ) : pending.error ? (
            <ErrorNote error={pending.error} onRetry={() => void pending.refetch()} />
          ) : sorted.length === 0 ? (
            <div className="rounded-md border-2 border-dashed border-ink-300 bg-white/50">
              <EmptyState title="Nothing waiting">New requests appear here the moment an instructor sends one.</EmptyState>
            </div>
          ) : (
            <ul className="space-y-5">
              {sorted.map((r) => (
                <li key={r.id} className={`${slipCls} flex-col sm:flex-row`}>
                  <div className="hidden sm:block">
                    <SlipStub code={r.rooms?.code} name={r.rooms?.name} />
                  </div>
                  <div className="min-w-0 flex-1 px-5 py-4">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span className="font-display text-[21px] font-semibold leading-6">{r.instructors?.full_name ?? 'Instructor'}</span>
                      <span className="sm:hidden">{r.rooms && <KeyTag code={r.rooms.code} />}</span>
                      <DayBadge date={r.requested_for} today={todayYmd} />
                    </div>
                    <div className="mt-1 flex flex-wrap gap-x-3 text-ink-800">
                      <span className="font-medium">{fmtDate(r.requested_for)}</span>
                      <span className="text-ink-600">{fmtRange(r.start_time, r.end_time)}</span>
                    </div>
                    <DayBar start={r.start_time} end={r.end_time} className="mt-3 max-w-[340px]" />
                    <p className="mt-3 max-w-[64ch] text-[14px] text-ink-700">{r.reason}</p>
                    <div className="mt-1.5 text-[12px] text-ink-500">Sent {fmtDateTime(r.created_at, tz)}</div>
                  </div>
                  <div className="relative flex w-full shrink-0 flex-row items-center justify-end gap-2 border-t-2 border-dashed border-ink-200 px-4 py-3 sm:w-[148px] sm:flex-col sm:justify-center sm:border-l-2 sm:border-t-0">
                    <Button className="w-full" busy={busyId === r.id} onClick={() => { setNotice(null); decide.mutate({ id: r.id, approve: true }) }}>
                      Accept
                    </Button>
                    <Button className="w-full" variant="secondary" disabled={busyId === r.id} onClick={() => setRejecting(r)}>
                      Reject
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-labelledby="decided-title" className="xl:sticky xl:top-6">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <h2 id="decided-title" className="font-display text-[21px] font-semibold leading-6">
              Recent decisions
            </h2>
            {history.length > 2 && (
              <Segmented
                label="Show decisions"
                value={decisionShow}
                onChange={setDecisionShow}
                options={[
                  { value: 'all', label: 'All', count: history.length },
                  { value: 'approved', label: 'Approved', count: accepted },
                  { value: 'rejected', label: 'Rejected', count: declined },
                ]}
              />
            )}
          </div>
          <div className="relative overflow-hidden rounded-md bg-white ring-1 ring-ink-200 before:absolute before:inset-y-0 before:left-[14px] before:w-[3px] before:border-x before:border-brass-200 after:pointer-events-none after:absolute after:inset-x-0 after:top-0 after:h-1.5 after:bg-gradient-to-b after:from-ink-100 after:to-transparent">
            {decided.isLoading ? (
              <Loading rows={3} />
            ) : decided.error ? (
              <div className="p-4">
                <ErrorNote error={decided.error} onRetry={() => void decided.refetch()} />
              </div>
            ) : history.length === 0 ? (
              <EmptyState title="No decisions yet" />
            ) : shownHistory.length === 0 ? (
              <EmptyState title="Nothing here">No {decisionShow} decision in the recent list.</EmptyState>
            ) : (
              <ul className="max-h-[640px] divide-y divide-ink-100 overflow-y-auto">
                {shownHistory.map((r) => (
                  <li key={r.id} className="py-3 pl-8 pr-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate font-medium">{r.instructors?.full_name}</div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-ink-600">
                          {r.rooms && <KeyTag code={r.rooms.code} />}
                          <span>{fmtDate(r.requested_for)}</span>
                          <span>{fmtRange(r.start_time, r.end_time)}</span>
                        </div>
                        {r.decision_note && <div className="mt-1.5 text-[13px] text-ink-700">{r.decision_note}</div>}
                      </div>
                      <StatusStamp status={r.status} />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      </div>

      <Modal
        open={rejecting !== null}
        onClose={() => setRejecting(null)}
        title="Reject this request"
        footer={
          <>
            <Button variant="ghost" onClick={() => setRejecting(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={note.trim() === ''}
              onClick={() => {
                if (rejecting) decide.mutate({ id: rejecting.id, approve: false, text: note.trim() })
                setRejecting(null)
                setNote('')
              }}
            >
              Reject request
            </Button>
          </>
        }
      >
        <p className="mb-2 text-[13px] text-ink-600">
          {rejecting?.instructors?.full_name}, {rejecting?.rooms?.code}
          {rejecting ? `, ${fmtDate(rejecting.requested_for)} ${fmtRange(rejecting.start_time, rejecting.end_time)}` : ''}
        </p>
        <label className="block text-[13px] font-medium text-ink-700" htmlFor="reject-note">
          Tell the instructor why
        </label>
        <textarea
          id="reject-note"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={3}
          className={`${inputCls} mt-1 h-auto py-2`}
        />
      </Modal>
    </>
  )
}
