import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ArrowRight, BellRing, LayoutGrid, Layers, Rows3 } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useAuth } from '@/auth/AuthProvider'
import { Segmented } from '@/components/controls'
import { DayTimeline, type TimelineEntry } from '@/components/DayTimeline'
import { KeyTag } from '@/components/KeyTag'
import { Ledger } from '@/components/Ledger'
import { hasClassNow, isFlagged, RoomBoard, RoomFloors } from '@/components/RoomBoard'
import { DecisionBadge, KeyBadge, OccupancyBadge, RequestStatusBadge, ScheduleStatusBadge, keyTagTone } from '@/components/StatusBadges'
import {
  Badge,
  EmptyState,
  ErrorNote,
  Loading,
  Table,
  TBody,
  THead,
  td,
  th,
} from '@/components/ui'
import { useNow } from '@/hooks/useRealtimeSync'
import { useStoredState } from '@/hooks/useStoredState'
import { needsAttention, peopleText, presenceInfo } from '@/lib/presence/labels'
import { unwrap, useActiveTerm, useLockerStatus, useOpsAlerts, usePendingRequestCount, useSchoolHours } from '@/lib/api'
import { alertText, SEVERITY_LABEL } from '@/lib/alerts'
import { DISCREPANCY_LABEL, firstName, reasonLabel } from '@/lib/format'
import { isOps } from '@/lib/roles'
import { supabase } from '@/lib/supabase'
import { fmtDate, fmtMinutes, fmtRange, fmtRelative, nowIn, todayIn, toMinutes } from '@/lib/time'
import { cn } from '@/lib/cn'
import type { AccessLogRow, RoomRequestRow, RoomStatus, ScheduleEntryRow, ScheduleStatus } from '@/lib/types'

export default function Dashboard() {
  const { profile } = useAuth()
  return isOps(profile?.role) ? <OpsDashboard /> : <MyDay />
}

