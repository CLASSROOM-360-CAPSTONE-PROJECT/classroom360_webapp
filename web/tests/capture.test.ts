import assert from 'node:assert/strict'
import { test } from 'node:test'
import { candidateDetail, candidateKey, candidateSaid, candidateWhat, conditionChoices, countBySubsystem, previewCell } from '../src/lib/evaluation/capture.ts'
import type { TrialCandidate } from '../src/lib/types.ts'

const base: TrialCandidate = { subsystem: 'rfid', source_id: 's1', occurred_at: '2026-11-04T01:00:00Z', room_code: null, door: null, system_says: true, subject: null, reason: null, people: null, latency_ms: null }
const cand = (o: Partial<TrialCandidate>): TrialCandidate => ({ ...base, ...o })

test('a card tap is described by who tapped and what the locker did', () => {
  const granted = cand({ subject: 'Ana Reyes', room_code: 'LRC-301', door: 1, reason: 'scheduled_match', latency_ms: 840 })
  assert.equal(candidateWhat(granted), 'Card tap: Ana Reyes')
  assert.equal(candidateSaid(granted), 'Granted')
  assert.equal(candidateDetail(granted), 'key for LRC-301, door 1, 840 ms')
  const denied = cand({ system_says: false, subject: '04A1B2C3', reason: 'unregistered_credential', latency_ms: 910 })
  assert.equal(candidateWhat(denied), 'Card tap: 04A1B2C3')
  assert.equal(candidateSaid(denied), 'Denied')
  assert.equal(candidateDetail(denied), 'card not registered, 910 ms', 'a denied tap does not say which door')
  assert.equal(candidateWhat(cand({ subject: null })), 'Card tap: unknown card')
})

test('a door closing and a camera report', () => {
  const door = cand({ subsystem: 'key_return', room_code: 'LRC-302', door: 2, system_says: false })
  assert.equal(candidateWhat(door), 'Door 2 closed (LRC-302)')
  assert.equal(candidateSaid(door), 'No return recorded')
  assert.equal(candidateSaid({ ...door, system_says: true }), 'Return recorded')
  assert.equal(candidateDetail(door), '')
  const cam = cand({ subsystem: 'cctv', room_code: 'LRC-303', system_says: true, people: 1 })
  assert.equal(candidateWhat(cam), 'Camera report: LRC-303')
  assert.equal(candidateSaid(cam), 'Occupied')
  assert.equal(candidateDetail(cam), '1 person counted')
  assert.equal(candidateDetail({ ...cam, people: 12 }), '12 people counted')
  assert.equal(candidateSaid({ ...cam, system_says: false, people: 0 }), 'Vacant')
})

test('the cell is worked out from the real condition and the system’s answer; nothing is chosen for the person', () => {
  const granted = cand({ system_says: true })
  assert.equal(previewCell(granted, 'authorized_in_time'), 'TP')
  assert.equal(previewCell(granted, 'invalid_credential'), 'FP', 'granting an invalid request is the security-critical error')
  const denied = cand({ system_says: false })
  assert.equal(previewCell(denied, 'authorized_in_time'), 'FN')
  assert.equal(previewCell(denied, 'authorized_outside_time'), 'TN')
  assert.equal(previewCell(denied, ''), null)
  assert.equal(previewCell(denied, 'room_vacant'), null, 'a condition of another subsystem is not accepted')
  assert.equal(previewCell(cand({ subsystem: 'key_return', system_says: true }), 'closed_without_key'), 'FP')
  assert.equal(previewCell(cand({ subsystem: 'cctv', system_says: false }), 'class_in_session'), 'FN')
})

test('the choices are those of the plan, and the counts add up', () => {
  assert.deepEqual(conditionChoices('key_return').map((c) => c.value), ['key_returned', 'closed_without_key'])
  assert.equal(conditionChoices('rfid').length, 4)
  assert.equal(candidateKey(base), 'rfid:s1')
  assert.deepEqual(countBySubsystem([base, cand({ source_id: 's2' }), cand({ subsystem: 'cctv', source_id: 's3' })]), { rfid: 2, key_return: 0, cctv: 1 })
})
