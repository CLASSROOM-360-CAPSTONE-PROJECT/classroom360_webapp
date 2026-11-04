/**
 * The test plan of the proposal: Table 2.2 (conditions and trial counts), the classification guide of
 * Appendix C (what TP, FP, TN and FN mean for each subsystem) and the wording of the answers.
 * The condition names are the ones the database accepts (see test_trials in migration 11).
 */
import type { Cell } from './metrics.ts'

export type Subsystem = 'rfid' | 'key_return' | 'cctv'
export const SUBSYSTEMS: Subsystem[] = ['rfid', 'key_return', 'cctv']

export interface ConditionInfo {
  value: string
  /** the wording of Table 2.2 */
  label: string
  /** should the system say yes? (the ground truth that follows from the condition) */
  positive: boolean
  /** the number of trials Table 2.2 plans; "indicative and may be adjusted upward" */
  planned: number
}

export interface SubsystemInfo {
  title: string
  /** the prefix of the trial number: RFID-001 */
  prefix: string
  conditions: ConditionInfo[]
  /** the positive class, as Appendix C words it */
  positiveClass: string
  /** the two things the system can have said */
  yes: string
  no: string
  /** the expected outcome as written in the log */
  expectedYes: string
  expectedNo: string
  actualYes: string
  actualNo: string
  cells: Record<Cell, string>
  /** the acceptance threshold for F1, if the proposal sets one */
  f1Target: number | null
}

export const SUBSYSTEM: Record<Subsystem, SubsystemInfo> = {
  rfid: {
    title: 'Card checker (RFID authentication and schedule validation)',
    prefix: 'RFID',
    conditions: [
      { value: 'authorized_in_time', label: 'Authorized instructor within scheduled time', positive: true, planned: 50 },
      { value: 'authorized_outside_time', label: 'Authorized instructor outside scheduled time', positive: false, planned: 50 },
      { value: 'different_room', label: 'Instructor assigned to a different room', positive: false, planned: 50 },
      { value: 'invalid_credential', label: 'Unregistered or invalid credential', positive: false, planned: 50 },
    ],
    positiveClass: 'A valid request: the authorized instructor, for the assigned room, within the scheduled time.',
    yes: 'The locker granted the key',
    no: 'The locker denied the request',
    expectedYes: 'Grant',
    expectedNo: 'Deny',
    actualYes: 'Granted',
    actualNo: 'Denied',
    cells: {
      TP: 'A valid request is granted.',
      FP: 'An invalid request is granted. This is the security-critical error.',
      TN: 'An invalid request is denied.',
      FN: 'A valid request is denied. The instructor is locked out of their own class.',
    },
    f1Target: 0.9,
  },
  key_return: {
    title: 'Key return detection (micro-switch)',
    prefix: 'KEY',
    conditions: [
      { value: 'key_returned', label: 'Key returned to correct compartment', positive: true, planned: 50 },
      { value: 'closed_without_key', label: 'Compartment closed without key returned', positive: false, planned: 50 },
    ],
    positiveClass: 'The physical return of a key to its assigned compartment.',
    yes: 'The system recorded the key as returned',
    no: 'The system did not record a return (the key shows as outstanding)',
    expectedYes: 'Key detected',
    expectedNo: 'No key',
    actualYes: 'Return recorded',
    actualNo: 'No return recorded',
    cells: {
      TP: 'A key returned to the compartment is detected.',
      FP: 'A return is recorded although no key was returned.',
      TN: 'A compartment closed without the key is flagged as an outstanding key.',
      FN: 'A key returned to the compartment is not detected.',
    },
    f1Target: null,
  },
  cctv: {
    title: 'Camera check (AI occupancy verification)',
    prefix: 'CCTV',
    conditions: [
      { value: 'class_in_session', label: 'Class in session during scheduled period', positive: true, planned: 50 },
      { value: 'room_vacant', label: 'Room vacant during scheduled period', positive: false, planned: 50 },
    ],
    positiveClass: 'A class in session in the monitored room during a scheduled period.',
    yes: 'The camera check said the room is occupied',
    no: 'The camera check said the room is vacant',
    expectedYes: 'Occupied',
    expectedNo: 'Vacant',
    actualYes: 'Occupied',
    actualNo: 'Vacant',
    cells: {
      TP: 'A class in session is detected as occupied.',
      FP: 'A vacant room is reported as occupied.',
      TN: 'A vacant room is reported as vacant.',
      FN: 'A class in session is reported as vacant.',
    },
    f1Target: 0.85,
  },
}

/** Table 2.2: thirty complete runs of the scheduling engine. */
export const PLANNED_SOLVER_RUNS = 30

export function plannedTotal(s: Subsystem): number {
  return SUBSYSTEM[s].conditions.reduce((a, c) => a + c.planned, 0)
}

export function conditionOf(s: Subsystem, value: string): ConditionInfo | undefined {
  return SUBSYSTEM[s].conditions.find((c) => c.value === value)
}

/** RFID-001, KEY-012, CCTV-100 */
export function trialCode(s: Subsystem, seq: number): string {
  return `${SUBSYSTEM[s].prefix}-${String(seq).padStart(3, '0')}`
}

export const expectedText = (s: Subsystem, positive: boolean) => (positive ? SUBSYSTEM[s].expectedYes : SUBSYSTEM[s].expectedNo)
export const actualText = (s: Subsystem, positive: boolean) => (positive ? SUBSYSTEM[s].actualYes : SUBSYSTEM[s].actualNo)

/** The cell, worked out the way the database does it (used to preview a trial before it is saved). */
export function cellOf(expectedPositive: boolean, actualPositive: boolean): Cell {
  if (expectedPositive) return actualPositive ? 'TP' : 'FN'
  return actualPositive ? 'FP' : 'TN'
}
