/** The words for an alert. The database returns codes and facts (ops_alerts); the wording lives here. */
import { PRESENCE } from './presence/labels.ts'
import { reasonLabel } from './format.ts'
import { fmtDateTime, fmtRelative } from './time.ts'
import type { OpsAlert } from './types.ts'

export type AlertTone = 'neutral' | 'warn' | 'bad'

export interface AlertText {
  title: string
  detail: string
  tone: AlertTone
}

export const SEVERITY_TONE: Record<OpsAlert['severity'], AlertTone> = { high: 'bad', medium: 'warn', low: 'neutral' }
export const SEVERITY_LABEL: Record<OpsAlert['severity'], string> = { high: 'Urgent', medium: 'Look soon', low: 'For information' }

export function alertText(a: OpsAlert, tz: string, now: number = Date.now()): AlertText {
  const tone = SEVERITY_TONE[a.severity]
  const ago = a.occurred_at ? fmtRelative(a.occurred_at, now) : ''
  const room = a.room_code ?? 'A room'

  switch (a.kind) {
    case 'key_not_returned':
      return {
        title: `Key not returned: ${room}`,
        detail: `${a.subject ?? 'Someone'} took it ${a.occurred_at ? fmtDateTime(a.occurred_at, tz) : ''} and the class has ended.`.replace('  ', ' '),
        tone,
      }
    case 'room_attention': {
      const p = a.code ? (PRESENCE as Record<string, { label: string; why: string }>)[a.code] : undefined
      return {
        title: `${room}: ${p?.label ?? 'Needs a look'}`,
        detail: [a.subject ? `Scheduled: ${a.subject}.` : '', p?.why ?? ''].filter(Boolean).join(' '),
        tone,
      }
    }
    case 'denied_attempts': {
      const times = a.attempts > 1 ? `${a.attempts} times` : 'once'
      const who = a.code === 'unregistered_credential' ? `Unknown card ${a.subject ?? ''}`.trim() : (a.subject ?? 'Someone')
      return {
        title: a.code === 'unregistered_credential' ? 'Unknown card at the locker' : `Denied at the locker: ${a.subject ?? 'someone'}`,
        detail: `${who} tapped ${times}${a.code ? ` (${reasonLabel(a.code).toLowerCase()})` : ''}, last ${ago}.`,
        tone,
      }
    }
    case 'station_offline':
      return a.code === 'never'
        ? {
            title: 'Locker station has not connected yet',
            detail: `${a.subject ?? 'The station'} has never reported to the system. Start the program on the locker's Raspberry Pi (see pi/locker-station/README.md). Until then no key can be released.`,
            tone,
          }
        : {
            title: 'Locker station is not responding',
            detail: `${a.subject ?? 'The station'} was last heard from ${ago}. Its doors stay locked and no key can be released until it reports again.`,
            tone,
          }
  }
}

/** The room_status_now.presence values that ops_alerts() treats as "needs a look" (kept in step with the SQL; see the test). */
export const ATTENTION_PRESENCE = Object.entries(PRESENCE as Record<string, { attention: boolean }>)
  .filter(([, v]) => v.attention)
  .map(([k]) => k)
  .sort()
