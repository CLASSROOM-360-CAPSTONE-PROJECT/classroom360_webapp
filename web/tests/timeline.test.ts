import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { timelineRange } from '../src/lib/timeline.ts'

const e = (start_time: string, end_time: string) => ({ start_time, end_time })

describe('timelineRange', () => {
  it('uses a school day of 7 AM to 7 PM when nothing is known', () => {
    assert.deepEqual(timelineRange([], null), { lo: 7 * 60, hi: 19 * 60 })
  })
  it('follows the school hours, in whole hours', () => {
    assert.deepEqual(timelineRange([], { open: 7 * 60 + 30, close: 18 * 60 + 15 }), { lo: 7 * 60, hi: 19 * 60 })
  })
  it('stretches to fit a class outside the opening hours so nothing is cut off', () => {
    assert.deepEqual(timelineRange([e('06:00:00', '07:30:00'), e('19:00:00', '20:30:00')], { open: 7 * 60, close: 19 * 60 }), { lo: 6 * 60, hi: 21 * 60 })
  })
  it('without hours, covers just the classes', () => {
    assert.deepEqual(timelineRange([e('09:00:00', '12:00:00'), e('13:00:00', '17:00:00')], null), { lo: 9 * 60, hi: 17 * 60 })
  })
  it('is at least four hours across, so one short class does not fill the strip', () => {
    assert.deepEqual(timelineRange([e('10:00:00', '11:00:00')], null), { lo: 10 * 60, hi: 14 * 60 })
  })
  it('never runs past midnight', () => {
    const r = timelineRange([e('21:00:00', '23:30:00')], null)
    assert.equal(r.hi, 24 * 60)
    assert.equal(r.lo, 21 * 60)
  })
})
