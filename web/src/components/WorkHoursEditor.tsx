import { useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { Button, inputCls, timeInputCls } from '@/components/ui'
import { DAY_ABBR, DAY_NAMES, formatWorkHours, mergeWindows, minutesOfTime, parseWorkHours, type WorkWindow } from '@/lib/import/workHours'
import type { SchoolHour } from '@/lib/types'

const hhmm = (t: string) => t.slice(0, 5)

/** hours a week covered by the windows (touching or overlapping periods counted once) */
export function windowHours(windows: WorkWindow[]): number {
  return mergeWindows(windows).reduce((sum, w) => sum + (minutesOfTime(w.end_time) - minutesOfTime(w.start_time)), 0) / 60
}

/** the first problem with a set of windows, in words, or null */
export function workHoursProblem(windows: WorkWindow[]): string | null {
  for (const w of windows) {
    if (!w.start_time || !w.end_time) return `${DAY_NAMES[w.day_of_week - 1]}: fill in both times.`
    if (minutesOfTime(w.end_time) <= minutesOfTime(w.start_time)) return `${DAY_NAMES[w.day_of_week - 1]}: the end time must be after the start time.`
  }
  return null
}

/**
 * When an instructor works: a set of periods on each weekday. The parent keeps the flat list of windows;
 * "any time the school is open" is the parent's choice of showing this editor or not.
 */
export function WorkHoursEditor({
  value,
  onChange,
  schoolHours,
}: {
  value: WorkWindow[]
  onChange: (next: WorkWindow[]) => void
  schoolHours?: SchoolHour[]
}) {
  const [typed, setTyped] = useState('')
  const [typedErrors, setTypedErrors] = useState<string[]>([])

  const byDay = (day: number) => value.map((w, index) => ({ w, index })).filter((x) => x.w.day_of_week === day)
  const open = (day: number) => schoolHours?.find((h) => h.day_of_week === day)
  const defaultWindow = (day: number): WorkWindow => {
    const h = open(day)
    return { day_of_week: day, start_time: h ? hhmm(h.opens_at) : '08:00', end_time: h ? hhmm(h.closes_at) : '17:00' }
  }

  const toggleDay = (day: number, on: boolean) => {
    if (on) onChange([...value, defaultWindow(day)])
    else onChange(value.filter((w) => w.day_of_week !== day))
  }
  const setWindow = (index: number, patch: Partial<WorkWindow>) => onChange(value.map((w, i) => (i === index ? { ...w, ...patch } : w)))
  const copyToWeekdays = (day: number) => {
    const source = value.filter((w) => w.day_of_week === day)
    const others = value.filter((w) => w.day_of_week > 5 || w.day_of_week === day)
    const copies = [1, 2, 3, 4, 5].filter((d) => d !== day).flatMap((d) => source.map((w) => ({ ...w, day_of_week: d })))
    onChange([...others, ...copies].sort((a, b) => a.day_of_week - b.day_of_week))
  }
  const applyTyped = () => {
    const r = parseWorkHours(typed)
    setTypedErrors(r.errors)
    if (r.errors.length === 0 && r.windows.length > 0) {
      onChange(r.windows)
      setTyped('')
    }
  }

  const hours = windowHours(value)

  return (
    <div className="space-y-3">
      <div>
        <label className="mb-1 block text-[13px] font-medium text-ink-700" htmlFor="wh-typed">
          Type the hours instead
        </label>
        <div className="flex gap-2">
          <input
            id="wh-typed"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                applyTyped()
              }
            }}
            className={inputCls}
            placeholder="Mon-Fri 8:00-17:00; Sat 8:00-12:00"
          />
          <Button type="button" variant="secondary" className="shrink-0 whitespace-nowrap" onClick={applyTyped} disabled={!typed.trim()}>
            Fill in
          </Button>
        </div>
        {typedErrors.map((e) => (
          <p key={e} className="mt-1 text-[13px] text-rose-700" role="alert">
            {e}
          </p>
        ))}
      </div>

      <ul className="divide-y divide-ink-100 rounded-md border border-ink-200" aria-label="Work hours by day">
        {DAY_NAMES.map((name, i) => {
          const day = i + 1
          const windows = byDay(day)
          const school = open(day)
          return (
            <li key={name} className="flex flex-wrap items-start gap-x-4 gap-y-2 px-3 py-2.5">
              <label className="flex w-28 shrink-0 items-center gap-2 pt-1.5 text-[14px]">
                <input
                  type="checkbox"
                  checked={windows.length > 0}
                  onChange={(e) => toggleDay(day, e.target.checked)}
                  className="size-4 accent-ink-900"
                />
                <span className={windows.length > 0 ? 'font-medium' : 'text-ink-500'}>{DAY_ABBR[i]}</span>
                {!school && schoolHours && <span className="text-[11px] text-ink-400">closed</span>}
              </label>
              <div className="min-w-0 flex-1 space-y-1.5">
                {windows.length === 0 && <div className="pt-1.5 text-[13px] text-ink-400">Not working</div>}
                {windows.map(({ w, index }, k) => (
                  <div key={index} className="flex flex-wrap items-center gap-2">
                    <input
                      type="time"
                      aria-label={`${name} start`}
                      value={hhmm(w.start_time)}
                      onChange={(e) => setWindow(index, { start_time: e.target.value })}
                      className={timeInputCls}
                    />
                    <span className="text-ink-500">to</span>
                    <input
                      type="time"
                      aria-label={`${name} end`}
                      value={hhmm(w.end_time)}
                      onChange={(e) => setWindow(index, { end_time: e.target.value })}
                      className={timeInputCls}
                    />
                    {windows.length > 1 && (
                      <button
                        type="button"
                        onClick={() => onChange(value.filter((_, j) => j !== index))}
                        aria-label={`Remove ${name} period ${k + 1}`}
                        className="grid size-9 place-items-center rounded-md text-ink-500 hover:bg-ink-100"
                      >
                        <Trash2 className="size-4" aria-hidden />
                      </button>
                    )}
                  </div>
                ))}
                {windows.length > 0 && (
                  <div className="flex flex-wrap gap-x-3 text-[13px]">
                    <button
                      type="button"
                      onClick={() => onChange([...value, { day_of_week: day, start_time: '13:00', end_time: '17:00' }])}
                      className="inline-flex items-center gap-1 text-ink-600 hover:text-ink-900"
                    >
                      <Plus className="size-3.5" aria-hidden />
                      Add a period
                    </button>
                    {day <= 5 && (
                      <button type="button" onClick={() => copyToWeekdays(day)} className="text-ink-600 hover:text-ink-900">
                        Copy to Mon–Fri
                      </button>
                    )}
                  </div>
                )}
              </div>
            </li>
          )
        })}
      </ul>

      <p className="text-[13px] text-ink-500">
        {value.length === 0
          ? 'Tick the days this instructor works.'
          : `${formatWorkHours(value)}. About ${Math.round(hours * 10) / 10} hours a week on campus.`}
      </p>
    </div>
  )
}
