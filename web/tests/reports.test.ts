import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { auditCsv, checkRange, keyReturnsCsv, reportFilename, tapsCsv, usageCsv, type KeyReturnReportRow, type TapReportRow } from '../src/lib/reports.ts'
import { dayStartIso } from '../src/lib/time.ts'
import type { AuditRow } from '../src/lib/types.ts'
import type { RoomUsage } from '../src/lib/usage.ts'

const TZ = 'Asia/Manila'
const BOM = '﻿'
const lines = (csv: string) => csv.replace(BOM, '').split('\r\n').filter((l) => l !== '')

const tap = (over: Partial<TapReportRow>): TapReportRow => ({
  id: 'a',
  occurred_at: '2026-11-04T00:05:00Z',
  decision: 'granted',
  reason: 'scheduled_class',
  card_uid_presented: '04A1B2C3',
  latency_ms: 212,
  instructors: { full_name: 'Ana Reyes' },
  lockers: { compartment_no: 2, rooms: { code: 'LRC-302' } },
  ...over,
})

describe('taps report', () => {
  it('writes the clock of the school, the room and the door for a granted tap', () => {
    const l = lines(tapsCsv([tap({})], TZ))
    assert.equal(l[0], 'Date and time,Instructor,Card number,Room,Locker door,Decision,Reason,Response time (ms)')
    assert.equal(l[1], '2026-11-04 08:05:00,Ana Reyes,04A1B2C3,LRC-302,2,Granted,scheduled class,212')
  })

  it('leaves room and door blank for a denied tap and keeps the reason in words', () => {
    const l = lines(tapsCsv([tap({ decision: 'denied', reason: 'unregistered_credential', instructors: null, latency_ms: null })], TZ))
    assert.equal(l[1], '2026-11-04 08:05:00,,04A1B2C3,,,Denied,Card not registered,')
  })

  it('lists the oldest first and starts with a byte order mark so Excel reads it as UTF-8', () => {
    const csv = tapsCsv([tap({ id: 'b', occurred_at: '2026-11-04T01:00:00Z' }), tap({ id: 'a', occurred_at: '2026-11-04T00:00:00Z' })], TZ)
    assert.ok(csv.startsWith(BOM))
    const l = lines(csv)
    assert.ok(l[1].startsWith('2026-11-04 08:00:00'))
    assert.ok(l[2].startsWith('2026-11-04 09:00:00'))
  })

  it('does not let a name or card number run as a spreadsheet formula', () => {
    const l = lines(tapsCsv([tap({ card_uid_presented: '=1+1', instructors: { full_name: '@SUM(A1)' } })], TZ))
    assert.ok(l[1].includes(",'@SUM(A1),'=1+1,"))
  })
})

describe('key return report', () => {
  const kr = (over: Partial<KeyReturnReportRow>): KeyReturnReportRow => ({
    id: 'k1',
    occurred_at: '2026-11-04T05:30:00Z',
    key_detected: true,
    lockers: { compartment_no: 3, rooms: { code: 'LRC-303' } },
    access_logs: { instructors: { full_name: 'Ben Cruz' } },
    ...over,
  })

  it('says Yes or No for the key switch', () => {
    const l = lines(keyReturnsCsv([kr({}), kr({ id: 'k2', occurred_at: '2026-11-04T05:40:00Z', key_detected: false })], TZ))
    assert.equal(l[0], 'Date and time,Instructor,Room,Locker door,Key detected at return')
    assert.equal(l[1], '2026-11-04 13:30:00,Ben Cruz,LRC-303,3,Yes')
    assert.equal(l[2], '2026-11-04 13:40:00,Ben Cruz,LRC-303,3,No')
  })

  it('copes with a return that has no tap behind it', () => {
    const l = lines(keyReturnsCsv([kr({ access_logs: null })], TZ))
    assert.equal(l[1], '2026-11-04 13:30:00,,LRC-303,3,Yes')
  })
})

describe('audit report', () => {
  const row = (over: Partial<AuditRow>): AuditRow => ({
    id: 1,
    created_at: '2026-11-04T02:00:00Z',
    action: 'REQUEST_APPROVED',
    table_name: 'room_requests',
    record_id: null,
    justification: null,
    new_data: null,
    profiles: { full_name: 'Dean Lopez', email: 'dean@example.edu' },
    ...over,
  })

  it('uses the same words as the Audit log page', () => {
    const l = lines(auditCsv([row({ justification: 'Needed for the seminar, 2 hours' })], TZ))
    assert.equal(l[0], 'Date and time,Who,Action,What,Reason given')
    assert.equal(l[1], '2026-11-04 10:00:00,Dean Lopez,Approved room request,room request,"Needed for the seminar, 2 hours"')
  })

  it('names the system when nobody was signed in and keeps ids in order', () => {
    const l = lines(auditCsv([row({ id: 3, profiles: null }), row({ id: 2, profiles: { full_name: null, email: 'x@y.z' } })], TZ))
    assert.ok(l[1].includes(',x@y.z,'))
    assert.ok(l[2].includes(',System,'))
  })

  it('writes a deleted trial in words', () => {
    const l = lines(auditCsv([row({ action: 'TRIAL_DELETED', table_name: 'test_trials', old_data: { subsystem: 'rfid', seq: 7, result: 'FP' } })], TZ))
    assert.ok(l[1].includes('Deleted a test trial,test trial rfid no. 7 (FP)'))
  })
})

describe('room usage report', () => {
  it('writes hours to two places and the share as a percentage', () => {
    const rows: RoomUsage[] = [
      { room_id: 'r1', code: 'LRC-301', name: 'Lecture room', meetings: 5, scheduledHours: 7.5, openHours: 60, share: 0.125 },
      { room_id: 'r2', code: 'LRC-302', name: 'Lab', meetings: 0, scheduledHours: 0, openHours: 0, share: null },
    ]
    const l = lines(usageCsv(rows))
    assert.equal(l[1], 'LRC-301,Lecture room,5,7.5,60,12.5')
    assert.equal(l[2], 'LRC-302,Lab,0,0,0,')
  })
})

describe('date range', () => {
  const start = (ymd: string) => dayStartIso(ymd, TZ)

  it('turns the days picked into instants in the school time zone', () => {
    const r = checkRange('2026-11-04', '2026-11-04', start)
    assert.equal(r.ok, true)
    assert.equal(r.fromIso, '2026-11-03T16:00:00.000Z')
    assert.equal(r.toIso, '2026-11-04T16:00:00.000Z')
    assert.equal(r.days, 1)
  })

  it('counts the last day as included', () => {
    const r = checkRange('2026-11-01', '2026-11-07', start)
    assert.equal(r.days, 7)
    assert.equal(r.toIso, '2026-11-07T16:00:00.000Z')
  })

  it('refuses a missing, impossible or backwards range and one that is too long', () => {
    assert.equal(checkRange('', '2026-11-04', start).ok, false)
    assert.equal(checkRange('2026-02-30', '2026-03-01', start).ok, false)
    assert.equal(checkRange('2026-11-05', '2026-11-04', start).ok, false)
    assert.equal(checkRange('2025-01-01', '2026-11-04', start).ok, false)
    assert.equal(checkRange('2026-01-01', '2026-12-31', start).ok, true)
  })

  it('names files after the days', () => {
    assert.equal(reportFilename('taps', '2026-11-04', '2026-11-04'), 'classroom360-taps-2026-11-04.csv')
    assert.equal(reportFilename('taps', '2026-11-01', '2026-11-07'), 'classroom360-taps-2026-11-01-to-2026-11-07.csv')
  })
})
