import { useAuth } from '@/auth/AuthProvider'
import { useLockerStatus, useSchoolHours } from '@/lib/api'
import { useNow } from '@/hooks/useRealtimeSync'
import { cn } from '@/lib/cn'
import { isOps } from '@/lib/roles'
import { DAY_SHORT, fmtMinutes, fmtTime, nowIn, toMinutes } from '@/lib/time'

/**
 * A small panel at the top of the menu that says what time it is on the school's clock, whether the school is open, and,
 * for the roles that run the keys, how many keys are out. The bar under the time is the day: the school's hours, how
 * far the day has gone, and a marker for now.
 */
export function CampusPulse() {
  const { profile } = useAuth()
  const tz = profile?.tenants?.timezone ?? 'Asia/Manila'
  const now = useNow(30_000)
  const here = nowIn(tz, now)
  const hours = useSchoolHours(Boolean(profile))
  const ops = isOps(profile?.role)
  const lockers = useLockerStatus(ops)

  const rows = hours.data
  const today = rows?.find((h) => h.day_of_week === here.isoDow)
  const open = today ? toMinutes(today.opens_at) : null
  const close = today ? toMinutes(today.closes_at) : null
  const isOpen = open !== null && close !== null && here.minutes >= open && here.minutes < close

  let line = ''
  if (rows) {
    if (isOpen && close !== null) line = `Open until ${fmtMinutes(close)}`
    else if (open !== null && here.minutes < open) line = `Opens today at ${fmtMinutes(open)}`
    else {
      // the next day that has opening hours
      for (let d = 1; d <= 7; d++) {
        const dow = ((here.isoDow - 1 + d) % 7) + 1
        const h = rows.find((r) => r.day_of_week === dow)
        if (h) {
          line = `Opens ${d === 1 ? 'tomorrow' : DAY_SHORT[dow - 1]} at ${fmtTime(h.opens_at)}`
          break
        }
      }
      if (!line) line = 'No opening hours set'
    }
  }

  // the bar covers the school day with an hour to spare on each side
  const lo = Math.max(0, Math.floor(((open ?? 7 * 60) - 60) / 60) * 60)
  const hi = Math.min(24 * 60, Math.ceil(((close ?? 19 * 60) + 60) / 60) * 60)
  const at = (m: number) => `${((Math.min(Math.max(m, lo), hi) - lo) / (hi - lo)) * 100}%`

  const keysOut = (lockers.data ?? []).filter((l) => l.key_status === 'issued').length
  const outstanding = (lockers.data ?? []).filter((l) => l.key_status === 'outstanding').length

  return (
    <div className="mx-3 mb-2 rounded-md border border-ink-700/80 bg-ink-950/50 px-3 pb-2.5 pt-2" aria-label="School clock" role="group">
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[20px] font-medium leading-7 tracking-tight text-white">{fmtMinutes(here.minutes)}</span>
        {rows && (
          <span className={cn('inline-flex items-center gap-1.5 text-[12.5px] font-medium', isOpen ? 'text-brass-300' : 'text-ink-400')}>
            <span aria-hidden className={cn('size-2 rounded-full', isOpen ? 'bg-brass-400 shadow-[0_0_6px_1px_rgb(210_154_63/0.55)]' : 'bg-ink-700 ring-1 ring-inset ring-ink-600')} />
            {isOpen ? 'Open' : 'Closed'}
          </span>
        )}
      </div>
      {rows && <div className="text-[12.5px] leading-5 text-ink-300">{line}</div>}

      {/* the day: school hours as a lighter stretch, the hours gone by in brass, a marker for now */}
      <div className="relative mt-2 h-1.5 rounded-full bg-ink-800" aria-hidden>
        {open !== null && close !== null && <div className="absolute inset-y-0 rounded-full bg-ink-600" style={{ left: at(open), width: `calc(${at(close)} - ${at(open)})` }} />}
        {open !== null && close !== null && here.minutes > open && (
          <div className="absolute inset-y-0 rounded-full bg-brass-400" style={{ left: at(open), width: `calc(${at(Math.min(here.minutes, close))} - ${at(open)})` }} />
        )}
        <div className="absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white ring-2 ring-ink-950" style={{ left: at(here.minutes) }} />
      </div>

      {ops && lockers.data && (
        <div className="mt-2.5 flex items-center gap-4 text-[12.5px] text-ink-300 [@media(max-height:960px)]:hidden">
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden className={cn('size-2 rounded-full', keysOut > 0 ? 'bg-brass-400' : 'bg-ink-700 ring-1 ring-inset ring-ink-600')} />
            {keysOut === 1 ? '1 key out' : `${keysOut} keys out`}
          </span>
          <span className={cn('inline-flex items-center gap-1.5', outstanding > 0 && 'text-rose-300')}>
            <span aria-hidden className={cn('size-2 rounded-full', outstanding > 0 ? 'bg-rose-400 motion-safe:animate-pulse' : 'bg-ink-700 ring-1 ring-inset ring-ink-600')} />
            {outstanding} not returned
          </span>
        </div>
      )}
    </div>
  )
}
