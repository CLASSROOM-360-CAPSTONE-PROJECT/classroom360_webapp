import type { RoomStatus } from '@/lib/types'

export type Presence = NonNullable<RoomStatus['presence']>
export type Tone = 'neutral' | 'good' | 'warn' | 'bad' | 'brass'

interface PresenceInfo {
  /** short label for a badge */
  label: string
  /** a sentence for people who want to know why */
  why: string
  tone: Tone
  /** worth someone's attention now */
  attention: boolean
}

/** What the combined timetable, key and camera picture means, in plain words. */
export const PRESENCE: Record<Presence, PresenceInfo> = {
  no_class: { label: 'No class', why: 'Nothing is scheduled in this room now and the camera sees nobody.', tone: 'neutral', attention: false },
  occupied_unscheduled: {
    label: 'Occupied, no class',
    why: 'The camera sees people but nothing is scheduled in this room now.',
    tone: 'warn',
    attention: true,
  },
  teacher_present: {
    label: 'Teacher present',
    why: 'The scheduled instructor took the key and the camera sees people in the room.',
    tone: 'good',
    attention: false,
  },
  key_out_room_empty: {
    label: 'Key out, room empty',
    why: 'The key was taken but the camera sees nobody. The instructor may have stepped out.',
    tone: 'warn',
    attention: true,
  },
  key_out_unchecked: {
    label: 'Key out',
    why: 'The key was taken. The camera has not reported lately, so the room is unchecked.',
    tone: 'brass',
    attention: false,
  },
  key_with_other: {
    label: 'Key with someone else',
    why: 'The key is held by a person who is not scheduled in this room now.',
    tone: 'bad',
    attention: true,
  },
  people_key_in_locker: {
    label: 'People, key not taken',
    why: 'People are in the room but the key is still in the locker.',
    tone: 'warn',
    attention: true,
  },
  not_started: {
    label: 'Waiting for teacher',
    why: 'The class has just started and the key is still in the locker. The grace period is not over.',
    tone: 'neutral',
    attention: false,
  },
  teacher_absent: {
    label: 'Teacher not here',
    why: 'The class started, the grace period is over, the key is still in the locker and nobody is seen.',
    tone: 'bad',
    attention: true,
  },
  camera_only_present: {
    label: 'People seen',
    why: 'This room has no locker door, so only the camera is used. It sees people.',
    tone: 'good',
    attention: false,
  },
  camera_only_empty: {
    label: 'Room empty',
    why: 'This room has no locker door, so only the camera is used. It sees nobody.',
    tone: 'warn',
    attention: true,
  },
  unchecked: { label: 'Not checked', why: 'There is a class but no key and no recent camera report to judge by.', tone: 'neutral', attention: false },
}

export function presenceInfo(p: RoomStatus['presence'] | undefined): PresenceInfo | null {
  return p ? (PRESENCE[p] ?? null) : null
}

/**
 * A room that needs a person to look at it. Once the combined verdict exists it decides (it knows
 * about the grace period); the older mismatch flag is only used when the verdict is missing.
 */
export function needsAttention(r: Pick<RoomStatus, 'discrepancy' | 'presence'>): boolean {
  if (r.presence) return PRESENCE[r.presence]?.attention ?? false
  return Boolean(r.discrepancy)
}

/** "2 people", "1 person", "nobody", or "not checked" for the camera line. */
export function peopleText(count: number | null | undefined, occupied: boolean | null | undefined): string {
  if (occupied === null || occupied === undefined) return 'not checked'
  if (!occupied) return 'nobody'
  if (count === null || count === undefined || count < 1) return 'someone'
  return count === 1 ? '1 person' : `${count} people`
}
