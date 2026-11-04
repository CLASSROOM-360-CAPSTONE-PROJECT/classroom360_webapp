/**
 * Wording for the capture queue on the Evaluation page: the things the system did that can become trials.
 * The system's own answer is read from the log; the only thing a person adds is what was really true.
 */
import { reasonLabel } from '../format.ts'
import type { TrialCandidate } from '../types.ts'
import type { Cell } from './metrics.ts'
import { actualText, cellOf, conditionOf, SUBSYSTEM, SUBSYSTEMS, type Subsystem } from './plan.ts'

export const candidateKey = (c: Pick<TrialCandidate, 'subsystem' | 'source_id'>) => `${c.subsystem}:${c.source_id}`

/** What the system did, in one line. */
export function candidateWhat(c: TrialCandidate): string {
  switch (c.subsystem) {
    case 'rfid':
      return `Card tap: ${c.subject ?? 'unknown card'}`
    case 'key_return':
      return `Door ${c.door ?? '?'} closed${c.room_code ? ` (${c.room_code})` : ''}`
    case 'cctv':
      return `Camera report${c.room_code ? `: ${c.room_code}` : ''}`
  }
}

/** The system's answer, in the words of the evaluation plan ("Granted", "Return recorded", "Occupied"...). */
export function candidateSaid(c: TrialCandidate): string {
  return actualText(c.subsystem, c.system_says)
}

/** Facts that help a person remember what they did at that moment. */
export function candidateDetail(c: TrialCandidate): string {
  const parts: string[] = []
  if (c.subsystem === 'rfid') {
    if (c.system_says && c.room_code) parts.push(`key for ${c.room_code}${c.door ? `, door ${c.door}` : ''}`)
    if (!c.system_says && c.reason) parts.push(reasonLabel(c.reason).toLowerCase())
    if (c.latency_ms !== null) parts.push(`${c.latency_ms} ms`)
  }
  if (c.subsystem === 'cctv' && c.people !== null) parts.push(`${c.people} ${c.people === 1 ? 'person' : 'people'} counted`)
  return parts.join(', ')
}

/** What the trial would count as, once the person says what was really true. Null until they choose. */
export function previewCell(c: TrialCandidate, condition: string): Cell | null {
  const cond = conditionOf(c.subsystem, condition)
  return cond ? cellOf(cond.positive, c.system_says) : null
}

export function countBySubsystem(list: TrialCandidate[]): Record<Subsystem, number> {
  const out = { rfid: 0, key_return: 0, cctv: 0 } as Record<Subsystem, number>
  for (const c of list) out[c.subsystem] += 1
  return out
}

export const SUBSYSTEM_SHORT: Record<Subsystem, string> = { rfid: 'Card', key_return: 'Key return', cctv: 'Camera' }

/** The choices offered for one subsystem: the conditions of Table 2.2, in the plan's order. Nothing is chosen for the person. */
export function conditionChoices(s: Subsystem): { value: string; label: string }[] {
  return SUBSYSTEM[s].conditions.map((c) => ({ value: c.value, label: c.label }))
}

export const CAPTURE_SUBSYSTEMS = SUBSYSTEMS
