import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { ATTENTION_PRESENCE, alertText } from '../src/lib/alerts.ts'
import { auditDetail } from '../src/lib/auditText.ts'
import { roomUsage } from '../src/lib/usage.ts'
import type { OpsAlert } from '../src/lib/types.ts'

const NOW = Date.parse('2026-11-04T02:00:00Z') // 10:00 in Manila
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString()
const base: OpsAlert = { kind: 'room_attention', severity: 'medium', code: null, room_code: null, subject: null, occurred_at: null, attempts: 1, ref: 'x' }
const text = (a: Partial<OpsAlert>) => alertText({ ...base, ...a }, 'Asia/Manila', NOW)

describe('alert wording', () => {
  it('a key not returned names the room, the holder and when it was taken', () => {
    const t = text({ kind: 'key_not_returned', severity: 'high', room_code: 'LRC-301', subject: 'Maria Santos', occurred_at: '2026-11-03T01:05:00Z' })
    assert.equal(t.title, 'Key not returned: LRC-301')
    assert.match(t.detail, /^Maria Santos took it Nov 3, 9:05 AM and the class has ended\.$/)
    assert.equal(t.tone, 'bad')
  })
  it('a room that needs a look uses the same words as the room table', () => {
    const t = text({ code: 'teacher_absent', room_code: 'LRC-302', subject: 'Jose Reyes' })
    assert.equal(t.title, 'LRC-302: Teacher not here')
    assert.ok(t.detail.startsWith('Scheduled: Jose Reyes. The class started'))
    assert.equal(t.tone, 'warn')
    assert.equal(text({ code: 'key_with_other', severity: 'high', room_code: 'LRC-303' }).title, 'LRC-303: Key with someone else')
    assert.equal(text({ code: 'something_new', room_code: 'LRC-1' }).title, 'LRC-1: Needs a look') // a code from a newer database does not break the page
  })
  it('an unknown card shows its number and how many times', () => {
    const t = text({ kind: 'denied_attempts', severity: 'high', code: 'unregistered_credential', subject: 'DEADBEEF', attempts: 3, occurred_at: iso(10) })
    assert.equal(t.title, 'Unknown card at the locker')
    assert.equal(t.detail, 'Unknown card DEADBEEF tapped 3 times (card not registered), last 10 min ago.')
  })
  it('a known instructor in the wrong place shows the name', () => {
    const t = text({ kind: 'denied_attempts', code: 'assigned_to_different_room', subject: 'Ana Cruz', occurred_at: iso(60) })
    assert.equal(t.title, 'Denied at the locker: Ana Cruz')
    assert.equal(t.detail, 'Ana Cruz tapped once (scheduled in a different room), last 1 h ago.')
  })
  it('a silent station and a station that never reported are told apart', () => {
    const silent = text({ kind: 'station_offline', severity: 'high', code: 'silent', subject: 'LRC 3F Key Locker', occurred_at: iso(7) })
    assert.equal(silent.title, 'Locker station is not responding')
    assert.match(silent.detail, /last heard from 7 min ago/)
    assert.match(silent.detail, /no key can be released/)
    const never = text({ kind: 'station_offline', severity: 'medium', code: 'never', subject: 'LRC 3F Key Locker' })
    assert.equal(never.title, 'Locker station has not connected yet')
    assert.match(never.detail, /never reported/)
  })
})

describe('the alert list and the database agree', () => {
  it('ops_alerts() raises a room alert for exactly the verdicts the web app marks as "needs attention"', () => {
    const sql = readFileSync(new URL('../../supabase/migrations/20261106000011_evaluation_alerts_station_health.sql', import.meta.url), 'utf8')
    const m = sql.match(/rs\.presence in \(([^)]*)\)/)
    assert.ok(m, 'the verdict list is missing from ops_alerts()')
    const inSql = [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]).sort()
    assert.deepEqual(inSql, ATTENTION_PRESENCE)
  })
})

describe('audit log wording', () => {
  it('describes a deleted trial', () => {
    assert.equal(
      auditDetail({ action: 'TRIAL_DELETED', table_name: 'test_trials', old_data: { subsystem: 'rfid', seq: 7, result: 'FP' }, new_data: null }),
      'test trial rfid no. 7 (FP)',
    )
  })
  it('keeps the older wording', () => {
    assert.equal(auditDetail({ action: 'UPDATE', table_name: 'school_hours', old_data: null, new_data: null }), 'school hours')
    assert.equal(auditDetail({ action: 'DELETE', table_name: 'rooms', old_data: { code: 'LRC-9' }, new_data: null }), 'room LRC-9')
  })
})

describe('how much of the open time each room is scheduled', () => {
  const rooms = [
    { id: 'r1', code: 'LRC-301', name: 'A' },
    { id: 'r2', code: 'LRC-302', name: 'B' },
  ]
  const hours = [1, 2, 3, 4, 5].map((d) => ({ day_of_week: d, opens_at: '08:00:00', closes_at: '17:00:00' })) // 45 hours a week
  it('adds the scheduled hours and divides by the open hours', () => {
    const u = roomUsage(
      rooms,
      [
        { room_id: 'r1', day_of_week: 1, start_time: '08:00:00', end_time: '09:30:00' }, // 1.5 h
        { room_id: 'r1', day_of_week: 3, start_time: '13:00:00', end_time: '16:00:00' }, // 3 h
      ],
      hours,
    )
    assert.equal(u[0].meetings, 2)
    assert.equal(u[0].scheduledHours, 4.5)
    assert.equal(u[0].openHours, 45)
    assert.equal(u[0].share, 0.1)
    assert.deepEqual([u[1].meetings, u[1].scheduledHours, u[1].share], [0, 0, 0])
  })
  it('counts only the part inside opening time and ignores a day the school is closed', () => {
    const u = roomUsage(
      rooms,
      [
        { room_id: 'r1', day_of_week: 1, start_time: '07:00:00', end_time: '09:00:00' }, // 1 h inside
        { room_id: 'r1', day_of_week: 6, start_time: '08:00:00', end_time: '10:00:00' }, // Saturday: closed
      ],
      hours,
    )
    assert.equal(u[0].scheduledHours, 1)
    assert.equal(u[0].meetings, 1)
  })
  it('has no share when the school has no open hours set', () => {
    assert.equal(roomUsage(rooms, [], [])[0].share, null)
  })
})
