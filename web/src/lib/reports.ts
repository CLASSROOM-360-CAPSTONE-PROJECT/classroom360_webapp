/**
 * The files on the Reports page. Pure functions: rows in, CSV text out, so they can be tested without a browser.
 * Times are written as a clock in the school's time zone (2026-11-04 08:31:55), never as UTC, because the
 * people who open these files read them against the school's clock.
 */
import { ACTION_LABEL, auditDetail } from './auditText.ts'
import { toCsv, type CsvCell } from './csv.ts'
import { reasonLabel } from './format.ts'
import { addDays, fmtStamp } from './time.ts'
import type { RoomUsage } from './usage.ts'
import type { AuditRow } from './types.ts'

/** One tap at the locker (granted or denied). */
export interface TapReportRow {
  id: string
  occurred_at: string
  decision: 'granted' | 'denied'
  reason: string
  card_uid_presented: string
  latency_ms: number | null
  instructors: { full_name: string } | null
  lockers: { compartment_no: number; rooms: { code: string } | null } | null
}

/** One closing of a locker door, with what the key switch saw. */
export interface KeyReturnReportRow {
  id: string
  occurred_at: string
  key_detected: boolean
  lockers: { compartment_no: number; rooms: { code: string } | null } | null
  access_logs: { instructors: { full_name: string } | null } | null
}

/** Oldest first, and the id as a tie-break so the order never changes between two downloads. */
function oldestFirst<T extends { id: string; occurred_at: string }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => (a.occurred_at < b.occurred_at ? -1 : a.occurred_at > b.occurred_at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

export function tapsCsv(rows: readonly TapReportRow[], tz: string): string {
  const head: CsvCell[] = ['Date and time', 'Instructor', 'Card number', 'Room', 'Locker door', 'Decision', 'Reason', 'Response time (ms)']
  const body = oldestFirst(rows).map((r): CsvCell[] => {
    // A denied tap is filed under the first door by the station, because nothing was opened. Showing that
    // door would claim a room that was never asked for, so it stays blank.
    const granted = r.decision === 'granted'
    return [
      fmtStamp(r.occurred_at, tz),
      r.instructors?.full_name ?? '',
      r.card_uid_presented,
      granted ? (r.lockers?.rooms?.code ?? '') : '',
      granted ? (r.lockers?.compartment_no ?? '') : '',
      granted ? 'Granted' : 'Denied',
      reasonLabel(r.reason),
      r.latency_ms ?? '',
    ]
  })
  return toCsv([head, ...body], { bom: true })
}

export function keyReturnsCsv(rows: readonly KeyReturnReportRow[], tz: string): string {
  const head: CsvCell[] = ['Date and time', 'Instructor', 'Room', 'Locker door', 'Key detected at return']
  const body = oldestFirst(rows).map((r): CsvCell[] => [
    fmtStamp(r.occurred_at, tz),
    r.access_logs?.instructors?.full_name ?? '',
    r.lockers?.rooms?.code ?? '',
    r.lockers?.compartment_no ?? '',
    r.key_detected,
  ])
  return toCsv([head, ...body], { bom: true })
}

export function auditCsv(rows: readonly AuditRow[], tz: string): string {
  const head: CsvCell[] = ['Date and time', 'Who', 'Action', 'What', 'Reason given']
  const sorted = [...rows].sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id - b.id))
  const body = sorted.map((r): CsvCell[] => [
    fmtStamp(r.created_at, tz),
    r.profiles?.full_name || r.profiles?.email || 'System',
    ACTION_LABEL[r.action] ?? r.action,
    auditDetail(r),
    r.justification ?? '',
  ])
  return toCsv([head, ...body], { bom: true })
}

export function usageCsv(rows: readonly RoomUsage[]): string {
  const head: CsvCell[] = ['Room', 'Name', 'Class meetings per week', 'Scheduled hours per week', 'Open hours per week', 'Share of open time (%)']
  const body = rows.map((r): CsvCell[] => [
    r.code,
    r.name,
    r.meetings,
    Math.round(r.scheduledHours * 100) / 100,
    Math.round(r.openHours * 100) / 100,
    r.share === null ? '' : Math.round(r.share * 1000) / 10,
  ])
  return toCsv([head, ...body], { bom: true })
}

/* ------------------------------------------------------------------ date range */

export const MAX_RANGE_DAYS = 366

export interface RangeCheck {
  ok: boolean
  /** why the range cannot be used, in words for the page */
  problem?: string
  /** first instant included, ISO (UTC) */
  fromIso?: string
  /** first instant NOT included, ISO (UTC): the start of the day after the last day picked */
  toIso?: string
  days?: number
}

const YMD = /^\d{4}-\d{2}-\d{2}$/

function validYmd(s: string): boolean {
  if (!YMD.test(s)) return false
  const [y, m, d] = s.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d))
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d
}

/**
 * The days picked, as instants. `startOfDay` is `dayStartIso` (passed in so this file does not need a time zone
 * to be tested: the test gives it a fixed offset).
 */
export function checkRange(from: string, to: string, startOfDay: (ymd: string) => string): RangeCheck {
  if (!validYmd(from) || !validYmd(to)) return { ok: false, problem: 'Pick a first and a last day.' }
  if (from > to) return { ok: false, problem: 'The first day is after the last day.' }
  const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1
  if (days > MAX_RANGE_DAYS) return { ok: false, problem: `Pick at most ${MAX_RANGE_DAYS} days at a time.` }
  return { ok: true, fromIso: startOfDay(from), toIso: startOfDay(addDays(to, 1)), days }
}

export function reportFilename(kind: string, from: string, to: string, ext = 'csv'): string {
  return from === to ? `classroom360-${kind}-${from}.${ext}` : `classroom360-${kind}-${from}-to-${to}.${ext}`
}
