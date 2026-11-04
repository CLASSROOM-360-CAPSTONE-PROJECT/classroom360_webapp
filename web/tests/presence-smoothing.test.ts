import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { OccupancySmoother, shouldReport } from '../src/lib/presence/smoothing.ts'
import { needsAttention, peopleText, PRESENCE, presenceInfo } from '../src/lib/presence/labels.ts'
import { whepUrl } from '../src/lib/presence/whep.ts'

describe('OccupancySmoother', () => {
  it('judges the first checks on what it has', () => {
    const s = new OccupancySmoother(4, 2)
    assert.deepEqual(s.push(0), { people: 0, occupied: false })
    assert.deepEqual(s.push(3), { people: 0, occupied: false }) // 1 of 2 checks, 2 needed
    assert.deepEqual(s.push(3), { people: 3, occupied: true })
  })
  it('a single first reading is accepted at once', () => {
    assert.deepEqual(new OccupancySmoother().push(2), { people: 2, occupied: true })
    assert.deepEqual(new OccupancySmoother().push(0), { people: 0, occupied: false })
  })
  it('ignores one stray detection in an empty room', () => {
    const s = new OccupancySmoother(4, 2)
    for (let i = 0; i < 4; i++) s.push(0)
    assert.equal(s.push(1).occupied, false)
    assert.equal(s.push(0).occupied, false)
  })
  it('does not lose a room because one check missed everyone', () => {
    const s = new OccupancySmoother(4, 2)
    s.push(4)
    s.push(4)
    assert.equal(s.push(0).occupied, true)
    assert.equal(s.push(0).occupied, true) // still 2 of the last 4 saw people
    assert.equal(s.push(0).occupied, false) // now only 1 does
  })
  it('reports the middle count, not a wild one', () => {
    const s = new OccupancySmoother(4, 2)
    s.push(5)
    s.push(5)
    s.push(30)
    assert.equal(s.push(5).people, 5)
  })
  it('rounds and clamps odd input and can be reset', () => {
    const s = new OccupancySmoother(2, 1)
    assert.equal(s.push(-3).occupied, false)
    assert.equal(s.push(2.6).people, 3)
    s.reset()
    assert.equal(s.push(0).occupied, false)
  })
  it('refuses nonsense settings', () => {
    assert.throws(() => new OccupancySmoother(2, 3))
    assert.throws(() => new OccupancySmoother(0, 0))
  })
})

describe('shouldReport', () => {
  const at = 1_000_000
  it('reports the first reading', () => assert.equal(shouldReport(null, { people: 0, occupied: false }, at), true))
  it('reports a change at once', () => assert.equal(shouldReport({ occupied: false, at }, { people: 2, occupied: true }, at + 1000), true))
  it('stays quiet while nothing changes', () => assert.equal(shouldReport({ occupied: true, at }, { people: 5, occupied: true }, at + 10_000), false))
  it('reports again after the heartbeat', () => assert.equal(shouldReport({ occupied: true, at }, { people: 5, occupied: true }, at + 30_000), true))
})

describe('presence words', () => {
  it('has words for every verdict the database can give', () => {
    for (const key of [
      'no_class', 'occupied_unscheduled', 'teacher_present', 'key_out_room_empty', 'key_out_unchecked', 'key_with_other',
      'people_key_in_locker', 'not_started', 'teacher_absent', 'camera_only_present', 'camera_only_empty', 'unchecked',
    ] as const) {
      const info = presenceInfo(key)
      assert.ok(info && info.label && info.why, key)
      assert.equal(PRESENCE[key], info)
    }
    assert.equal(presenceInfo(null), null)
    assert.equal(presenceInfo(undefined), null)
  })
  it('flags the rooms someone should look at', () => {
    assert.equal(needsAttention({ discrepancy: null, presence: 'teacher_absent' }), true)
    assert.equal(needsAttention({ discrepancy: null, presence: 'key_with_other' }), true)
    assert.equal(needsAttention({ discrepancy: null, presence: 'teacher_present' }), false)
    assert.equal(needsAttention({ discrepancy: null, presence: 'no_class' }), false)
  })
  it('does not raise an alarm during the grace period, even though the room is empty', () => {
    assert.equal(needsAttention({ discrepancy: 'scheduled_but_empty', presence: 'not_started' }), false)
  })
  it('falls back to the old flag when the verdict is missing', () => {
    assert.equal(needsAttention({ discrepancy: 'occupied_not_scheduled' }), true)
    assert.equal(needsAttention({ discrepancy: null }), false)
  })
  it('says how many people', () => {
    assert.equal(peopleText(null, null), 'not checked')
    assert.equal(peopleText(0, false), 'nobody')
    assert.equal(peopleText(1, true), '1 person')
    assert.equal(peopleText(7, true), '7 people')
    assert.equal(peopleText(null, true), 'someone')
  })
})

describe('whepUrl', () => {
  it('joins the gateway and the stream name', () => {
    assert.equal(whepUrl('http://192.168.1.50:8889', 'lrc-301'), 'http://192.168.1.50:8889/lrc-301/whep')
    assert.equal(whepUrl('http://pi.local:8889/', '/lrc/301/'), 'http://pi.local:8889/lrc/301/whep')
  })
})

describe('blockedByHttps', () => {
  it('blocks an http gateway on an https page, except on this same computer', async () => {
    const { blockedByHttps } = await import('../src/lib/presence/whep.ts')
    assert.equal(blockedByHttps('http://192.168.1.50:8889/lrc/whep', 'https:'), true)
    assert.equal(blockedByHttps('http://127.0.0.1:8889/lrc/whep', 'https:'), false)
    assert.equal(blockedByHttps('http://localhost:8889/lrc/whep', 'https:'), false)
    assert.equal(blockedByHttps('https://pi.example.edu/lrc/whep', 'https:'), false)
    assert.equal(blockedByHttps('http://192.168.1.50:8889/lrc/whep', 'http:'), false)
    assert.equal(blockedByHttps('not a url', 'https:'), false)
  })
})
