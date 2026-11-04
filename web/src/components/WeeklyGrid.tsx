import { useMemo, useState } from 'react'
import { Flag, Lock, Pin } from 'lucide-react'
import { cn } from '@/lib/cn'
import { lastName, STATUS_LABEL } from '@/lib/format'
import { DAY_SHORT, fmtRange, toMinutes } from '@/lib/time'
import type { ScheduleEntryRow, ScheduleStatus } from '@/lib/types'

export const HOUR_H = 56
export const DEFAULT_START = 7
export const DEFAULT_END = 21

/** Published meetings are brass: they are the ones the locker station enforces. */
export const BLOCK: Record<ScheduleStatus, string> = {
  published: 'border-brass-300 border-l-brass-500 bg-brass-100 text-ink-900',
  approved: 'border-emerald-200 border-l-emerald-500 bg-emerald-50 text-emerald-950',
  submitted: 'border-amber-200 border-l-amber-500 bg-amber-50 text-amber-950',
  returned: 'border-rose-200 border-l-rose-500 bg-rose-50 text-rose-950',
  draft: 'border-ink-200 border-l-ink-400 bg-ink-50 text-ink-800',
}

/** Small marks in a meeting's corner: locked, moved by an override, pinned. */
export function EntryMarks({ e, locked }: { e: ScheduleEntryRow; locked?: boolean }) {
  if (!locked && !e.is_override && !e.is_pinned) return null
  return (
    <span className="pointer-events-none absolute right-1 top-1 flex gap-0.5 opacity-60">
      {e.is_override && <Flag className="size-3" aria-hidden />}
      {e.is_pinned && <Pin className="size-3" aria-hidden />}
      {locked && <Lock className="size-3 opacity-70" aria-hidden />}
    </span>
  )
}

/** The words behind those marks, for tooltips and screen readers. */
export const markText = (e: ScheduleEntryRow) =>
  `${e.is_override ? '. Moved by an override' : ''}${e.is_pinned ? '. Pinned: kept in place when the schedule is generated again' : ''}`

export interface Item {
  e: ScheduleEntryRow
  s: number
  en: number
  lane: number
  lanes: number
}

/** Side-by-side lanes for meetings that overlap in time within one day. */
export function layoutDay(entries: ScheduleEntryRow[]): Item[] {
  const sorted = entries
    .map((e) => ({ e, s: toMinutes(e.start_time), en: toMinutes(e.end_time), lane: 0, lanes: 1 }))
    .sort((a, b) => a.s - b.s || a.en - b.en)

  const out: Item[] = []
  let cluster: Item[] = []
  let clusterEnd = -1
  let laneEnds: number[] = []

  const flush = () => {
    const lanes = Math.max(...cluster.map((c) => c.lane)) + 1
    cluster.forEach((c) => (c.lanes = lanes))
    out.push(...cluster)
    cluster = []
    laneEnds = []
    clusterEnd = -1
  }

  for (const it of sorted) {
    if (cluster.length && it.s >= clusterEnd) flush()
    let lane = laneEnds.findIndex((end) => end <= it.s)
    if (lane === -1) {
      lane = laneEnds.length
      laneEnds.push(it.en)
    } else {
      laneEnds[lane] = it.en
    }
    it.lane = lane
    cluster.push(it)
    clusterEnd = Math.max(clusterEnd, it.en)
  }
  if (cluster.length) flush()
  return out
}

