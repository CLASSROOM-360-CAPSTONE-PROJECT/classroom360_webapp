import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { compareValues, fold, matchesQuery, sortRows } from '../src/lib/tableView.ts'

describe('matchesQuery', () => {
  it('matches everything for an empty or blank query', () => {
    assert.equal(matchesQuery('LRC-301 Room 301', ''), true)
    assert.equal(matchesQuery('LRC-301 Room 301', '   '), true)
  })
  it('ignores case and accents', () => {
    assert.equal(matchesQuery('Peña, Juan', 'PENA'), true)
    assert.equal(fold('Ñandú'), 'nandu')
  })
  it('needs every word, in any order', () => {
    assert.equal(matchesQuery('Maria Santos E-001', 'santos maria'), true)
    assert.equal(matchesQuery('Maria Santos E-001', 'santos jose'), false)
  })
})

describe('compareValues and sortRows', () => {
  it('sorts numbers by size and text with embedded numbers naturally', () => {
    assert.ok(compareValues(9, 10) < 0)
    assert.ok(compareValues('Room 2', 'Room 10') < 0)
    assert.ok(compareValues('abc', 'ABD') < 0)
  })
  it('sorts both ways and keeps blanks last in either direction', () => {
    const rows = [{ n: 'b', v: 2 }, { n: 'x', v: null }, { n: 'a', v: 10 }, { n: 'c', v: 1 }]
    assert.deepEqual(sortRows(rows, (r) => r.v, 'asc').map((r) => r.n), ['c', 'b', 'a', 'x'])
    assert.deepEqual(sortRows(rows, (r) => r.v, 'desc').map((r) => r.n), ['a', 'b', 'c', 'x'])
  })
  it('is stable for ties and does not change the input', () => {
    const rows = [{ n: 1, g: 'x' }, { n: 2, g: 'x' }, { n: 3, g: 'a' }]
    const out = sortRows(rows, (r) => r.g, 'asc')
    assert.deepEqual(out.map((r) => r.n), [3, 1, 2])
    assert.deepEqual(rows.map((r) => r.n), [1, 2, 3])
  })
})
