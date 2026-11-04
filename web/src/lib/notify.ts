/** The wording and small rules for the notification bell. Pure, so they can be tested without a browser. */
import type { NotificationRow } from './types.ts'

export type NoteTone = 'bad' | 'warn' | 'neutral'

export const NOTE_TONE: Record<NotificationRow['severity'], NoteTone> = { high: 'bad', medium: 'warn', info: 'neutral' }
export const NOTE_SEVERITY_LABEL: Record<NotificationRow['severity'], string> = { high: 'Urgent', medium: 'Look soon', info: 'For information' }

/**
 * Only a page of this app may be opened from a message: one slash at the start, then plain path characters.
 * Two slashes would mean another website, so they are refused.
 */
export function safeLink(link: string | null | undefined): string | null {
  if (!link) return null
  if (link.startsWith('//')) return null
  return /^\/[A-Za-z0-9/_?=&.-]*$/.test(link) ? link : null
}

/** "99+" once the number no longer fits a small badge. */
export function badgeText(n: number): string {
  return n > 99 ? '99+' : String(Math.max(0, Math.floor(n)))
}

/** The tab title without the "(3) " the bell puts in front of it. */
export function stripBadge(title: string): string {
  return title.replace(/^\(\d+\+?\)\s+/, '')
}

/** The tab title with the number of unread messages in front, so a hidden tab shows that something is waiting. */
export function withBadge(title: string, unread: number): string {
  const base = stripBadge(title)
  return unread > 0 ? `(${badgeText(unread)}) ${base}` : base
}

/** Newest first; the id breaks a tie so the order never jumps. */
export function newestFirst(rows: NotificationRow[]): NotificationRow[] {
  return [...rows].sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : a.id < b.id ? -1 : 1))
}

const dayKey = (d: Date, tz: string) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)

/** "Today", "Yesterday" or the date, as the school's own calendar sees it. */
export function dayLabel(iso: string, now: Date, tz: string): string {
  const d = new Date(iso)
  if (dayKey(d, tz) === dayKey(now, tz)) return 'Today'
  if (dayKey(d, tz) === dayKey(new Date(now.getTime() - 24 * 3600_000), tz)) return 'Yesterday'
  return new Intl.DateTimeFormat('en-PH', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric' }).format(d)
}

/** The list cut into days, keeping the order it came in. */
export function groupByDay(rows: NotificationRow[], now: Date, tz: string): { label: string; rows: NotificationRow[] }[] {
  const out: { label: string; rows: NotificationRow[] }[] = []
  for (const r of rows) {
    const label = dayLabel(r.created_at, now, tz)
    const last = out[out.length - 1]
    if (last && last.label === label) last.rows.push(r)
    else out.push({ label, rows: [r] })
  }
  return out
}

/** Should a new message also pop up on the computer? Only when the person asked, the browser allows it, and the tab is not in front. */
export function shouldPopUp(opts: { wanted: boolean; permission: string; tabHidden: boolean }): boolean {
  return opts.wanted && opts.permission === 'granted' && opts.tabHidden
}
