import { cn } from '@/lib/cn'
import { fmtMinutes, fmtRange, toMinutes } from '@/lib/time'
import { timelineRange } from '@/lib/timeline'

export interface TimelineRoom {
  id: string
  code: string
  /** the key's state, which colours the room's tag as everywhere else */
  key: 'issued' | 'outstanding' | 'available' | null
  /** the room needs a look: its block is drawn in red while the class is on */
  flagged: boolean
}

export interface TimelineEntry {
  id: string
  room_id: string | null
  start_time: string
  end_time: string
  course: string
  instructor: string | null
}

const hourLabel = (m: number) => fmtMinutes(m).replace(':00', '').replace(' ', ' ')

const TAG: Record<string, string> = {
  issued: 'border-brass-300 bg-brass-100 text-brass-700',
  outstanding: 'border-rose-200 bg-rose-50 text-rose-700',
  none: 'border-ink-200 bg-ink-100 text-ink-700',
}

/**
 * Every room across the school day, on one strip: a row for each room, a block for each class, and a brass line at
 * the time it is now. What is over is grey, what is on is brass (red when the room needs a look) and what is still
 * to come is outlined. Hours the school is closed are hatched.
 */
export function DayTimeline({
  rooms,
  entries,
  nowMinutes,
  hours,
}: {
  rooms: TimelineRoom[]
  entries: TimelineEntry[]
  nowMinutes: number
  /** the school's opening and closing time today, if it is open today */
  hours: { open: number; close: number } | null
}) {
  const { lo, hi } = timelineRange(entries, hours)
  const span = hi - lo
  const pct = (m: number) => `${(Math.min(Math.max(m, lo), hi) - lo) / span * 100}%`
  const ticks: number[] = []
  for (let m = lo; m <= hi; m += 60) ticks.push(m)
  const step = ticks.length > 14 ? 2 : 1
  const showNow = nowMinutes >= lo && nowMinutes <= hi
  const byRoom = new Map<string, TimelineEntry[]>()
  for (const e of entries) if (e.room_id) byRoom.set(e.room_id, [...(byRoom.get(e.room_id) ?? []), e])

  return (
    <div className="overflow-x-auto">
      <div className="relative min-w-[680px] pb-3 pl-4 pr-6 pt-3">
        {/* the hours */}
        <div className="relative ml-[104px] h-6" aria-hidden>
          {ticks.map((m, i) =>
            i % step === 0 ? (
              <span key={m} className="absolute top-0 -translate-x-1/2 text-[11.5px] leading-5 text-ink-500" style={{ left: pct(m) }}>
                {hourLabel(m)}
              </span>
            ) : null,
          )}
          {showNow && (
            <span
              className="absolute top-0 z-20 -translate-x-1/2 rounded bg-brass-500 px-1.5 text-[11.5px] font-medium leading-5 text-white shadow-sm"
              style={{ left: pct(nowMinutes) }}
            >
              {fmtMinutes(nowMinutes).replace(' ', ' ')}
            </span>
          )}
        </div>

        <div className="relative">
          {/* behind the rows: closed hours and the hour lines */}
          <div aria-hidden className="pointer-events-none absolute inset-y-0 left-[104px] right-0">
            {hours && hours.open > lo && <div className="closed-hours absolute inset-y-0 left-0" style={{ width: pct(hours.open) }} />}
            {hours && hours.close < hi && <div className="closed-hours absolute inset-y-0 right-0" style={{ width: `calc(100% - ${pct(hours.close)})` }} />}
            {ticks.map((m) => (
              <div key={m} className="absolute inset-y-0 w-px bg-ink-100" style={{ left: pct(m) }} />
            ))}
          </div>

          <ul aria-label="Rooms across the day" className="relative">
            {rooms.map((r) => {
              const list = byRoom.get(r.id) ?? []
              return (
                <li key={r.id} className="flex h-10 items-center border-t border-ink-100 first:border-t-0">
                  <div className="w-[104px] shrink-0 pr-3">
                    <span
                      className={cn(
                        'inline-flex items-center gap-1.5 rounded-[5px] border py-px pl-1.5 pr-2 font-mono text-[12.5px] leading-5',
                        TAG[r.key === 'issued' ? 'issued' : r.key === 'outstanding' ? 'outstanding' : 'none'],
                      )}
                    >
                      <span aria-hidden className="size-[6px] shrink-0 rounded-full border border-current bg-white opacity-80" />
                      {r.code}
                    </span>
                  </div>
                  <div className="relative h-full flex-1">
                    {list.length === 0 && <span className="absolute left-2 top-1/2 -translate-y-1/2 text-[12px] text-ink-400">No class today</span>}
                    {list.map((e) => {
                      const s = toMinutes(e.start_time)
                      const f = toMinutes(e.end_time)
                      const over = f <= nowMinutes
                      const on = !over && s <= nowMinutes
                      return (
                        <div
                          key={e.id}
                          title={`${e.course}${e.instructor ? `, ${e.instructor}` : ''}, ${fmtRange(e.start_time, e.end_time)}`}
                          className={cn(
                            'absolute inset-y-1.5 overflow-hidden text-ellipsis whitespace-nowrap rounded-[4px] px-2 text-[12.5px] leading-[26px] ring-1 ring-inset',
                            over && 'bg-ink-100 text-ink-500 ring-ink-200',
                            on && !r.flagged && 'bg-brass-200 font-medium text-brass-700 ring-brass-400',
                            on && r.flagged && 'bg-rose-100 font-medium text-rose-800 ring-rose-300',
                            !over && !on && 'bg-white text-ink-800 ring-ink-300',
                          )}
                          style={{ left: pct(s), width: `calc(${pct(f)} - ${pct(s)} - 2px)` }}
                        >
                          {e.course}
                          {e.instructor && <span className="ml-1.5 font-normal opacity-75">{e.instructor}</span>}
                        </div>
                      )
                    })}
                  </div>
                </li>
              )
            })}
          </ul>

          {/* above the rows: the line at the time it is now */}
          {showNow && (
            <div aria-hidden className="pointer-events-none absolute inset-y-0 left-[104px] right-0 z-10">
              <div className="absolute inset-y-0 w-0.5 -translate-x-1/2 bg-brass-500" style={{ left: pct(nowMinutes) }} />
            </div>
          )}
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1 pl-[104px] text-[12px] text-ink-500">
          <span className="inline-flex items-center gap-1.5">
            <i className="size-3 rounded-[3px] bg-ink-100 ring-1 ring-inset ring-ink-200" aria-hidden /> Over
          </span>
          <span className="inline-flex items-center gap-1.5">
            <i className="size-3 rounded-[3px] bg-brass-200 ring-1 ring-inset ring-brass-400" aria-hidden /> In session
          </span>
          <span className="inline-flex items-center gap-1.5">
            <i className="size-3 rounded-[3px] bg-rose-100 ring-1 ring-inset ring-rose-300" aria-hidden /> In session, needs a look
          </span>
          <span className="inline-flex items-center gap-1.5">
            <i className="size-3 rounded-[3px] bg-white ring-1 ring-inset ring-ink-300" aria-hidden /> Still to come
          </span>
          {hours && (
            <span className="inline-flex items-center gap-1.5">
              <i className="closed-hours size-3 rounded-[3px] ring-1 ring-inset ring-ink-200" aria-hidden /> School closed
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
