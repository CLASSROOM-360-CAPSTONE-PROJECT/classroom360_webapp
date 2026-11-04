import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { fmtElapsed } from '../src/lib/time.ts'

const at = (minutesAgo: number, now = Date.parse('2026-11-04T10:00:00Z')) => fmtElapsed(new Date(now - minutesAgo * 60_000).toISOString(), now)

describe('fmtElapsed', () => {
  it('says less than a minute for a fresh start and never goes negative', () => {
    assert.equal(at(0), 'less than a minute')
    assert.equal(at(-5), 'less than a minute')
  })
  it('counts minutes, then hours and minutes, then days', () => {
    assert.equal(at(35), '35 min')
    assert.equal(at(60), '1 h')
    assert.equal(at(125), '2 h 5 min')
    assert.equal(at(24 * 60), '1 day')
    assert.equal(at(3 * 24 * 60 + 90), '3 days')
  })
})
