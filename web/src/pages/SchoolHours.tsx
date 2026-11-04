import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@/auth/AuthProvider'
import { Panel } from '@/components/surfaces'
import { Button, ErrorNote, Loading, Notice, timeInputCls } from '@/components/ui'
import { unwrap, useActiveTerm } from '@/lib/api'
import { friendlyError } from '@/lib/errors'
import { DAY_NAMES } from '@/lib/import/workHours'
import { supabase } from '@/lib/supabase'
import { cn } from '@/lib/cn'
import { fmtTime, toMinutes } from '@/lib/time'
import type { SchoolHour } from '@/lib/types'

interface Day {
  open: boolean
  opens: string
  closes: string
}

const hhmm = (t: string) => t.slice(0, 5)
const DEFAULT: Day = { open: false, opens: '07:00', closes: '21:00' }

const fromRows = (rows: SchoolHour[]): Day[] =>
  DAY_NAMES.map((_, i) => {
    const h = rows.find((x) => x.day_of_week === i + 1)
    return h ? { open: true, opens: hhmm(h.opens_at), closes: hhmm(h.closes_at) } : { ...DEFAULT }
  })

/** "7 AM", "8:30 AM": a time without the minutes when they are zero, to fit inside a bar. */
const short = (t: string) => fmtTime(t).replace(':00', '')

/** A day's opening hours are usable when both times are set and it closes after it opens. */
const valid = (d: Day) => d.open && Boolean(d.opens) && Boolean(d.closes) && toMinutes(d.closes) > toMinutes(d.opens)

