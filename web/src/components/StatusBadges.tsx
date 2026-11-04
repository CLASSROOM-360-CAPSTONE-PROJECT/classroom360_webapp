import { Badge } from '@/components/ui'
import { REQUEST_STATUS_LABEL, STATUS_LABEL } from '@/lib/format'
import type { KeyStatus, RequestStatus, RoomStatus, ScheduleStatus } from '@/lib/types'

export function KeyBadge({ status }: { status: KeyStatus | null }) {
  if (status === 'issued') return <Badge tone="brass">Key out</Badge>
  if (status === 'outstanding') return <Badge tone="bad">Not returned</Badge>
  if (status === 'available') return <Badge>In locker</Badge>
  return <span className="text-ink-400">No locker</span>
}

export function OccupancyBadge({ occupied }: { occupied: boolean | null }) {
  if (occupied === true) return <Badge tone="good">Occupied</Badge>
  if (occupied === false) return <Badge>Empty</Badge>
  return <span className="text-ink-400">No reading</span>
}

export function DecisionBadge({ decision }: { decision: 'granted' | 'denied' }) {
  return decision === 'granted' ? <Badge tone="good">Granted</Badge> : <Badge tone="bad">Denied</Badge>
}

const scheduleTone: Record<ScheduleStatus, 'neutral' | 'warn' | 'good' | 'brass' | 'bad'> = {
  draft: 'neutral',
  submitted: 'warn',
  approved: 'good',
  published: 'brass',
  returned: 'bad',
}

export function ScheduleStatusBadge({ status }: { status: ScheduleStatus }) {
  return <Badge tone={scheduleTone[status]}>{STATUS_LABEL[status]}</Badge>
}

export function keyTagTone(s: RoomStatus['key_status']): 'brass' | 'ink' | 'alert' {
  if (s === 'issued') return 'brass'
  if (s === 'outstanding') return 'alert'
  return 'ink'
}

const requestTone: Record<RequestStatus, 'neutral' | 'warn' | 'good' | 'bad'> = {
  pending: 'warn',
  approved: 'good',
  rejected: 'bad',
  cancelled: 'neutral',
}

export function RequestStatusBadge({ status }: { status: RequestStatus }) {
  return <Badge tone={requestTone[status]}>{REQUEST_STATUS_LABEL[status]}</Badge>
}
