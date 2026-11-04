import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Download } from 'lucide-react'
import { useAuth } from '@/auth/AuthProvider'
import { SortTh, useSort } from '@/components/controls'
import { Button, ErrorNote, inputCls, Loading, Notice, Table, TBody, THead, td } from '@/components/ui'
import { cn } from '@/lib/cn'
import { fetchAll, unwrap, useActiveTerm, useRooms } from '@/lib/api'
import { downloadText } from '@/lib/download'
import { friendlyError } from '@/lib/errors'
import { auditCsv, checkRange, keyReturnsCsv, reportFilename, tapsCsv, usageCsv, type KeyReturnReportRow, type TapReportRow } from '@/lib/reports'
import { supabase } from '@/lib/supabase'
import { sortRows } from '@/lib/tableView'
import { addDays, dayStartIso, todayIn } from '@/lib/time'
import type { AuditRow, SchoolHour } from '@/lib/types'
import { roomUsage, type UsageMeeting } from '@/lib/usage'
import { fmtPercent } from '@/lib/evaluation/metrics'

type Kind = 'taps' | 'key-returns' | 'audit'

const SOURCE: Record<Kind, { table: 'access_logs' | 'key_return_events' | 'audit_logs'; column: 'occurred_at' | 'created_at' }> = {
  taps: { table: 'access_logs', column: 'occurred_at' },
  'key-returns': { table: 'key_return_events', column: 'occurred_at' },
  audit: { table: 'audit_logs', column: 'created_at' },
}

/** "Mon 26 Oct" for a YYYY-MM-DD day. */
function dayLabel(ymd: string): string {
  const d = new Date(`${ymd}T00:00:00Z`)
  return Number.isNaN(d.getTime()) ? ymd : d.toLocaleDateString('en-PH', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })
}

/** The days picked, drawn as a row of day slots: weekends are lighter, so "7 days" shows as a week. */
function DayRuler({ from, days }: { from: string; days: number }) {
  const shown = Math.min(days, 62)
  const start = Date.parse(`${from}T00:00:00Z`)
  return (
    <div className="flex h-8 items-end gap-[3px]" aria-hidden>
      {Array.from({ length: shown }, (_, i) => {
        const dow = new Date(start + i * 86_400_000).getUTCDay()
        const weekend = dow === 0 || dow === 6
        return <span key={i} className={cn('min-w-[3px] max-w-[18px] flex-1 rounded-t-[2px]', weekend ? 'h-4 bg-brass-700' : 'h-7 bg-brass-400')} />
      })}
      {days > shown && <span className="pb-0.5 pl-1 text-[12px] text-ink-300">and {days - shown} more</span>}
    </div>
  )
}