/** The week at a glance: one bar per day across the hours of the day, drawn from what is typed, before anything is saved. */
function WeekBar({ days }: { days: Day[] }) {
  const usable = days.filter(valid)
  const from = Math.min(6, ...usable.map((d) => Math.floor(toMinutes(d.opens) / 60)))
  const to = Math.max(22, ...usable.map((d) => Math.ceil(toMinutes(d.closes) / 60)))
  const span = (to - from) * 60
  const ticks = [from, ...[9, 12, 15, 18].filter((h) => h > from && h < to), to]
  const label = (h: number) => `${((h + 11) % 12) + 1} ${h >= 12 && h < 24 ? 'PM' : 'AM'}`
  return (
    <div aria-hidden className="select-none">
      <div className="space-y-2">
        {DAY_NAMES.map((name, i) => {
          const d = days[i]!
          const ok = valid(d)
          return (
            <div key={name} className="flex items-center gap-2.5">
              <span className="w-8 text-[12.5px] text-ink-300">{name.slice(0, 3)}</span>
              <div
                className="relative h-7 flex-1 overflow-hidden rounded-[5px] bg-ink-800 ring-1 ring-ink-700"
                style={ok ? undefined : { backgroundImage: 'repeating-linear-gradient(135deg, rgb(255 255 255 / 0.06) 0 6px, transparent 6px 12px)' }}
              >
                {ticks.slice(1, -1).map((h) => (
                  <span key={h} className="absolute inset-y-0 w-px bg-white/10" style={{ left: `${((h - from) / (to - from)) * 100}%` }} />
                ))}
                {ok && (
                  <div
                    className="absolute inset-y-0.5 flex items-center overflow-hidden rounded-[3px] bg-brass-400 px-2 text-[11.5px] font-medium text-ink-950 shadow-[inset_0_1px_0_rgb(255_255_255/0.35)] transition-[left,width] duration-200"
                    style={{ left: `calc(${((toMinutes(d.opens) - from * 60) / span) * 100}% + 2px)`, width: `calc(${((toMinutes(d.closes) - toMinutes(d.opens)) / span) * 100}% - 4px)` }}
                  >
                    <span className="truncate">
                      {short(d.opens)} to {short(d.closes)}
                    </span>
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>
      <div className="relative ml-[2.625rem] mt-2 h-4 text-[11px] text-ink-400">
        {ticks.map((h, i) => (
          <span
            key={h}
            className={cn('absolute whitespace-nowrap', i === 0 ? '' : i === ticks.length - 1 ? '-translate-x-full' : '-translate-x-1/2')}
            style={{ left: `${((h - from) / (to - from)) * 100}%` }}
          >
            {label(h)}
          </span>
        ))}
      </div>
    </div>
  )
}

export default function SchoolHours() {
  const { profile } = useAuth()
  const qc = useQueryClient()
  const { term } = useActiveTerm()
  const [days, setDays] = useState<Day[]>(() => DAY_NAMES.map(() => ({ ...DEFAULT })))
  const [notice, setNotice] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null)

  const q = useQuery({
    queryKey: ['school-hours'],
    queryFn: () => unwrap<SchoolHour[]>(supabase.from('school_hours').select('day_of_week, opens_at, closes_at').order('day_of_week')),
  })

  useEffect(() => {
    if (!q.data) return
    setDays(fromRows(q.data))
  }, [q.data])

  const saved = useMemo(() => (q.data ? fromRows(q.data) : null), [q.data])
  const dirty = saved !== null && JSON.stringify(saved) !== JSON.stringify(days)
  const openHours = days.filter(valid).reduce((n, d) => n + (toMinutes(d.closes) - toMinutes(d.opens)) / 60, 0)
  const openDayCount = days.filter((d) => d.open).length
  const usableDays = days.filter(valid)

  const set = (i: number, patch: Partial<Day>) => setDays((d) => d.map((x, k) => (k === i ? { ...x, ...patch } : x)))

  const save = useMutation({
    mutationFn: async () => {
      const openDays = days.map((d, i) => ({ ...d, day: i + 1 })).filter((d) => d.open)
      if (openDays.length === 0) throw new Error('Keep at least one day open.')
      for (const d of openDays) {
        if (!d.opens || !d.closes || toMinutes(d.closes) <= toMinutes(d.opens)) {
          throw new Error(`${DAY_NAMES[d.day - 1]}: closing time must be after opening time.`)
        }
      }
      const tenant_id = profile!.tenant_id
      await unwrap(
        supabase.from('school_hours').upsert(
          openDays.map((d) => ({ tenant_id, day_of_week: d.day, opens_at: d.opens, closes_at: d.closes })),
          { onConflict: 'tenant_id,day_of_week' },
        ),
      )
      const closedDays = days.map((d, i) => (d.open ? 0 : i + 1)).filter(Boolean)
      if (closedDays.length > 0) await unwrap(supabase.from('school_hours').delete().in('day_of_week', closedDays))

      // classes already on the timetable are not moved: say how many now sit outside the new hours
      let outside = 0
      if (term) {
        const rows = await unwrap<Array<{ day_of_week: number; start_time: string; end_time: string }>>(
          supabase.from('schedule_entries').select('day_of_week, start_time, end_time').eq('term_id', term.id).neq('status', 'returned').limit(5000),
        )
        outside = rows.filter((r) => {
          const d = openDays.find((x) => x.day === r.day_of_week)
          return !d || toMinutes(r.start_time) < toMinutes(d.opens) || toMinutes(r.end_time) > toMinutes(d.closes)
        }).length
      }
      return outside
    },
    onSuccess: (outside) => {
      setNotice({
        tone: 'good',
        text:
          outside > 0
            ? `Saved. ${outside} class meeting${outside === 1 ? '' : 's'} already on the timetable now ${outside === 1 ? 'falls' : 'fall'} outside these hours. ${outside === 1 ? 'It is' : 'They are'} not moved; generate that schedule again or edit it.`
            : 'Saved. New and regenerated schedules will stay inside these hours.',
      })
      void qc.invalidateQueries({ queryKey: ['school-hours'] })
      void qc.invalidateQueries({ queryKey: ['audit'] })
    },
    onError: (err) => setNotice({ tone: 'bad', text: friendlyError(err) }),
  })

  function submit(e: FormEvent) {
    e.preventDefault()
    setNotice(null)
    save.mutate()
  }

  const earliest = openDayCount > 0 && usableDays.length > 0 ? usableDays.reduce((m, d) => (toMinutes(d.opens) < toMinutes(m.opens) ? d : m)) : null
  const latest = usableDays.length > 0 ? usableDays.reduce((m, d) => (toMinutes(d.closes) > toMinutes(m.closes) ? d : m)) : null
  const hoursText = Number.isInteger(openHours) ? String(openHours) : openHours.toFixed(1)

  return (
    <>
      <header className="mb-7 max-w-[64ch]">
        <h1 className="font-display text-[34px] font-semibold leading-none tracking-[-0.02em]">School hours</h1>
        <p className="mt-2 text-ink-500">
          When the school is open, day by day. The scheduler never places a class outside these hours, and a day left closed gets no classes. Room requests are held to them too.
        </p>
        {!q.isLoading && !q.error && (
          <dl className="mt-4 flex flex-wrap gap-x-7 gap-y-2">
            {[
              { label: openDayCount === 1 ? 'Day open' : 'Days open', value: openDayCount },
              { label: 'Hours a week', value: hoursText },
              { label: 'First opening', value: earliest ? short(earliest.opens) : '-' },
              { label: 'Last closing', value: latest ? short(latest.closes) : '-' },
            ].map((f) => (
              <div key={f.label} className="flex flex-col-reverse">
                <dt className="text-[12.5px] leading-4 text-ink-500">{f.label}</dt>
                <dd className="font-display text-[26px] font-semibold leading-8">{f.value}</dd>
              </div>
            ))}
          </dl>
        )}
      </header>

      {notice && (
        <Notice tone={notice.tone} onDismiss={() => setNotice(null)}>
          {notice.text}
        </Notice>
      )}

      {q.isLoading ? (
        <Panel title="Opening hours" flush>
          <Loading rows={4} />
        </Panel>
      ) : q.error ? (
        <Panel title="Opening hours">
          <ErrorNote error={q.error} onRetry={() => void q.refetch()} />
        </Panel>
      ) : (
        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,34rem)_minmax(0,1fr)]">
          <form onSubmit={submit}>
            <Panel title="Opening hours" description="Tick the days the school is open, then set when it opens and closes." flush>
              <ul aria-label="Opening hours by day" className="divide-y divide-ink-100">
                {DAY_NAMES.map((name, i) => {
                  const d = days[i]!
                  return (
                    <li
                      key={name}
                      className={cn('flex flex-wrap items-center gap-x-4 gap-y-2 border-l-4 py-2.5 pl-3 pr-3 transition-colors', d.open ? 'border-brass-500' : 'closed-hours border-transparent')}
                    >
                      <label className="flex w-36 shrink-0 items-center gap-2.5 text-[14px]">
                        <input type="checkbox" checked={d.open} onChange={(e) => set(i, { open: e.target.checked })} className="size-4 accent-ink-900" />
                        <span className={d.open ? 'font-medium' : 'text-ink-500'}>{name}</span>
                      </label>
                      {d.open ? (
                        <div className="flex flex-wrap items-center gap-2">
                          <input type="time" aria-label={`${name} opens`} value={d.opens} onChange={(e) => set(i, { opens: e.target.value })} className={timeInputCls} />
                          <span className="text-ink-500">to</span>
                          <input type="time" aria-label={`${name} closes`} value={d.closes} onChange={(e) => set(i, { closes: e.target.value })} className={timeInputCls} />
                        </div>
                      ) : (
                        <span className="text-[13px] text-ink-500">Closed</span>
                      )}
                      {d.open && d.opens && d.closes && !valid(d) && <span className="basis-full text-[13px] text-rose-700">Closing time must be after opening time.</span>}
                    </li>
                  )
                })}
              </ul>
              <div className="flex flex-wrap items-center gap-3 border-t border-ink-200 bg-ink-50 px-4 py-3">
                <Button type="submit" busy={save.isPending}>
                  Save school hours
                </Button>
                {dirty && (
                  <>
                    <Button type="button" variant="ghost" onClick={() => saved && setDays(saved)}>
                      Undo changes
                    </Button>
                    <span className="text-[13px] font-medium text-amber-800">Not saved yet</span>
                  </>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    const first = days.find((d) => d.open)
                    if (first) setDays((all) => all.map((d, i) => (i < 5 ? { ...first } : d)))
                  }}
                >
                  Copy the first open day to Mon–Fri
                </Button>
              </div>
            </Panel>
          </form>

          <section className="rounded-lg bg-ink-900 p-4 text-white shadow-[0_16px_28px_-22px_rgb(11_21_36/0.55)] ring-1 ring-ink-700 lg:sticky lg:top-6">
            <h2 className="font-display text-[20px] font-semibold leading-6">The week</h2>
            <p className="mb-4 mt-0.5 text-[13px] text-ink-300">Drawn from what is typed, before it is saved. Striped days are closed.</p>
            <WeekBar days={days} />
            <p className="mt-4 border-t border-ink-700 pt-3 text-[13.5px] text-ink-200">
              {openDayCount === 0 ? 'Every day is closed. Keep at least one day open.' : `Open ${openDayCount} ${openDayCount === 1 ? 'day' : 'days'} a week, ${hoursText} hours in all.`}
            </p>
          </section>
        </div>
      )}

      <p className="mt-4 max-w-[64ch] text-[13px] text-ink-500">
        Classes already on a timetable are never moved by changing these hours. Instructors’ own working hours are set on the Instructors page, and a class has to fit
        inside both.
      </p>
    </>
  )
}
