/**
 * Instructor work hours as people write them ("MWF 8am-5pm", "Mon-Fri 8:00-17:00; Sat 8-12")
 * and as the database stores them (one window per row: day 1 = Monday, 'HH:MM' times).
 *
 * Plain functions, no dependencies, so the same code runs in the browser and in the tests.
 */
export interface WorkWindow {
  day_of_week: number
  start_time: string
  end_time: string
}

export interface ParsedWorkHours {
  windows: WorkWindow[]
  /** what could not be understood, one sentence each */
  errors: string[]
}

export const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
export const DAY_ABBR = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

const DAY_WORDS: Record<string, number> = {
  m: 1, mon: 1, monday: 1,
  t: 2, tu: 2, tue: 2, tues: 2, tuesday: 2,
  w: 3, wed: 3, weds: 3, wednesday: 3,
  th: 4, thu: 4, thur: 4, thurs: 4, thursday: 4,
  f: 5, fri: 5, friday: 5,
  s: 6, sa: 6, sat: 6, saturday: 6,
  su: 7, sun: 7, sunday: 7,
}

const hhmm = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`

/** 'HH:MM' or 'HH:MM:SS' to minutes after midnight */
export function minutesOfTime(t: string): number {
  const [h, m] = t.split(':')
  return Number(h) * 60 + Number(m)
}

interface Clock {
  hour: number
  minute: number
  meridiem: 'am' | 'pm' | null
}

function readClock(raw: string): Clock | null {
  const t = raw.trim().toLowerCase().replace(/\./g, '')
  if (t === 'noon' || /^12\s*(?:nn|noon|n)$/.test(t)) return { hour: 12, minute: 0, meridiem: 'pm' }
  if (t === 'midnight') return { hour: 12, minute: 0, meridiem: 'am' }
  const m = /^(\d{1,2})(?::?(\d{2}))?\s*(am|pm|a|p)?$/.exec(t)
  if (!m) return null
  const hour = Number(m[1])
  const minute = m[2] ? Number(m[2]) : 0
  if (minute > 59 || hour > 24) return null
  const mer = m[3] ? (m[3].startsWith('a') ? 'am' : 'pm') : null
  if (mer && (hour < 1 || hour > 12)) return null
  return { hour, minute, meridiem: mer }
}

/** minutes after midnight for a clock with a known meridiem (or a 24-hour reading) */
function toMinutes(c: Clock, as: 'am' | 'pm' | '24h'): number {
  if (as === '24h') return c.hour * 60 + c.minute
  const h = c.hour % 12
  return (as === 'pm' ? h + 12 : h) * 60 + c.minute
}

/**
 * One range like "8-5", "8:00-17:00", "8am-12pm", "1-5pm". A missing am/pm is guessed the way a school day
 * runs: 7 to 11 is morning, 12 is noon, 1 to 6 is afternoon; 13:00 and later (or a leading zero) is read as 24-hour time.
 */
export function parseTimeRange(from: string, to: string): { start: number; end: number } | null {
  const a = readClock(from)
  const b = readClock(to)
  if (!a || !b) return null

  const is24 = (c: Clock) => c.meridiem === null && (c.hour > 12 || c.hour === 0 || /^0\d/.test(c === a ? from.trim() : to.trim()))
  const guess = (c: Clock): 'am' | 'pm' => (c.hour >= 7 && c.hour <= 11 ? 'am' : 'pm')

  const readings = (c: Clock, other: Clock): Array<'am' | 'pm' | '24h'> => {
    if (c.meridiem) return [c.meridiem]
    if (is24(c)) return ['24h']
    if (other.meridiem) return [other.meridiem, other.meridiem === 'am' ? 'pm' : 'am']
    return [guess(c)]
  }

  for (const ra of readings(a, b)) {
    for (const rb of readings(b, a)) {
      // "12" alone means noon, not midnight
      const start = toMinutes(a, ra)
      const end = b.hour === 24 ? 24 * 60 : toMinutes(b, rb)
      if (end > start && end <= 24 * 60 && start >= 0) return { start, end }
    }
  }
  return null
}

/** Letters like "MWF", "TTh", "MTWThFS" to ISO days, or null when the text is not a run of day letters. */
function compactDays(word: string): number[] | null {
  const w = word.toLowerCase()
  const out: number[] = []
  let i = 0
  while (i < w.length) {
    const two = w.slice(i, i + 2)
    if (two === 'th' || two === 'su' || two === 'sa') {
      out.push(DAY_WORDS[two]!)
      i += 2
    } else if ('mtwfs'.includes(w[i]!)) {
      out.push(DAY_WORDS[w[i]!]!)
      i += 1
    } else return null
  }
  return out.length ? out : null
}

function dayToken(word: string): number[] | null {
  const w = word.toLowerCase().replace(/\.$/, '')
  if (w in DAY_WORDS) return [DAY_WORDS[w]!]
  return compactDays(w)
}

/** "Mon-Fri", "MWF", "Tue/Thu", "Mon, Wed and Fri", "weekdays", "daily" to ISO days. null = not understood. */
export function parseDays(text: string): number[] | null {
  const t = text.toLowerCase().replace(/[.]/g, '').replace(/\s*(-|–|—|to)\s*/g, '-').trim()
  if (!t) return null
  if (/^(daily|every ?day|all days)$/.test(t)) return [1, 2, 3, 4, 5, 6, 7]
  if (/^(weekdays?|mon-fri)$/.test(t)) return [1, 2, 3, 4, 5]
  if (/^weekends?$/.test(t)) return [6, 7]

  const days = new Set<number>()
  for (const part of t.split(/\s*(?:,|\/|&|\band\b|\+)\s*|\s+/).filter(Boolean)) {
    const range = /^([a-z]+)-([a-z]+)$/.exec(part)
    if (range) {
      const a = dayToken(range[1]!)
      const b = dayToken(range[2]!)
      if (!a || !b || a.length !== 1 || b.length !== 1 || b[0]! < a[0]!) return null
      for (let d = a[0]!; d <= b[0]!; d++) days.add(d)
      continue
    }
    const one = dayToken(part)
    if (!one) return null
    one.forEach((d) => days.add(d))
  }
  return days.size ? [...days].sort((x, y) => x - y) : null
}

/** merges windows on the same day that overlap or touch, and sorts the result */
export function mergeWindows(windows: WorkWindow[]): WorkWindow[] {
  const byDay = new Map<number, Array<[number, number]>>()
  for (const w of windows) {
    if (!byDay.has(w.day_of_week)) byDay.set(w.day_of_week, [])
    byDay.get(w.day_of_week)!.push([minutesOfTime(w.start_time), minutesOfTime(w.end_time)])
  }
  const out: WorkWindow[] = []
  for (const day of [...byDay.keys()].sort((a, b) => a - b)) {
    const list = byDay.get(day)!.sort((a, b) => a[0] - b[0])
    const merged: Array<[number, number]> = []
    for (const [s, e] of list) {
      const last = merged[merged.length - 1]
      if (last && s <= last[1]) last[1] = Math.max(last[1], e)
      else merged.push([s, e])
    }
    for (const [s, e] of merged) out.push({ day_of_week: day, start_time: hhmm(s), end_time: hhmm(e) })
  }
  return out
}

const TIME = String.raw`(?:12\s*(?:nn|noon)\b|noon|midnight|\d{1,2}(?::?\d{2})?\s*(?:[ap]\.?m\.?)?)`
const RANGE = new RegExp(String.raw`(${TIME})\s*(?:-|–|—|\bto\b)\s*(${TIME})`, 'gi')

/**
 * "MWF 8am-5pm; Sat 8-12", "Mon-Fri 8:00-12:00, 13:00-17:00", "8am-5pm Mon-Fri".
 * Blank text is fine and means "no restriction" (an empty list, no errors).
 */
export function parseWorkHours(text: string): ParsedWorkHours {
  const windows: WorkWindow[] = []
  const errors: string[] = []
  const source = (text ?? '').trim()
  if (!source) return { windows, errors }

  for (const segment of source.split(/[;\n]+/).map((s) => s.trim()).filter(Boolean)) {
    const ranges: Array<{ from: string; to: string }> = []
    const rest = segment.replace(RANGE, (_all, from: string, to: string) => {
      ranges.push({ from, to })
      return ' '
    })
    if (ranges.length === 0) {
      errors.push(`"${segment}": no times found (write them like 8:00-17:00 or 8am-5pm).`)
      continue
    }
    const dayText = rest.replace(/\b(and|&|,|at|from|on)\b/gi, ' ').replace(/[,&]/g, ' ').trim()
    if (!dayText) {
      errors.push(`"${segment}": say which days (for example Mon-Fri ${segment}).`)
      continue
    }
    const days = parseDays(dayText.replace(/\s+/g, ' ').replace(/\s*,\s*/g, ','))
    if (!days) {
      errors.push(`"${segment}": the days "${dayText}" were not understood (use Mon, Tue, Wed, Thu, Fri, Sat, Sun, or MWF, TTh).`)
      continue
    }
    for (const r of ranges) {
      const parsed = parseTimeRange(r.from, r.to)
      if (!parsed) {
        errors.push(`"${segment}": the time ${r.from.trim()}-${r.to.trim()} is not valid.`)
        continue
      }
      for (const d of days) windows.push({ day_of_week: d, start_time: hhmm(parsed.start), end_time: hhmm(parsed.end) })
    }
  }
  return { windows: mergeWindows(windows), errors }
}

function dayRuns(days: number[]): string {
  const parts: string[] = []
  let i = 0
  while (i < days.length) {
    let j = i
    while (j + 1 < days.length && days[j + 1] === days[j]! + 1) j++
    if (j - i >= 2) parts.push(`${DAY_ABBR[days[i]! - 1]}–${DAY_ABBR[days[j]! - 1]}`)
    else for (let k = i; k <= j; k++) parts.push(DAY_ABBR[days[k]! - 1]!)
    i = j + 1
  }
  return parts.join(', ')
}

/** The inverse of parseWorkHours: days with the same hours are grouped. Empty list = '' (callers say "any time"). */
export function formatWorkHours(windows: Array<{ day_of_week: number; start_time: string; end_time: string }>): string {
  const merged = mergeWindows(windows.map((w) => ({ day_of_week: w.day_of_week, start_time: w.start_time.slice(0, 5), end_time: w.end_time.slice(0, 5) })))
  const perDay = new Map<number, string>()
  for (const w of merged) {
    const piece = `${w.start_time}-${w.end_time}`
    perDay.set(w.day_of_week, perDay.has(w.day_of_week) ? `${perDay.get(w.day_of_week)}, ${piece}` : piece)
  }
  const byText = new Map<string, number[]>()
  for (const [day, text] of [...perDay.entries()].sort((a, b) => a[0] - b[0])) {
    if (!byText.has(text)) byText.set(text, [])
    byText.get(text)!.push(day)
  }
  return [...byText.entries()].map(([text, days]) => `${dayRuns(days)} ${text}`).join('; ')
}