export default function Reports() {
  const { profile } = useAuth()
  const tz = profile?.tenants?.timezone ?? 'Asia/Manila'
  const today = todayIn(tz)
  const [from, setFrom] = useState(() => addDays(today, -6))
  const [to, setTo] = useState(today)
  const [busy, setBusy] = useState<Kind | 'usage' | null>(null)
  const [error, setError] = useState<string | null>(null)

  const range = useMemo(() => checkRange(from, to, (ymd) => dayStartIso(ymd, tz)), [from, to, tz])

  function pick(days: number) {
    setFrom(addDays(today, -(days - 1)))
    setTo(today)
  }

  async function download(kind: Kind) {
    if (!range.ok || !range.fromIso || !range.toIso) return
    const { fromIso, toIso } = range
    setBusy(kind)
    setError(null)
    try {
      let text: string
      if (kind === 'taps') {
        const rows = await fetchAll<TapReportRow>((a, b) =>
          supabase
            .from('access_logs')
            .select('id, occurred_at, decision, reason, card_uid_presented, latency_ms, instructors(full_name), lockers(compartment_no, rooms(code))')
            .gte('occurred_at', fromIso)
            .lt('occurred_at', toIso)
            .order('occurred_at')
            .order('id')
            .range(a, b),
        )
        text = tapsCsv(rows, tz)
      } else if (kind === 'key-returns') {
        const rows = await fetchAll<KeyReturnReportRow>((a, b) =>
          supabase
            .from('key_return_events')
            .select('id, occurred_at, key_detected, lockers(compartment_no, rooms(code)), access_logs(instructors(full_name))')
            .gte('occurred_at', fromIso)
            .lt('occurred_at', toIso)
            .order('occurred_at')
            .order('id')
            .range(a, b),
        )
        text = keyReturnsCsv(rows, tz)
      } else {
        const rows = await fetchAll<AuditRow>((a, b) =>
          supabase
            .from('audit_logs')
            .select('id, created_at, action, table_name, record_id, justification, old_data, new_data, profiles(full_name, email)')
            .gte('created_at', fromIso)
            .lt('created_at', toIso)
            .order('created_at')
            .order('id')
            .range(a, b),
        )
        text = auditCsv(rows, tz)
      }
      downloadText(reportFilename(kind, from, to), text)
    } catch (e) {
      setError(friendlyError(e, 'The file could not be made.'))
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <header className="mb-7 max-w-[62ch]">
        <h1 className="font-display text-[34px] font-semibold leading-none tracking-[-0.02em]">Reports</h1>
        <p className="mt-2 text-ink-500">Files for the administration, the panel and the paper. They open in Excel. Times are the school’s clock.</p>
      </header>

      {/* the period: a dark counter plate with the dates, quick ranges and a ruler of the days picked */}
      <section aria-labelledby="period-h" className="relative overflow-hidden rounded-lg bg-ink-900 p-5 text-white shadow-[0_16px_28px_-22px_rgb(11_21_36/0.7)] ring-1 ring-ink-800 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-x-8 gap-y-5">
          <div className="min-w-0 max-w-[40ch]">
            <h2 id="period-h" className="font-display text-[22px] font-semibold leading-7">Days to include</h2>
            <p className="mt-1 text-[13.5px] text-ink-300">Applies to the first three reports. The last day picked is included.</p>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <label className="block">
              <span className="mb-1 block text-[13px] font-medium text-ink-300">First day</span>
              <input type="date" className={`${inputCls} w-[11rem]`} value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />
            </label>
            <label className="block">
              <span className="mb-1 block text-[13px] font-medium text-ink-300">Last day</span>
              <input type="date" className={`${inputCls} w-[11rem]`} value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
            </label>
          </div>
        </div>

        <div className="mt-5 flex flex-wrap items-end justify-between gap-x-8 gap-y-4 border-t border-ink-700 pt-5">
          <div className="min-w-[14rem] flex-1">
            {range.ok ? (
              <>
                <div className="mb-2 flex flex-wrap items-baseline gap-x-3 text-[13.5px]">
                  <span className="font-display text-[26px] font-semibold leading-8 tabular-nums">{range.days}</span>
                  <span className="text-ink-300">{range.days === 1 ? 'day' : 'days'}, {range.days === 1 ? dayLabel(from) : `${dayLabel(from)} to ${dayLabel(to)}`}</span>
                </div>
                <DayRuler from={from} days={range.days ?? 0} />
              </>
            ) : (
              <p className="text-[14px] text-rose-300">{range.problem}</p>
            )}
          </div>
          <div className="flex flex-wrap gap-2" role="group" aria-label="Quick ranges">
            {(
              [
                ['Today', 1],
                ['Last 7 days', 7],
                ['Last 30 days', 30],
              ] as const
            ).map(([label, days]) => {
              const on = to === today && from === addDays(today, -(days - 1))
              return (
                <button
                  key={label}
                  type="button"
                  aria-pressed={on}
                  onClick={() => pick(days)}
                  className={cn(
                    'rounded-md px-3.5 py-2 text-[14px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-brass-300',
                    on ? 'bg-brass-400 text-ink-950' : 'bg-ink-800 text-ink-100 ring-1 ring-ink-600 hover:bg-ink-700',
                  )}
                >
                  {label}
                </button>
              )
            })}
          </div>
        </div>
      </section>

      {error && (
        <div className="mt-4">
          <Notice tone="bad" onDismiss={() => setError(null)}>
            {error}
          </Notice>
        </div>
      )}

      <div className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-3">
        <ReportCard
          kind="taps"
          title="Locker taps"
          text="Every card tap at the locker: who, which room and door, granted or denied, why, and how long it took."
          range={range}
          busy={busy === 'taps'}
          onDownload={() => void download('taps')}
        />
        <ReportCard
          kind="key-returns"
          title="Key returns"
          text="Every time a locker door was closed, and whether the key switch saw the key."
          range={range}
          busy={busy === 'key-returns'}
          onDownload={() => void download('key-returns')}
        />
        <ReportCard
          kind="audit"
          title="Audit log"
          text="Approvals, returns, overrides and other changes, with the reason that was given."
          range={range}
          busy={busy === 'audit'}
          onDownload={() => void download('audit')}
        />
      </div>

      <div className="mt-8">
        <UsageCard
          tz={tz}
          busy={busy === 'usage'}
          setBusy={(b) => setBusy(b ? 'usage' : null)}
          setError={setError}
        />
      </div>
    </>
  )
}

function ReportCard({
  kind,
  title,
  text,
  range,
  busy,
  onDownload,
}: {
  kind: Kind
  title: string
  text: string
  range: ReturnType<typeof checkRange>
  busy: boolean
  onDownload: () => void
}) {
  const src = SOURCE[kind]
  const count = useQuery({
    queryKey: ['report-count', kind, range.fromIso, range.toIso],
    enabled: range.ok,
    retry: false,
    queryFn: async () => {
      const r = await supabase
        .from(src.table)
        .select('id', { count: 'exact', head: true })
        .gte(src.column, range.fromIso!)
        .lt(src.column, range.toIso!)
      if (r.error) throw new Error(r.error.message)
      return r.count ?? 0
    },
  })

  return (
    <section className="printout flex flex-col rounded-[3px] px-9 pb-6 pt-5 shadow-[0_1px_0_rgb(11_21_36/0.1),0_16px_24px_-16px_rgb(11_21_36/0.55)] ring-1 ring-ink-200">
      <h2 className="font-display text-[22px] font-semibold leading-7">{title}</h2>
      <p className="mt-1.5 text-[14px] leading-[24px] text-ink-600">{text}</p>
      <div className="mt-auto pt-5">
        <p className="mb-3 min-h-[38px] text-[14px]" aria-live="polite">
          {!range.ok ? (
            <span className="text-ink-400">Pick the days first.</span>
          ) : count.isLoading ? (
            <span className="text-ink-500">Counting…</span>
          ) : count.error ? (
            <span className="text-ink-500">Could not count the rows.</span>
          ) : (
            <>
              <strong className="font-mono text-[30px] font-semibold leading-9 tabular-nums">{count.data}</strong>{' '}
              <span className="text-ink-600">
                {count.data === 1 ? 'row' : 'rows'} in these {range.days} {range.days === 1 ? 'day' : 'days'}
              </span>
            </>
          )}
        </p>
        <Button variant="secondary" busy={busy} disabled={!range.ok || count.data === 0} onClick={onDownload}>
          <Download className="size-4" aria-hidden />
          Download CSV
        </Button>
      </div>
    </section>
  )
}

function UsageCard({ tz, busy, setBusy, setError }: { tz: string; busy: boolean; setBusy: (b: boolean) => void; setError: (e: string | null) => void }) {
  const { term } = useActiveTerm()
  const rooms = useRooms()
  const hours = useQuery({
    queryKey: ['school-hours-report'],
    queryFn: () => unwrap<SchoolHour[]>(supabase.from('school_hours').select('day_of_week, opens_at, closes_at').order('day_of_week')),
  })
  const meetings = useQuery({
    queryKey: ['usage-meetings', term?.id],
    enabled: Boolean(term),
    queryFn: () =>
      fetchAll<UsageMeeting>((a, b) =>
        supabase
          .from('schedule_entries')
          .select('room_id, day_of_week, start_time, end_time')
          .eq('term_id', term!.id)
          .eq('status', 'published')
          .order('id')
          .range(a, b),
      ),
  })

  const usage = useMemo(() => roomUsage(rooms.data ?? [], meetings.data ?? [], hours.data ?? []), [rooms.data, meetings.data, hours.data])
  const sort = useSort<'room' | 'meetings' | 'scheduled' | 'open' | 'share'>(null)
  const shownUsage = useMemo(() => {
    if (!sort.key) return usage
    const get = {
      room: (u: (typeof usage)[number]) => u.code,
      meetings: (u: (typeof usage)[number]) => u.meetings,
      scheduled: (u: (typeof usage)[number]) => u.scheduledHours,
      open: (u: (typeof usage)[number]) => u.openHours,
      share: (u: (typeof usage)[number]) => u.share,
    }[sort.key]
    return sortRows(usage, get, sort.dir)
  }, [usage, sort.key, sort.dir])
  const loading = rooms.isLoading || hours.isLoading || meetings.isLoading
  const error = rooms.error ?? hours.error ?? meetings.error

  function download() {
    setBusy(true)
    setError(null)
    try {
      downloadText(`classroom360-room-usage-${todayIn(tz)}.csv`, usageCsv(usage))
    } catch (e) {
      setError(friendlyError(e, 'The file could not be made.'))
    } finally {
      setBusy(false)
    }
  }

  const shares = usage.map((u) => u.share).filter((x): x is number => x !== null)
  const average = shares.length > 0 ? shares.reduce((n, x) => n + x, 0) / shares.length : null
  const busiest = usage.reduce<(typeof usage)[number] | null>((best, u) => (u.share !== null && (best === null || (best.share ?? -1) < u.share) ? u : best), null)

  return (
    <section className="overflow-hidden rounded-lg bg-white shadow-[0_16px_28px_-22px_rgb(11_21_36/0.55)] ring-1 ring-ink-200">
      <div className="bg-ink-900 px-5 pb-5 pt-4 text-white">
        <div className="flex flex-wrap items-start justify-between gap-x-8 gap-y-3">
          <div className="min-w-0 max-w-[60ch]">
            <h2 className="font-display text-[24px] font-semibold leading-8">Room usage in a normal week</h2>
            <p className="text-[13.5px] text-ink-300">
              {term ? `Published class meetings in ${term.name}, against the hours the school is open.` : 'Published class meetings against the hours the school is open.'}
            </p>
          </div>
          <Button variant="secondary" busy={busy} disabled={usage.length === 0} onClick={download}>
            <Download className="size-4" aria-hidden />
            Download CSV
          </Button>
        </div>
        {!loading && !error && usage.length > 0 && (
          <dl className="mt-4 flex flex-wrap gap-x-9 gap-y-3">
            <div className="flex flex-col-reverse">
              <dt className="text-[12.5px] leading-4 text-ink-300">{usage.length === 1 ? 'Room' : 'Rooms'}</dt>
              <dd className="font-display text-[24px] font-semibold leading-7">{usage.length}</dd>
            </div>
            <div className="flex flex-col-reverse">
              <dt className="text-[12.5px] leading-4 text-ink-300">Average share of open time</dt>
              <dd className="font-display text-[24px] font-semibold leading-7">{average === null ? 'None set' : fmtPercent(average, 0)}</dd>
            </div>
            {busiest && (
              <div className="flex flex-col-reverse">
                <dt className="text-[12.5px] leading-4 text-ink-300">Busiest room</dt>
                <dd className="font-display text-[24px] font-semibold leading-7">
                  {busiest.code} <span className="text-brass-300">{fmtPercent(busiest.share ?? 0, 0)}</span>
                </dd>
              </div>
            )}
          </dl>
        )}
      </div>

      {loading ? (
        <Loading rows={4} />
      ) : error ? (
        <div className="p-4">
          <ErrorNote error={error} />
        </div>
      ) : usage.length === 0 ? (
        <p className="p-4 text-ink-500">There are no rooms yet.</p>
      ) : (
        <>
          <Table>
            <THead>
              <tr>
                <SortTh label="Room" k="room" sort={sort} />
                <SortTh label="Meetings a week" k="meetings" sort={sort} />
                <SortTh label="Scheduled hours" k="scheduled" sort={sort} />
                <SortTh label="Open hours" k="open" sort={sort} />
                <SortTh label="Share of open time" k="share" sort={sort} />
              </tr>
            </THead>
            <TBody>
              {shownUsage.map((u) => (
                <tr key={u.room_id}>
                  <td className={td}>
                    <span className="font-medium">{u.code}</span> <span className="text-ink-500">{u.name}</span>
                  </td>
                  <td className={`${td} tabular-nums`}>{u.meetings}</td>
                  <td className={`${td} tabular-nums`}>{u.scheduledHours.toFixed(1)}</td>
                  <td className={`${td} tabular-nums`}>{u.openHours.toFixed(1)}</td>
                  <td className={td}>
                    {u.share === null ? (
                      <span className="text-ink-400">No open hours set</span>
                    ) : (
                      <span className="flex items-center gap-3">
                        {/* a gauge with quarter marks, so "a fifth" and "most of it" read without the number */}
                        <span className="relative h-3.5 w-44 overflow-hidden rounded-[3px] bg-ink-100 ring-1 ring-inset ring-ink-200" role="presentation">
                          <span className="absolute inset-y-0 left-0 bg-brass-400" style={{ width: `${Math.min(100, u.share * 100)}%` }} />
                          {[25, 50, 75].map((m) => (
                            <span key={m} className="absolute inset-y-0 w-px bg-white/90" style={{ left: `${m}%` }} />
                          ))}
                        </span>
                        <span className="w-10 tabular-nums">{fmtPercent(u.share, 0)}</span>
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </TBody>
          </Table>
          <p className="border-t border-ink-100 px-4 py-3 text-[13px] text-ink-500">
            Scheduled is not the same as used. A room can be scheduled and stay empty; the Cameras page and the alerts show what was actually seen.
          </p>
        </>
      )}
    </section>
  )
}