export function WeeklyGrid({ entries, now }: { entries: ScheduleEntryRow[]; /** the school's clock: marks today's column and draws a line at the current time */ now?: { isoDow: number; minutes: number } | null }) {
  // pointing at (or tabbing to) a meeting lights up every meeting of the same course and softens the rest
  const [active, setActive] = useState<string | null>(null)
  const { days, startHour, endHour, byDay } = useMemo(() => {
    const days = entries.some((e) => e.day_of_week === 7) ? 7 : 6
    let startHour = DEFAULT_START
    let endHour = DEFAULT_END
    for (const e of entries) {
      startHour = Math.min(startHour, Math.floor(toMinutes(e.start_time) / 60))
      endHour = Math.max(endHour, Math.ceil(toMinutes(e.end_time) / 60))
    }
    const byDay = Array.from({ length: days }, (_, i) => layoutDay(entries.filter((e) => e.day_of_week === i + 1)))
    return { days, startHour, endHour, byDay }
  }, [entries])

  const hours = Array.from({ length: endHour - startHour }, (_, i) => startHour + i)
  const height = hours.length * HOUR_H
  const cols = `52px repeat(${days}, minmax(0, 1fr))`

  return (
    <div className="overflow-x-auto">
      <div className="min-w-[820px]">
        <div className="grid border-b border-ink-300 bg-ink-800" style={{ gridTemplateColumns: cols }}>
          <div />
          {DAY_SHORT.slice(0, days).map((d, i) => {
            const today = now?.isoDow === i + 1
            return (
              <div key={d} className={cn('relative border-l border-ink-700 px-2 py-2.5 text-center font-display text-[16px] font-semibold leading-5', today ? 'text-brass-300' : 'text-ink-200')}>
                {today && <span className="mr-1.5 inline-block size-1.5 rounded-full bg-brass-400 align-middle shadow-[0_0_6px_1px_rgb(210_154_63/0.6)]" aria-hidden />}
                {d}
                {today && <span aria-hidden className="absolute inset-x-3 bottom-0 h-0.5 rounded-t bg-brass-400" />}
              </div>
            )
          })}
        </div>

        <div className="grid" style={{ gridTemplateColumns: cols, height }}>
          <div className="relative">
            {hours.map((h, i) => (
              <div
                key={h}
                className="absolute right-2 -translate-y-1/2 text-[12px] text-ink-400"
                style={{ top: i * HOUR_H, display: i === 0 ? 'none' : undefined }}
              >
                {((h + 11) % 12) + 1} {h >= 12 ? 'PM' : 'AM'}
              </div>
            ))}
          </div>

          {byDay.map((items, di) => (
            <div key={di} className={cn('relative border-l border-ink-100', now?.isoDow === di + 1 && 'bg-brass-50/50')}>
              {hours.map((h, i) => (
                <div key={h} className="absolute inset-x-0 border-t border-ink-100" style={{ top: i * HOUR_H }} />
              ))}
              {now?.isoDow === di + 1 && now.minutes >= startHour * 60 && now.minutes <= endHour * 60 && (
                <div className="pointer-events-none absolute inset-x-0 z-10 h-px bg-brass-500" style={{ top: ((now.minutes - startHour * 60) / 60) * HOUR_H }} aria-hidden>
                  <span className="absolute -left-[3px] -top-[3px] size-[7px] rounded-full bg-brass-500" />
                </div>
              )}
              {items.map(({ e, s, en, lane, lanes }) => {
                const top = ((s - startHour * 60) / 60) * HOUR_H
                const h = Math.max(((en - s) / 60) * HOUR_H, 22)
                const course = e.sections?.courses?.code ?? e.sections?.code ?? 'Class'
                const label = `${course}, ${e.rooms?.code ?? 'no room'}, ${e.instructors?.full_name ?? 'no instructor'}, ${fmtRange(
                  e.start_time,
                  e.end_time,
                )} (${STATUS_LABEL[e.status]})${markText(e)}`
                return (
                  <div
                    key={e.id}
                    role="group"
                    tabIndex={0}
                    title={label}
                    aria-label={label}
                    onMouseEnter={() => setActive(course)}
                    onMouseLeave={() => setActive(null)}
                    onFocus={() => setActive(course)}
                    onBlur={() => setActive(null)}
                    className={cn(
                      'absolute overflow-hidden rounded-[5px] border border-l-4 px-1.5 py-1 text-[12px] leading-tight shadow-[0_1px_0_rgb(11_21_36/0.05),0_6px_8px_-6px_rgb(11_21_36/0.35)] transition-[opacity,box-shadow] duration-150',
                      BLOCK[e.status],
                      active && (active === course ? 'z-10 shadow-[0_0_0_2px_var(--color-ink-900)]' : 'opacity-40'),
                    )}
                    style={{
                      top: top + 1,
                      height: h - 2,
                      left: `calc(${(lane / lanes) * 100}% + 2px)`,
                      width: `calc(${100 / lanes}% - 4px)`,
                    }}
                  >
                    <EntryMarks e={e} />
                    <div className="truncate font-semibold">{course}</div>
                    {h >= 40 && <div className="truncate">{e.rooms?.code}</div>}
                    {h >= 56 && e.instructors && <div className="truncate text-[11.5px] opacity-80">{lastName(e.instructors.full_name)}</div>}
                  </div>
                )
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
