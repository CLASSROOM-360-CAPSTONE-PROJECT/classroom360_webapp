export const DAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

/** 'HH:MM:SS' (Postgres time) to minutes after midnight. */
export function toMinutes(t: string): number {
  const [h, m] = t.split(':')
  return Number(h) * 60 + Number(m)
}

/** 'HH:MM:SS' to '1:30 PM'. */
export function fmtTime(t: string): string {
  const mins = toMinutes(t)
  const h = Math.floor(mins / 60)
  const m = mins % 60
  const h12 = ((h + 11) % 12) + 1
  return `${h12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`
}

export function fmtRange(start: string, end: string): string {
  return `${fmtTime(start)} to ${fmtTime(end)}`
}

export function fmtDateTime(iso: string, tz: string): string {
  return new Intl.DateTimeFormat('en-PH', {
    timeZone: tz,
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(iso))
}

export function fmtRelative(iso: string, now: number = Date.now()): string {
  const diff = Math.max(0, now - new Date(iso).getTime())
  const min = Math.floor(diff / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min} min ago`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h} h ago`
  const d = Math.floor(h / 24)
  return d === 1 ? 'yesterday' : `${d} days ago`
}

/** How long ago something started, as a length of time: "just now", "35 min", "2 h 5 min", "3 days". */
export function fmtElapsed(iso: string, now: number = Date.now()): string {
  const min = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60_000))
  if (min < 1) return 'less than a minute'
  if (min < 60) return `${min} min`
  const h = Math.floor(min / 60)
  if (h < 24) return min % 60 === 0 ? `${h} h` : `${h} h ${min % 60} min`
  const d = Math.floor(h / 24)
  return d === 1 ? '1 day' : `${d} days`
}

const WEEKDAY_INDEX: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }

/** Current weekday (ISO, Monday = 1), minutes after midnight and a readable label in the given time zone. */
export function nowIn(tz: string, at: Date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at)
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  const label = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(at)
  return {
    isoDow: WEEKDAY_INDEX[get('weekday')] ?? 1,
    minutes: Number(get('hour')) * 60 + Number(get('minute')),
    label,
  }
}

/** 'YYYY-MM-DD' for today in the given time zone. */
export function todayIn(tz: string, at: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at)
}

/** 'YYYY-MM-DD' to 'Mon, Nov 9' (no time zone shift: the date is a calendar date, not an instant). */
export function fmtDate(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number)
  return new Intl.DateTimeFormat('en-PH', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }).format(
    new Date(Date.UTC(y, m - 1, d, 12)),
  )
}

/** Minutes after midnight to Postgres 'HH:MM:SS'. */
export function minutesToTime(m: number): string {
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:00`
}

export function fmtMinutes(m: number): string {
  return fmtTime(minutesToTime(m))
}

/** '2026-11-04 08:31:55' for an instant, as a clock in the given time zone (for files that people sort and read). */
export function fmtStamp(iso: string, tz: string): string {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(iso))
}

/** How far ahead of UTC the clock of a time zone is at an instant, in milliseconds. */
function zoneOffsetMs(at: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(at))
  const g = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0)
  return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second')) - Math.floor(at / 1000) * 1000
}

/** The instant (ISO, UTC) at which a calendar day 'YYYY-MM-DD' begins in the given time zone. */
export function dayStartIso(ymd: string, tz: string): string {
  const [y, m, d] = ymd.split('-').map(Number)
  const wall = Date.UTC(y, m - 1, d)
  let t = wall - zoneOffsetMs(wall, tz)
  t = wall - zoneOffsetMs(t, tz) // once more, in case a clock change fell in between
  return new Date(t).toISOString()
}

/** 'YYYY-MM-DD' plus a number of days. */
export function addDays(ymd: string, n: number): string {
  const [y, m, d] = ymd.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10)
}
