import { toMinutes } from './time.ts'

/**
 * The hours the strip covers, in minutes after midnight, whole hours only. The school's opening hours set it when
 * they are known; a class outside them stretches it so nothing is cut off; with neither, a school day of 7 AM to 7 PM.
 */
export function timelineRange(entries: { start_time: string; end_time: string }[], hours: { open: number; close: number } | null): { lo: number; hi: number } {
  let lo = hours ? hours.open : Infinity
  let hi = hours ? hours.close : -Infinity
  for (const e of entries) {
    lo = Math.min(lo, toMinutes(e.start_time))
    hi = Math.max(hi, toMinutes(e.end_time))
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return { lo: 7 * 60, hi: 19 * 60 }
  lo = Math.floor(lo / 60) * 60
  hi = Math.min(24 * 60, Math.ceil(hi / 60) * 60)
  // at least four hours across, so one short class does not fill the whole strip
  if (hi - lo < 240) hi = Math.min(24 * 60, lo + 240)
  return { lo, hi }
}