function OpsDashboard() {
  const { profile } = useAuth()
  const tz = profile?.tenants?.timezone ?? 'Asia/Manila'
  const now = useNow(30_000)

  const waiting = usePendingRequestCount(true)
  const rooms = useQuery({
    queryKey: ['room-status'],
    queryFn: () => unwrap<RoomStatus[]>(supabase.from('room_status_now').select('*').order('room_code')),
  })
  const lockers = useLockerStatus()
  const { term } = useActiveTerm()
  const schoolHours = useSchoolHours()
  const clock = nowIn(tz, now)
  // every published meeting of today, to draw the day of each room
  const dayEntries = useQuery({
    queryKey: ['schedule-entries', 'ops-today', term?.id, clock.isoDow],
    enabled: Boolean(term),
    queryFn: () =>
      unwrap<
        { id: string; room_id: string | null; start_time: string; end_time: string; sections: { code: string; courses: { code: string } | null } | null; instructors: { full_name: string } | null }[]
      >(
        supabase
          .from('schedule_entries')
          .select('id, room_id, start_time, end_time, sections(code, courses(code)), instructors(full_name)')
          .eq('term_id', term!.id)
          .eq('day_of_week', clock.isoDow)
          .eq('status', 'published')
          .order('start_time'),
      ),
  })
  const logs = useQuery({
    queryKey: ['access-logs', 'recent'],
    queryFn: () =>
      unwrap<AccessLogRow[]>(
        supabase
          .from('access_logs')
          .select('id, occurred_at, decision, reason, card_uid_presented, instructors(full_name), lockers(compartment_no, rooms(code))')
          .order('occurred_at', { ascending: false })
          .limit(8),
      ),
  })

  const opsAlerts = useOpsAlerts()

  // the board of key tags is the default; the table stays one press away, and the choice is remembered
  const [view, setView] = useStoredState('c360.dashboard.view', 'board', ['board', 'floors', 'table'] as const)
  const [show, setShow] = useStoredState('c360.dashboard.show', 'all', ['all', 'in-use', 'attention'] as const)

  const roomRows = rooms.data ?? []
  const lockerRows = lockers.data ?? []
  const inUse = roomRows.filter((r) => r.schedule_entry_id || r.room_request_id).length
  const issued = lockerRows.filter((l) => l.key_status === 'issued').length
  const outstanding = lockerRows.filter((l) => l.key_status === 'outstanding').length
  const attention = roomRows.filter(needsAttention).length
  // the database's list when it is there; the old count when the database has not been updated yet
  const alertList = opsAlerts.data
  const alerts = alertList ? alertList.length : outstanding + attention

  const flagged = useMemo(() => roomRows.filter(isFlagged).length, [roomRows])
  const shownRooms = useMemo(
    () => (show === 'in-use' ? roomRows.filter(hasClassNow) : show === 'attention' ? roomRows.filter(isFlagged) : roomRows),
    [roomRows, show],
  )
  const timelineRooms = useMemo(
    () => roomRows.map((r) => ({ id: r.room_id, code: r.room_code, key: r.key_status, flagged: isFlagged(r) })),
    [roomRows],
  )
  const timelineEntries: TimelineEntry[] = useMemo(
    () =>
      (dayEntries.data ?? []).map((e) => ({
        id: e.id,
        room_id: e.room_id,
        start_time: e.start_time,
        end_time: e.end_time,
        course: e.sections?.courses?.code ?? e.sections?.code ?? 'Class',
        instructor: e.instructors?.full_name ?? null,
      })),
    [dayEntries.data],
  )
  const hoursToday = useMemo(() => {
    const h = (schoolHours.data ?? []).find((x) => x.day_of_week === clock.isoDow)
    return h ? { open: toMinutes(h.opens_at), close: toMinutes(h.closes_at) } : null
  }, [schoolHours.data, clock.isoDow])
  const lastTap = logs.data?.[0]
  const jumpTo = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' })

  const waitingCount = waiting.data ?? 0
  const alertsShown = !(opsAlerts.error || opsAlerts.isLoading)
  const hoursLabel = hoursToday ? `${fmtMinutes(hoursToday.open)} to ${fmtMinutes(hoursToday.close)}` : 'Closed today'

  return (
    <>
      <header className="mb-6 flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
        <div className="min-w-0 max-w-[62ch]">
          <h1 className="font-display text-[34px] font-semibold leading-none tracking-[-0.02em]">Campus overview</h1>
          <p className="mt-2 text-ink-500">{`${nowIn(tz, now).label}. This page updates as keys are taken and returned.`}</p>
        </div>
        {waitingCount > 0 && (
          <Link
            to="/requests"
            className="group flex items-center gap-3 rounded-md bg-brass-50 py-2.5 pl-3.5 pr-4 text-brass-700 shadow-[0_10px_16px_-12px_rgb(125_81_18/0.7)] ring-1 ring-brass-300 transition-colors hover:bg-brass-100"
          >
            <span aria-hidden className="size-3.5 shrink-0 rounded-full bg-canvas shadow-[inset_0_1px_2px_rgb(11_21_36/0.3)] ring-1 ring-brass-300" />
            <span className="font-medium">
              {waitingCount} room request{waitingCount === 1 ? '' : 's'} waiting for a decision
            </span>
            <span className="inline-flex items-center gap-1 text-[13px] font-medium">
              Review <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" aria-hidden />
            </span>
          </Link>
        )}
      </header>

      <Ledger
        figures={[
          {
            label: 'Rooms in use',
            value: inUse,
            hint: `of ${roomRows.length} rooms`,
            lamps: { lit: inUse, of: roomRows.length },
            onClick: () => {
              setShow('in-use')
              jumpTo('rooms-now')
            },
          },
          { label: 'Keys out', value: issued, hint: 'taken for a class in session', lamps: { lit: issued, of: lockerRows.length }, to: '/lockers' },
          {
            label: 'Keys not returned',
            value: outstanding,
            hint: 'class ended, key still out',
            bad: outstanding > 0,
            lamps: { lit: outstanding, of: lockerRows.length },
            to: '/lockers',
          },
          {
            label: 'Alerts',
            value: alerts,
            hint: alertList ? 'things to look at, listed below' : 'unreturned keys and rooms to look at',
            bad: alerts > 0,
            lamps: { lit: Math.min(alerts, 8), of: 8 },
            onClick: () => jumpTo(alertList ? 'alerts' : 'rooms-now'),
          },
        ]}
        footer={
          logs.isLoading ? (
            <span className="text-ink-400">Reading the locker log…</span>
          ) : lastTap ? (
            <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <span aria-hidden className={`size-2 shrink-0 rounded-full ${lastTap.decision === 'granted' ? 'bg-brass-400' : 'bg-rose-400'}`} />
              <span>
                Last tap {fmtRelative(lastTap.occurred_at, now.getTime())}: {lastTap.instructors?.full_name ?? 'Unknown card'}
                {lastTap.decision === 'granted' && lastTap.lockers?.rooms?.code ? `, ${lastTap.lockers.rooms.code}` : ''}, {lastTap.decision === 'granted' ? 'let in' : 'refused'}
              </span>
            </span>
          ) : (
            <span className="text-ink-400">No taps at the locker station yet.</span>
          )
        }
      />

      <div className={cn('mb-10 mt-8 grid gap-x-8 gap-y-8', alertsShown && 'xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]')}>
        <AlertsCard tz={tz} now={now.getTime()} query={opsAlerts} />

        <section aria-labelledby="attempts-title">
          <h2 id="attempts-title" className="font-display text-[21px] font-semibold leading-6">
            Recent locker attempts
          </h2>
          <p className="mb-5 text-[13.5px] text-ink-500">Denied attempts are recorded as fully as granted ones.</p>
          {logs.isLoading ? (
            <Loading />
          ) : logs.error ? (
            <ErrorNote error={logs.error} />
          ) : (logs.data ?? []).length === 0 ? (
            <div className="rounded-md border border-dashed border-ink-300 bg-white/50">
              <EmptyState title="No attempts yet">Taps at the locker station will appear here.</EmptyState>
            </div>
          ) : (
            <div className="tape bg-[#fffef9] px-4 py-1 shadow-[0_10px_18px_-14px_rgb(11_21_36/0.5)] ring-1 ring-ink-200/80">
              <ul className="divide-y divide-dashed divide-ink-200">
                {(logs.data ?? []).map((a) => (
                  <li key={a.id} className="flex items-start justify-between gap-3 py-3">
                    <div className="min-w-0">
                      <div className="truncate font-medium">{a.instructors?.full_name ?? 'Unknown card'}</div>
                      <div className="text-[13px] text-ink-500">
                        {/* a denied tap opened nothing, and the station files it under whichever door it tried first, so no room is named */}
                        {a.decision === 'granted' ? `${a.lockers?.rooms?.code ?? 'Locker'}: ` : ''}
                        {reasonLabel(a.reason)}
                      </div>
                    </div>
                    <div className="shrink-0 text-right">
                      <DecisionBadge decision={a.decision} />
                      <div className="mt-1 font-mono text-[11.5px] text-ink-500">{fmtRelative(a.occurred_at)}</div>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      </div>

      {roomRows.length > 0 && (
        <section id="today" aria-labelledby="today-title" className="mb-10 scroll-mt-4">
          {/* a drawing sheet: a frame inside a frame, and a title block in the corner, as on a floor plan */}
          <div className="bg-white p-1.5 shadow-[0_10px_20px_-16px_rgb(11_21_36/0.6)] ring-1 ring-ink-300">
            <div className="border border-ink-400/70">
              <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2 border-b border-ink-300/80 px-4 py-3">
                <div>
                  <h2 id="today-title" className="font-display text-[21px] font-semibold leading-6">
                    Today on the clock
                  </h2>
                  <p className="text-[13px] text-ink-500">Every room across the school day. The brass line is now.</p>
                </div>
              </div>
              {dayEntries.error ? (
                <div className="p-4">
                  <ErrorNote error={dayEntries.error} onRetry={() => void dayEntries.refetch()} />
                </div>
              ) : (
                <div className="drafting-sheet">
                  <DayTimeline rooms={timelineRooms} entries={timelineEntries} nowMinutes={clock.minutes} hours={hoursToday} />
                </div>
              )}
              <dl className="ml-auto grid w-full max-w-[420px] grid-cols-3 border-l border-t border-ink-400/70 text-[12px] leading-4 sm:w-[420px]">
                {[
                  ['Sheet', 'Day plan'],
                  ['Open', hoursLabel],
                  ['Rooms', String(roomRows.length)],
                ].map(([k, v], i) => (
                  <div key={k} className={cn('px-2.5 py-1.5', i > 0 && 'border-l border-ink-300/80')}>
                    <dt className="text-ink-500">{k}</dt>
                    <dd className="font-medium text-ink-800">{v}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </div>
        </section>
      )}

      <section id="rooms-now" aria-labelledby="rooms-now-title" className="scroll-mt-4">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
          <div>
            <h2 id="rooms-now-title" className="font-display text-[21px] font-semibold leading-6">
              Rooms right now
            </h2>
            <p className="text-[13.5px] text-ink-500">Scheduled class, key and camera reading side by side.</p>
          </div>
          {roomRows.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <Segmented
                label="Show rooms"
                value={show}
                onChange={setShow}
                options={[
                  { value: 'all', label: 'All', count: roomRows.length },
                  { value: 'in-use', label: 'In use', count: inUse },
                  { value: 'attention', label: 'Needs a look', count: flagged },
                ]}
              />
              <Segmented
                label="View rooms as"
                value={view}
                onChange={setView}
                options={[
                  {
                    value: 'board',
                    label: (
                      <>
                        <LayoutGrid className="size-4" aria-hidden />
                        <span className="sr-only">Board</span>
                      </>
                    ),
                  },
                  {
                    value: 'floors',
                    label: (
                      <>
                        <Layers className="size-4" aria-hidden />
                        <span className="sr-only">Floors</span>
                      </>
                    ),
                  },
                  {
                    value: 'table',
                    label: (
                      <>
                        <Rows3 className="size-4" aria-hidden />
                        <span className="sr-only">Table</span>
                      </>
                    ),
                  },
                ]}
              />
            </div>
          )}
        </div>
        <div className={view === 'table' ? 'overflow-hidden rounded-md bg-white ring-1 ring-ink-200' : 'rounded-xl bg-ink-100/70 ring-1 ring-ink-200/80'}>
          {rooms.isLoading ? (
            <Loading rows={4} />
          ) : rooms.error ? (
            <div className="p-4">
              <ErrorNote error={rooms.error} />
            </div>
          ) : roomRows.length === 0 ? (
            <EmptyState title="No rooms yet">Add rooms to the institution to see their status here.</EmptyState>
          ) : shownRooms.length === 0 ? (
            <EmptyState title={show === 'attention' ? 'No room needs a look' : 'No room has a class now'}>
              {show === 'attention' ? 'Every room matches its timetable, key and camera.' : 'Rooms with a class or an approved request in this hour appear here.'}
            </EmptyState>
          ) : view === 'board' ? (
            <RoomBoard rooms={shownRooms} now={now.getTime()} />
          ) : view === 'floors' ? (
            <RoomFloors rooms={shownRooms} now={now.getTime()} />
          ) : (
            <Table>
              <THead>
                <tr>
                  <th className={th}>Room</th>
                  <th className={th}>Class now</th>
                  <th className={th}>Instructor</th>
                  <th className={th}>Key</th>
                  <th className={th}>Camera</th>
                </tr>
              </THead>
              <TBody>
                {shownRooms.map((r) => (
                  <tr key={r.room_id} className={presenceInfo(r.presence)?.tone === 'bad' || (!r.presence && r.discrepancy) ? 'bg-rose-50/50' : undefined}>
                    <td className={td}>
                      <KeyTag code={r.room_code} tone={keyTagTone(r.key_status)} />
                    </td>
                    <td className={td}>
                      {(r.schedule_entry_id || r.room_request_id) && r.start_time && r.end_time ? (
                        <>
                          <div className="font-medium">{r.course_code}</div>
                          <div className="text-[13px] text-ink-500">{fmtRange(r.start_time, r.end_time)}</div>
                        </>
                      ) : (
                        <span className="text-ink-400">No class</span>
                      )}
                    </td>
                    <td className={td}>{r.instructor_name ?? <span className="text-ink-400">None</span>}</td>
                    <td className={td}>
                      <KeyBadge status={r.key_status} />
                    </td>
                    <td className={td}>
                      <div className="flex flex-wrap items-center gap-2">
                        <OccupancyBadge occupied={r.is_occupied} />
                        {r.is_occupied !== null && <span className="text-[13px] text-ink-500">{peopleText(r.person_count, r.is_occupied)}</span>}
                      </div>
                      {presenceInfo(r.presence) ? (
                        <div className="mt-1" title={presenceInfo(r.presence)!.why}>
                          <Badge tone={presenceInfo(r.presence)!.tone}>{presenceInfo(r.presence)!.label}</Badge>
                        </div>
                      ) : (
                        r.discrepancy && (
                          <div className="mt-1">
                            <Badge tone="bad">{DISCREPANCY_LABEL[r.discrepancy]}</Badge>
                          </div>
                        )
                      )}
                    </td>
                  </tr>
                ))}
              </TBody>
            </Table>
          )}
        </div>
      </section>
    </>
  )
}

function AlertsCard({ tz, now, query }: { tz: string; now: number; query: ReturnType<typeof useOpsAlerts> }) {
  // a database without migration 11 has no alert list: the page keeps working with the old counts
  if (query.error || query.isLoading) return null
  const list = query.data ?? []
  return (
    <section id="alerts" aria-labelledby="alerts-title" className="scroll-mt-4">
      <h2 id="alerts-title" className="font-display text-[21px] font-semibold leading-6">
        Alerts
      </h2>
      <p className="mb-4 text-[13.5px] text-ink-500">Shown while the cause lasts: a key comes back, the station reports again, or a denied tap is more than a day old.</p>
      {list.length === 0 ? (
        <div className="flex items-center gap-3 rounded-md bg-white px-4 py-4 text-ink-700 ring-1 ring-ink-200">
          <span aria-hidden className="size-2.5 rounded-full bg-emerald-500 shadow-[0_0_8px_2px_rgb(16_185_129/0.45)]" />
          Nothing needs attention right now.
        </div>
      ) : (
        <ul className="space-y-2.5">
          {list.map((a) => {
            const t = alertText(a, tz, now)
            return (
              <li key={a.ref + a.kind} className="flex items-stretch overflow-hidden rounded-md bg-white ring-1 ring-ink-200">
                <span aria-hidden className={cn('w-1.5 shrink-0', t.tone === 'bad' ? 'bg-rose-500' : t.tone === 'warn' ? 'bg-amber-400' : 'bg-ink-300')} />
                <div className="flex min-w-0 flex-1 items-start gap-3 px-3.5 py-3">
                  <span
                    className={cn(
                      'mt-0.5 grid size-8 shrink-0 place-items-center rounded-full',
                      t.tone === 'bad' ? 'bg-rose-50 text-rose-700' : t.tone === 'warn' ? 'bg-amber-50 text-amber-700' : 'bg-ink-100 text-ink-500',
                    )}
                  >
                    <BellRing className="size-4" aria-hidden />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="font-medium">{t.title}</div>
                    <div className="text-[13px] text-ink-600">{t.detail}</div>
                  </div>
                  <Badge tone={t.tone}>{SEVERITY_LABEL[a.severity]}</Badge>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

/** Dashboard for program chairs and instructors: today's published classes in their own scope. */
function MyDay() {
  const { profile } = useAuth()
  const tz = profile?.tenants?.timezone ?? 'Asia/Manila'
  const now = useNow(60_000)
  const today = nowIn(tz, now)
  const { term } = useActiveTerm()
  const isChair = profile?.role === 'program_chair'

  const classes = useQuery({
    queryKey: ['schedule-entries', 'today', term?.id, today.isoDow],
    enabled: Boolean(term),
    queryFn: () =>
      unwrap<ScheduleEntryRow[]>(
        supabase
          .from('schedule_entries')
          .select(
            'id, term_id, section_id, program_id, instructor_id, room_id, day_of_week, start_time, end_time, status, sections(code, courses(code, title)), instructors(full_name), rooms(code, name)',
          )
          .eq('term_id', term!.id)
          .eq('day_of_week', today.isoDow)
          .eq('status', 'published')
          .order('start_time'),
      ),
  })

  const isInstructor = profile?.role === 'instructor'
  const upcoming = useQuery({
    queryKey: ['room-requests', 'upcoming'],
    enabled: isInstructor,
    queryFn: () =>
      unwrap<RoomRequestRow[]>(
        supabase
          .from('room_requests')
          .select('id, instructor_id, room_id, requested_for, start_time, end_time, reason, status, decided_at, decision_note, created_at, instructors(full_name), rooms(code, name)')
          .in('status', ['pending', 'approved'])
          .gte('requested_for', todayIn(tz))
          .order('requested_for')
          .order('start_time')
          .limit(5),
      ),
  })

  const pipeline = useQuery({
    queryKey: ['schedule-entries', 'pipeline', term?.id],
    enabled: Boolean(term) && isChair,
    queryFn: () => unwrap<{ status: ScheduleStatus }[]>(supabase.from('schedule_entries').select('status').eq('term_id', term!.id)),
  })

  const nextId = (classes.data ?? []).find((e) => toMinutes(e.start_time) > today.minutes)?.id
  const counts = new Map<ScheduleStatus, number>()
  ;(pipeline.data ?? []).forEach((e) => counts.set(e.status, (counts.get(e.status) ?? 0) + 1))
  const name = firstName(profile?.full_name)

  const meetings = classes.data ?? []
  const total = [...counts.values()].reduce((a, b) => a + b, 0)
  const STAGE_BAR: Record<ScheduleStatus, string> = { draft: 'bg-ink-300', submitted: 'bg-amber-400', approved: 'bg-emerald-500', published: 'bg-brass-500', returned: 'bg-rose-500' }

  return (
    <>
      <header className="mb-8 max-w-[64ch]">
        <h1 className="font-display text-[34px] font-semibold leading-none tracking-[-0.02em]">{name ? `Today’s classes, ${name}` : 'Today’s classes'}</h1>
        <p className="mt-2 text-ink-500">{`${today.label}. Tap your ID card at the locker station during your class to take the room key.`}</p>
      </header>

      {isChair && (
        <section aria-labelledby="stand-title" className="mb-10">
          <h2 id="stand-title" className="font-display text-[21px] font-semibold leading-6">
            Where your schedules stand
          </h2>
          <div className="mt-3 rounded-md bg-white p-4 ring-1 ring-ink-200">
            {pipeline.isLoading ? (
              <Loading />
            ) : counts.size === 0 ? (
              <p className="text-ink-500">No class meetings have been added for this term yet.</p>
            ) : (
              <>
                {/* the whole term as one bar: how much of it is at each step of the way to being published */}
                <div className="flex h-3 overflow-hidden rounded-full bg-ink-100 ring-1 ring-inset ring-ink-200" aria-hidden>
                  {(['draft', 'submitted', 'approved', 'published', 'returned'] as ScheduleStatus[]).map((st) =>
                    counts.get(st) ? <span key={st} className={STAGE_BAR[st]} style={{ width: `${((counts.get(st) ?? 0) / total) * 100}%` }} /> : null,
                  )}
                </div>
                <div className="mt-3.5 flex flex-wrap gap-x-5 gap-y-2">
                  {[...counts.entries()].map(([s, n]) => (
                    <span key={s} className="inline-flex items-center gap-2">
                      <ScheduleStatusBadge status={s} />
                      <span className="text-ink-600">{n} class {n === 1 ? 'meeting' : 'meetings'}</span>
                    </span>
                  ))}
                </div>
              </>
            )}
          </div>
        </section>
      )}

      {isInstructor && (upcoming.data ?? []).length > 0 && (
        <section aria-labelledby="mine-title" className="mb-10">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 id="mine-title" className="font-display text-[21px] font-semibold leading-6">
                Your room requests
              </h2>
              <p className="text-[13.5px] text-ink-500">Rooms you asked for outside your timetable.</p>
            </div>
            <Link to="/requests" className="text-[13px] font-medium text-ink-700 underline underline-offset-2">
              Manage
            </Link>
          </div>
          <ul className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {(upcoming.data ?? []).map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-3 rounded-md bg-[#fffdf7] py-2.5 pl-3.5 pr-3 ring-1 ring-ink-200">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    {r.rooms && <KeyTag code={r.rooms.code} />}
                    <span className="font-medium">{fmtDate(r.requested_for)}</span>
                  </div>
                  <div className="mt-0.5 text-[13px] text-ink-600">{fmtRange(r.start_time, r.end_time)}</div>
                </div>
                <RequestStatusBadge status={r.status} />
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="today-classes">
        <h2 id="today-classes" className="mb-4 font-display text-[21px] font-semibold leading-6">
          Published classes today
        </h2>
        {classes.isLoading || !term ? (
          <Loading />
        ) : classes.error ? (
          <ErrorNote error={classes.error} />
        ) : meetings.length === 0 ? (
          <div className="rounded-md border-2 border-dashed border-ink-300 bg-white/50">
            <EmptyState title="No classes today">Published classes for today appear here.</EmptyState>
          </div>
        ) : (
          <ol className="relative">
            {/* the day as one line from the first class to the last, with a node for each: filled when it is over, lit while it is on */}
            <span aria-hidden className="absolute bottom-3 left-[117px] top-3 hidden w-px bg-ink-300 sm:block" />
            {meetings.map((e) => {
              // what is happening now, what comes next, and what is over: the day reads from top to bottom
              const state = toMinutes(e.end_time) <= today.minutes ? 'done' : toMinutes(e.start_time) <= today.minutes ? 'now' : e.id === nextId ? 'next' : 'later'
              return (
                <li key={e.id} className="relative flex flex-col gap-1.5 py-2 sm:flex-row sm:items-stretch sm:gap-0">
                  <div className={cn('w-[104px] shrink-0 pr-3 sm:text-right', state === 'done' ? 'text-ink-400' : 'text-ink-900')}>
                    <div className="text-[13.5px] font-medium leading-5">{fmtRange(e.start_time, e.end_time)}</div>
                    {state === 'now' && (
                      <div className="mt-1">
                        <Badge tone="brass" dot>
                          Now
                        </Badge>
                      </div>
                    )}
                    {state === 'next' && (
                      <div className="mt-1">
                        <Badge dot>Next</Badge>
                      </div>
                    )}
                  </div>
                  <span
                    aria-hidden
                    className={cn(
                      'relative z-10 mt-1.5 hidden size-3.5 shrink-0 rounded-full ring-4 ring-canvas sm:block sm:translate-x-[3px]',
                      state === 'done' && 'bg-ink-300',
                      state === 'now' && 'bg-brass-500 shadow-[0_0_10px_3px_rgb(210_154_63/0.55)]',
                      state === 'next' && 'border-2 border-brass-500 bg-white',
                      state === 'later' && 'border-2 border-ink-300 bg-white',
                    )}
                  />
                  <div
                    className={cn(
                      'min-w-0 flex-1 rounded-md px-4 py-3 ring-1 sm:ml-5',
                      state === 'done' && 'bg-white/50 text-ink-400 ring-ink-200/70',
                      state === 'now' && 'bg-brass-50 ring-brass-300 shadow-[0_10px_18px_-14px_rgb(125_81_18/0.7)]',
                      (state === 'next' || state === 'later') && 'bg-white ring-ink-200',
                    )}
                  >
                    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1.5">
                      <div className="min-w-0">
                        <div className={cn('font-display text-[19px] font-semibold leading-6', state === 'done' && 'text-ink-500')}>{e.sections?.courses?.code}</div>
                        <div className="text-[13px] text-ink-500">{e.sections?.courses?.title}</div>
                        {isChair && e.instructors?.full_name && <div className="mt-1 text-[13px] text-ink-700">{e.instructors.full_name}</div>}
                      </div>
                      {e.rooms && <KeyTag code={e.rooms.code} size="lg" tone={state === 'now' ? 'brass' : 'ink'} />}
                    </div>
                  </div>
                </li>
              )
            })}
          </ol>
        )}
      </section>
    </>
  )
}
