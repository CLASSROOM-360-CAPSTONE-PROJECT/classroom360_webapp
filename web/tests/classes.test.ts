import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { normFacilities, normFacility, facilityTitle } from '../src/lib/facilities.ts'
import { meetingPlan, planText, weeklyHours } from '../src/lib/plan.ts'

const flat = (lec: number, lab: number) => meetingPlan(lec, lab).map((p) => `${p.component}${p.meetings}x${p.minutes}`).join(',')

describe('meeting plan (the same rule as private.meeting_plan in the database)', () => {
  it('turns units into meetings', () => {
    assert.equal(flat(3, 0), 'lecture2x90')
    assert.equal(flat(0, 1), 'lab1x180')
    assert.equal(flat(2, 1), 'lecture2x60,lab1x180')
    assert.equal(flat(1, 2), 'lecture1x60,lab2x180')
    assert.equal(flat(1.5, 0), 'lecture1x90')
    assert.equal(flat(4, 0), 'lecture2x120')
    assert.equal(flat(5, 0), 'lecture3x100')
    assert.equal(flat(0, 0.5), 'lab1x90') // half a lab unit is still one meeting
    assert.equal(flat(0, 0), '')
  })
  it('describes it in words and counts hours', () => {
    assert.equal(planText(meetingPlan(3, 1)), 'Lecture 2 × 90 min · Lab 1 × 180 min')
    assert.equal(weeklyHours(3, 1), 6)
    assert.equal(weeklyHours(2, 0.5), 3.5)
  })
})

describe('room type spelling (the same rule as private.norm_facility in the database)', () => {
  it('writes every spelling one way', () => {
    assert.equal(normFacility('Chemistry Laboratory'), 'chemistry_lab')
    assert.equal(normFacility(' Computer  lab '), 'computer_lab')
    assert.equal(normFacility('computer_lab'), 'computer_lab')
    assert.equal(normFacility('Nursing Skills Lab.'), 'nursing_skills_lab')
    assert.equal(normFacility('  '), '')
    assert.equal(normFacility('---'), '')
  })
  it('cleans a list: no blanks, no repeats, sorted', () => {
    assert.deepEqual(normFacilities(['Gym', 'gym', ' ', 'Computer Laboratory', 'chemistry lab']), ['chemistry_lab', 'computer_lab', 'gym'])
  })
  it('shows a readable name', () => {
    assert.equal(facilityTitle('chemistry_lab'), 'Chemistry lab')
  })
})
