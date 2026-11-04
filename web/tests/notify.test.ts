import assert from 'node:assert/strict'
import { test } from 'node:test'
import { badgeText, dayLabel, groupByDay, newestFirst, safeLink, shouldPopUp, stripBadge, withBadge } from '../src/lib/notify.ts'
import type { NotificationRow } from '../src/lib/types.ts'

const row = (id: string, at: string, over: Partial<NotificationRow> = {}): NotificationRow => ({
  id, kind: 'request_new', severity: 'info', title: 't', body: '', link: null, ref: id, created_at: at, read_at: null, ...over,
})

test('only pages of this app can be opened from a message', () => {
  assert.equal(safeLink('/requests'), '/requests')
  assert.equal(safeLink('/timetables?term=T&program=all'), '/timetables?term=T&program=all')
  assert.equal(safeLink('//evil.example/x'), null)
  assert.equal(safeLink('https://evil.example'), null)
  assert.equal(safeLink('javascript:alert(1)'), null)
  assert.equal(safeLink('/a b'), null)
  assert.equal(safeLink(''), null)
  assert.equal(safeLink(null), null)
  assert.equal(safeLink(undefined), null)
})

test('the badge text stops at 99+', () => {
  assert.equal(badgeText(0), '0')
  assert.equal(badgeText(7), '7')
  assert.equal(badgeText(99), '99')
  assert.equal(badgeText(100), '99+')
  assert.equal(badgeText(-3), '0')
})

test('the tab title gets one count in front and loses it again', () => {
  assert.equal(withBadge('Classroom360', 3), '(3) Classroom360')
  assert.equal(withBadge('(3) Classroom360', 5), '(5) Classroom360')
  assert.equal(withBadge('(5) Classroom360', 0), 'Classroom360')
  assert.equal(withBadge('Classroom360', 250), '(99+) Classroom360')
  assert.equal(stripBadge('(99+) Classroom360'), 'Classroom360')
  assert.equal(stripBadge('Classroom360 (2)'), 'Classroom360 (2)')
})

test('the newest message comes first and ties keep a steady order', () => {
  const rows = [row('b', '2026-11-03T01:00:00Z'), row('a', '2026-11-03T01:00:00Z'), row('c', '2026-11-04T00:00:00Z')]
  assert.deepEqual(newestFirst(rows).map((r) => r.id), ['c', 'a', 'b'])
  assert.deepEqual(rows.map((r) => r.id), ['b', 'a', 'c'], 'the input is left as it was')
})

test('days are the school’s days, not the browser’s', () => {
  const tz = 'Asia/Manila'
  const now = new Date('2026-11-04T01:00:00Z') // 09:00 on the 4th in Manila
  assert.equal(dayLabel('2026-11-03T17:00:00Z', now, tz), 'Today') // 01:00 on the 4th in Manila
  assert.equal(dayLabel('2026-11-03T15:00:00Z', now, tz), 'Yesterday') // 23:00 on the 3rd in Manila
  assert.match(dayLabel('2026-11-01T03:00:00Z', now, tz), /Nov/)
  const groups = groupByDay(
    [row('1', '2026-11-04T00:30:00Z'), row('2', '2026-11-03T23:00:00Z'), row('3', '2026-11-03T10:00:00Z'), row('4', '2026-10-30T03:00:00Z')],
    now,
    tz,
  )
  assert.deepEqual(groups.map((g) => [g.label === 'Today' || g.label === 'Yesterday' ? g.label : 'date', g.rows.length]), [['Today', 2], ['Yesterday', 1], ['date', 1]])
})

test('a desktop pop-up needs the wish, the permission and a tab that is not in front', () => {
  assert.equal(shouldPopUp({ wanted: true, permission: 'granted', tabHidden: true }), true)
  assert.equal(shouldPopUp({ wanted: true, permission: 'granted', tabHidden: false }), false)
  assert.equal(shouldPopUp({ wanted: false, permission: 'granted', tabHidden: true }), false)
  assert.equal(shouldPopUp({ wanted: true, permission: 'default', tabHidden: true }), false)
  assert.equal(shouldPopUp({ wanted: true, permission: 'denied', tabHidden: true }), false)
})
