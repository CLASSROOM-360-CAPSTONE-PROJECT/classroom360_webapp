import { facilityTitle } from './facilities.ts'
import type { RequestStatus, ScheduleStatus } from './types'

export const STATUS_LABEL: Record<ScheduleStatus, string> = {
  draft: 'Draft',
  submitted: 'Awaiting approval',
  approved: 'Approved',
  published: 'Published',
  returned: 'Rejected',
}

/** Plain-language reason for a locker decision (see authorize_key_request). */
export const REASON_LABEL: Record<string, string> = {
  scheduled_match: 'Matched the schedule',
  unregistered_credential: 'Card not registered',
  inactive_credential: 'Card deactivated',
  assigned_to_different_room: 'Scheduled in a different room',
  outside_scheduled_time: 'Outside scheduled time',
  key_already_issued: 'Key is already out',
  approved_request: 'Approved room request',
}

export function reasonLabel(reason: string): string {
  return REASON_LABEL[reason] ?? reason.replace(/_/g, ' ')
}

export const DISCREPANCY_LABEL = {
  scheduled_but_empty: 'Scheduled but empty',
  occupied_not_scheduled: 'Occupied, not scheduled',
} as const

export function lastName(full: string): string {
  const parts = full.trim().split(/\s+/)
  return parts[parts.length - 1] ?? full
}

export function firstName(full: string | null | undefined): string {
  return (full ?? '').trim().split(/\s+/)[0] ?? ''
}

export function facilityLabel(f: string): string {
  return facilityTitle(f)
}

export const REQUEST_STATUS_LABEL: Record<RequestStatus, string> = {
  pending: 'Waiting',
  approved: 'Approved',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
}
