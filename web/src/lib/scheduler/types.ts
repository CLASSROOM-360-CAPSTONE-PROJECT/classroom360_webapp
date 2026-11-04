/**
 * Timetable generator: shared types.
 *
 * Time is a grid of 30-minute slots. A weekday is 0 = Monday ... 6 = Sunday (the database's
 * ISO day minus one). Every structure here is plain data (arrays and records), so a problem
 * can be posted to a Web Worker and back without conversion.
 */
export const SLOT_MINUTES = 30
export const SLOTS_PER_DAY = 48

export interface SchedRoom {
  id: string
  code: string
  capacity: number
  facilities: string[]
  /** has any special facility (a laboratory, a computer room ...): plain lectures prefer to stay out of it */
  special: boolean
}

/** One section that still needs meetings placed. */
export interface SchedSection {
  id: string
  code: string
  courseCode: string
  /** same key the database builds (program:year:cohort); null when the section has no student block */
  cohortKey: string | null
  instructorId: string | null
  enrollment: number
  requiredFacility: string | null
  /** meetings still to place this week (weekly total minus the ones already submitted/approved/published) */
  toPlace: number
  /** length of one meeting in slots (minutes rounded up to the grid) */
  slots: number
  minutes: number
  /** weekdays already used by this section's kept meetings: new meetings must use other days */
  lockedDays: number[]
  /** rooms that are big enough and have the required facility */
  roomIds: string[]
}

export interface SchedInstructor {
  id: string
  name: string
  /** part-time instructors are on campus only to teach, so fewer teaching days is worth more for them */
  partTime: boolean
  /** weekly teaching capacity still free, in slots (maximum hours minus what they already teach) */
  capSlots: number
}

/** A stretch of the week that is taken: [start, end) in slots on a weekday. */
export interface Block {
  day: number
  start: number
  end: number
}

/** Something already booked, by any department. Blocks its room, instructor and student block. */
export interface FixedBooking extends Block {
  roomId: string
  instructorId: string | null
  cohortKey: string | null
}

export interface Unavailable extends Block {
  instructorId: string
}

export interface Problem {
  /** weekdays the school is open and classes may be placed on, ascending (0 = Monday) */
  days: number[]
  /** earliest opening and latest closing over all those days, in slots (a day can open later / close earlier: see dayHours) */
  open: number
  close: number
  /** opening and closing slot of each open weekday (key = weekday, 0 = Monday) */
  dayHours: Record<number, { open: number; close: number }>
  /** the hours outside school opening time on each day, as blocks that apply to every room (enforced like a booking) */
  closure: FixedBooking[]
  rooms: SchedRoom[]
  sections: SchedSection[]
  instructors: Record<string, SchedInstructor>
  unavailable: Unavailable[]
  fixed: FixedBooking[]
}

export interface Placement {
  sectionId: string
  /** which of the section's meetings this is (0-based; meetings of a section are interchangeable) */
  index: number
  roomId: string
  day: number
  start: number
  end: number
}

export interface Unplaced {
  sectionId: string
  index: number
  reason: string
}

/** How much each preference counts. Hard rules are never traded against these. */
export interface Weights {
  /** per slot a class starts after opening time (prefers mornings) */
  early: number
  /** per slot a class starts after `lateFrom` */
  late: number
  /** slot from which a start counts as late */
  lateFrom: number
  /** per extra room a section is spread over */
  sameRoom: number
  /** per pair of a section's meetings on consecutive days (prefers e.g. Mon + Thu) */
  consecutiveDays: number
  /** per day an instructor has to come in (prefers fewer teaching days; part-time instructors count PART_TIME_DAY_FACTOR times) */
  instructorDay: number
  /** per plain lecture meeting placed in a laboratory or other special-facility room (keeps those rooms free for the classes that need them) */
  labRoom: number
}

export const DEFAULT_WEIGHTS: Weights = {
  early: 1,
  late: 3,
  lateFrom: 34, // 17:00
  sameRoom: 30,
  consecutiveDays: 12,
  instructorDay: 6,
  labRoom: 8,
}

export const PART_TIME_DAY_FACTOR = 3

export interface SolveOptions {
  /** total wall-clock budget for the optimiser, in seconds */
  timeLimitSec: number
  weights?: Partial<Weights>
}

export type Phase = 'prepare' | 'baseline' | 'optimizing' | 'relaxing' | 'checking'

export interface Progress {
  phase: Phase
  placed: number
  total: number
  softPenalty: number | null
  elapsedMs: number
  note?: string
}

/** A complete answer the solver has found so far (the best one is kept if the chair stops early). */
export interface Incumbent {
  placements: Placement[]
  unplaced: Unplaced[]
  softPenalty: number
  engine: 'cp-sat' | 'local-search' | 'first-fit'
}

export interface SolveResult extends Incumbent {
  /** every meeting placed? */
  complete: boolean
  /** true when the optimiser proved nothing better exists (otherwise it ran out of time) */
  proven: boolean
  runtimeMs: number
  notes: string[]
  /** hard-rule violations found by the independent check. Anything above zero must never be saved. */
  violations: string[]
}

export interface Hooks {
  onProgress?: (p: Progress) => void
  onIncumbent?: (i: Incumbent) => void
}
