/**
 * How much of the school's open time each room is scheduled for. This is the figure the proposal's
 * introduction is about (a room "scheduled" is not the same as a room used): the timetable side only.
 * What the camera saw is on the Cameras page and in the alerts.
 */
import { toMinutes } from './time.ts'

export interface UsageMeeting {
  room_id: string
  day_of_week: number
  start_time: string
  end_time: string
}

export interface UsageHour {
  day_of_week: number
  opens_at: string
  closes_at: string
}

export interface UsageRoom {
  id: string
  code: string
  name: string
}

export interface RoomUsage {
  room_id: string
  code: string
  name: string
  meetings: number
  /** scheduled hours in a week */
  scheduledHours: number
  /** hours the school is open in a week (the same for every room) */
  openHours: number
  /** scheduled / open, 0 to 1 (null when the school has no open hours set) */
  share: number | null
}

export function roomUsage(rooms: readonly UsageRoom[], meetings: readonly UsageMeeting[], hours: readonly UsageHour[]): RoomUsage[] {
  const openByDay = new Map(hours.map((h) => [h.day_of_week, Math.max(0, toMinutes(h.closes_at) - toMinutes(h.opens_at))]))
  const openMinutes = [...openByDay.values()].reduce((a, b) => a + b, 0)
  const byRoom = new Map<string, { n: number; minutes: number }>()
  for (const m of meetings) {
    const open = hours.find((h) => h.day_of_week === m.day_of_week)
    if (!open) continue // a meeting on a day the school is closed counts nowhere (the database does not allow it)
    // only the part inside opening time counts, so the share can never pass 100%
    const start = Math.max(toMinutes(m.start_time), toMinutes(open.opens_at))
    const end = Math.min(toMinutes(m.end_time), toMinutes(open.closes_at))
    const e = byRoom.get(m.room_id) ?? { n: 0, minutes: 0 }
    e.n += 1
    e.minutes += Math.max(0, end - start)
    byRoom.set(m.room_id, e)
  }
  return rooms.map((r) => {
    const e = byRoom.get(r.id) ?? { n: 0, minutes: 0 }
    return {
      room_id: r.id,
      code: r.code,
      name: r.name,
      meetings: e.n,
      scheduledHours: e.minutes / 60,
      openHours: openMinutes / 60,
      share: openMinutes > 0 ? e.minutes / openMinutes : null,
    }
  })
}
