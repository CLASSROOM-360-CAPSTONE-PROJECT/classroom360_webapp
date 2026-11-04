/** How the audit log is put into words. Shared by the Audit log page and the CSV report. */
import { DAY_SHORT, fmtTime } from './time.ts'
import type { AuditRow } from './types.ts'

export const ACTION_LABEL: Record<string, string> = {
  INSERT: 'Added',
  UPDATE: 'Changed',
  DELETE: 'Removed',
  SCHEDULE_GENERATED: 'Generated schedule',
  INSTRUCTOR_SAVED: 'Saved instructor',
  TEACHING_LOAD_IMPORTED: 'Imported teaching load',
  SCHEDULE_SUBMITTED: 'Submitted schedule',
  SCHEDULE_APPROVED: 'Approved schedule',
  SCHEDULE_RETURNED: 'Returned schedule',
  SCHEDULE_PUBLISHED: 'Published schedule',
  SCHEDULE_DRAFT: 'Reopened schedule',
  SCHEDULE_OVERRIDE: 'Overrode a meeting',
  CLASS_SAVED: 'Saved class',
  CLASS_DELETED: 'Deleted class',
  REQUEST_APPROVED: 'Approved room request',
  REQUEST_REJECTED: 'Rejected room request',
  REQUEST_CANCELLED: 'Cancelled room request',
  TRIAL_DELETED: 'Deleted a test trial',
}

export type AuditTone = 'neutral' | 'good' | 'warn' | 'bad' | 'brass'

export function auditTone(action: string): AuditTone {
  if (action === 'DELETE' || action === 'SCHEDULE_RETURNED' || action === 'REQUEST_REJECTED' || action === 'TRIAL_DELETED') return 'bad'
  if (action === 'SCHEDULE_PUBLISHED') return 'brass'
  if (action === 'SCHEDULE_APPROVED' || action === 'REQUEST_APPROVED') return 'good'
  if (action === 'SCHEDULE_SUBMITTED' || action === 'SCHEDULE_DRAFT' || action === 'SCHEDULE_OVERRIDE') return 'warn'
  return 'neutral'
}

/** "Tue 8:00 AM, LRC-303" from the room, day and time stored in an override's audit entry */
function where(d: Record<string, unknown> | null | undefined): string {
  if (!d) return '?'
  const day = DAY_SHORT[Number(d.day_of_week) - 1] ?? '?'
  const time = typeof d.start_time === 'string' ? fmtTime(d.start_time) : '?'
  return `${day} ${time}, ${String(d.room_code ?? 'room')}`
}

export function auditDetail(r: Pick<AuditRow, 'action' | 'table_name' | 'old_data' | 'new_data'>): string {
  if (r.action === 'SCHEDULE_OVERRIDE') return `class meeting moved from ${where(r.old_data)} to ${where(r.new_data)}`
  if (r.action === 'TRIAL_DELETED') {
    const d = r.old_data ?? {}
    return `test trial ${String(d.subsystem ?? '')} no. ${String(d.seq ?? '?')} (${String(d.result ?? '?')})`
  }
  if (r.action === 'INSTRUCTOR_SAVED') {
    const name = r.new_data?.full_name
    return typeof name === 'string' ? `instructor ${name}` : 'instructor'
  }
  if (r.action === 'TEACHING_LOAD_IMPORTED') {
    const d = r.new_data ?? {}
    return `${Number(d.rows ?? 0)} lines: ${Number(d.sections_new ?? 0)} new sections, ${Number(d.instructors_new ?? 0)} new instructors, ${Number(d.courses_new ?? 0)} new courses`
  }
  if (r.table_name === 'school_hours') return 'school hours'
  if (r.action === 'CLASS_SAVED') {
    const d = r.new_data ?? {}
    return `${String(d.course ?? 'class')} for ${String(d.program ?? '')} ${String(d.cohort ?? '')}`.trim()
  }
  if (r.action === 'CLASS_DELETED') return `class ${String(r.new_data?.section ?? '')}`.trim()
  if (r.action.startsWith('SCHEDULE_')) {
    const n = Number(r.new_data?.entries ?? 0)
    const missed = Number(r.new_data?.unplaced ?? 0)
    const together = Number(r.new_data?.programs_together ?? 1)
    return (
      `${n} class meeting${n === 1 ? '' : 's'}${r.action === 'SCHEDULE_GENERATED' && missed > 0 ? `, ${missed} not placed` : ''}` +
      (r.action === 'SCHEDULE_GENERATED' && together > 1 ? ` (planned together with ${together - 1} other program${together === 2 ? '' : 's'})` : '')
    )
  }
  if (r.table_name === 'schedule_entries' && r.action === 'UPDATE') return 'class meeting moved'
  if (r.table_name === 'schedule_entries' && r.action === 'DELETE') return 'class meeting'
  if (r.table_name === 'room_requests') return 'room request'
  if (r.table_name === 'rooms' || r.table_name === 'courses') {
    const code = (r.new_data ?? r.old_data)?.code
    if (typeof code === 'string') return `${r.table_name.slice(0, -1)} ${code}`
  }
  if (r.table_name === 'departments' || r.table_name === 'programs') {
    const code = r.new_data?.code
    return typeof code === 'string' ? `${r.table_name.slice(0, -1)} ${code}` : r.table_name.slice(0, -1)
  }
  return r.table_name.replace(/_/g, ' ')
}
