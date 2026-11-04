import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { CircleAlert, CircleCheck, GripVertical, RotateCcw, Undo2, X } from 'lucide-react'
import { Button } from '@/components/ui'
import { cn } from '@/lib/cn'
import { lastName } from '@/lib/format'
import {
  clock,
  editSummaryText,
  findFreePlace,
  placeMeeting,
  placementProblems,
  spotKey,
  summarizeEdits,
  unplaceMeeting,
  type Target,
} from '@/lib/scheduler/edit'
import type { Problem, SolveResult } from '@/lib/scheduler/types'
import { DAY_SHORT } from '@/lib/time'

/** The generated timetable one room at a time, with the meetings that could not be placed in a list beside it. */

const HOUR_PX = 48
const SLOT_PX = HOUR_PX / 2
const HEAD_PX = 36
const DAY_FULL = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

/** a meeting on the timetable, or one of the meetings of a class that is still waiting for a place */
type Source = { kind: 'placed'; sectionId: string; index: number } | { kind: 'unplaced'; sectionId: string; n: number }

const sameSource = (a: Source | null, b: Source | null) =>
  Boolean(a && b && a.kind === b.kind && a.sectionId === b.sectionId && (a.kind === 'placed' ? a.index === (b as typeof a).index : a.n === (b as typeof a).n))

interface Press {
  source: Source
  x0: number
  y0: number
  /** how far below the top of the block the pointer is, so the block does not jump when it is picked up */
  grabY: number
  moved: boolean
  slots: number
  label: string
}

interface DragView {
  source: Source
  x: number
  y: number
  label: string
  target: Target | null
  reasons: string[] | null
}

export interface PlanEditorProps {
  problem: Problem
  /** the plan as it is now (with the changes made by hand) */
  result: SolveResult
  /** the plan as the scheduler made it, to show what was changed */
  original: SolveResult
  roomId: string | null
  onRoomChange: (id: string) => void
  /** a change that was checked and is allowed: the new plan, and a sentence saying what happened */
  onEdit: (next: SolveResult, note: string) => void
  onUndo: () => void
  onReset: () => void
  canUndo: boolean
  /** what the last change was, shown until the next one */
  note: string | null
  /** while the plan is being saved */
  disabled?: boolean
}

export function PlanEditor({ problem, result, original, roomId, onRoomChange, onEdit, onUndo, onReset, canUndo, note, disabled }: PlanEditorProps) {
  const secById = useMemo(() => new Map(problem.sections.map((s) => [s.id, s])), [problem])
  const roomById = useMemo(() => new Map(problem.rooms.map((r) => [r.id, r])), [problem])
  const rooms = useMemo(() => [...problem.rooms].sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true })), [problem])
  const counts = useMemo(() => {
    const m = new Map<string, number>()
    for (const p of result.placements) m.set(p.roomId, (m.get(p.roomId) ?? 0) + 1)
    return m
  }, [result.placements])
  const origSpots = useMemo(() => new Set(original.placements.map(spotKey)), [original])
  const editedRooms = useMemo(() => new Set(result.placements.filter((p) => !origSpots.has(spotKey(p))).map((p) => p.roomId)), [result.placements, origSpots])
  const edits = useMemo(() => summarizeEdits(original.placements, result.placements), [original, result])
  const changed = edits.moved + edits.placed + edits.removed > 0

  const room = rooms.find((r) => r.id === roomId) ?? rooms.find((r) => (counts.get(r.id) ?? 0) > 0) ?? rooms[0] ?? null

  // the meetings that still need a place, in class order
  const tray = useMemo(() => {
    const seen = new Map<string, number>()
    return result.unplaced
      .map((u) => {
        const n = seen.get(u.sectionId) ?? 0
        seen.set(u.sectionId, n + 1)
        return { ...u, n }
      })
      .sort(
        (a, b) =>
          (secById.get(a.sectionId)?.code ?? '').localeCompare(secById.get(b.sectionId)?.code ?? '', undefined, { numeric: true }) || a.n - b.n,
      )
  }, [result.unplaced, secById])

  // the hours shown: from the earliest opening to the latest closing over the open days
  const firstSlot = Math.floor(problem.open / 2) * 2
  const lastSlot = Math.max(firstSlot + 2, Math.ceil(problem.close / 2) * 2)
  const gridH = ((lastSlot - firstSlot) / 2) * HOUR_PX
  const hourMarks = Array.from({ length: (lastSlot - firstSlot) / 2 }, (_, i) => firstSlot / 2 + i)

  const [sel, setSel] = useState<Source | null>(null)
  const [form, setForm] = useState<Target | null>(null)
  const [refusal, setRefusal] = useState<{ what: string; reasons: string[] } | null>(null)
  const [drag, setDrag] = useState<DragView | null>(null)
  const press = useRef<Press | null>(null)
  const dragRef = useRef<DragView | null>(null)
  const suppressClick = useRef(false)
  const lastKey = useRef('')
  const lastReasons = useRef<string[]>([])
  const scroller = useRef<HTMLDivElement>(null)
  const cols = useRef<Record<number, HTMLDivElement | null>>({})

  // any change of the plan closes the form
  useEffect(() => {
    setSel(null)
    setForm(null)
  }, [result])

  const courseOf = (sectionId: string) => {
    const s = secById.get(sectionId)
    return s ? s.courseCode || s.code : sectionId
  }
  const nameOf = (sectionId: string) => {
    const s = secById.get(sectionId)
    return s ? `${courseOf(sectionId)} (${s.code})` : sectionId
  }

  /** the day and start slot under the pointer, in the room that is shown */
  function locate(x: number, y: number, p: Press): Target | null {
    const sc = scroller.current
    if (!sc || !room) return null
    const sr = sc.getBoundingClientRect()
    if (x < sr.left || x >= sr.right || y < sr.top + HEAD_PX || y >= sr.bottom) return null
    for (const day of problem.days) {
      const el = cols.current[day]
      if (!el) continue
      const r = el.getBoundingClientRect()
      if (x >= r.left && x < r.right) {
        const first = firstSlot
        const last = lastSlot - p.slots
        const start = Math.min(Math.max(Math.round((y - r.top - p.grabY) / SLOT_PX) + first, first), last)
        return { roomId: room.id, day, start }
      }
    }
    return null
  }

  function track(x: number, y: number) {
    const p = press.current
    if (!p) return
    const sc = scroller.current
    if (sc) {
      // near the top or bottom edge of the timetable it scrolls, so a late hour can be reached
      const sr = sc.getBoundingClientRect()
      if (x >= sr.left && x < sr.right) {
        if (y >= sr.top && y < sr.top + HEAD_PX + 22) sc.scrollTop -= 14
        else if (y <= sr.bottom && y > sr.bottom - 22) sc.scrollTop += 14
      }
    }
    const target = locate(x, y, p)
    let reasons: string[] | null = null
    if (target) {
      const ignore = p.source.kind === 'placed' ? p.source.index : null
      const key = `${p.source.sectionId}|${ignore ?? 'n'}|${target.roomId}|${target.day}|${target.start}`
      if (key !== lastKey.current) {
        lastKey.current = key
        lastReasons.current = placementProblems(problem, result.placements, p.source.sectionId, ignore, target)
      }
      reasons = lastReasons.current
    } else {
      lastKey.current = ''
    }
    const v: DragView = { source: p.source, x, y, label: p.label, target, reasons }
    dragRef.current = v
    setDrag(v)
  }

  function cancelPress() {
    press.current = null
    dragRef.current = null
    lastKey.current = ''
    setDrag(null)
  }

  function endPress() {
    const p = press.current
    const d = dragRef.current
    cancelPress()
    if (!p || !p.moved) return
    suppressClick.current = true
    window.setTimeout(() => {
      suppressClick.current = false
    }, 0)
    if (d?.target) commit(p.source, d.target)
  }

  // Escape drops a block that is being carried instead of closing the window
  useEffect(() => {
    function onKey(ev: globalThis.KeyboardEvent) {
      if (ev.key === 'Escape' && press.current?.moved) {
        ev.preventDefault()
        ev.stopPropagation()
        cancelPress()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })

  /** puts the meeting at `to` if every rule allows it; otherwise says why not and changes nothing */
  function commit(source: Source, to: Target) {
    const s = secById.get(source.sectionId)
    if (!s) return
    const index = source.kind === 'placed' ? source.index : null
    if (source.kind === 'placed') {
      const cur = result.placements.find((p) => p.sectionId === source.sectionId && p.index === source.index)
      if (cur && cur.roomId === to.roomId && cur.day === to.day && cur.start === to.start) return
    }
    const e = placeMeeting(problem, result, source.sectionId, index, to)
    const where = `${DAY_FULL[to.day] ?? 'that day'} ${clock(to.start)} in ${roomById.get(to.roomId)?.code ?? 'that room'}`
    if (!e.ok) {
      setRefusal({ what: `${nameOf(source.sectionId)} cannot go on ${where}`, reasons: e.reasons })
      return
    }
    setRefusal(null)
    onEdit(e.result, `${nameOf(source.sectionId)} ${source.kind === 'placed' ? 'moved to' : 'placed on'} ${where}, until ${clock(to.start + s.slots)}.`)
    if (to.roomId !== room?.id) onRoomChange(to.roomId)
  }

  function select(source: Source) {
    const s = secById.get(source.sectionId)
    if (!s || disabled) return
    setRefusal(null)
    if (source.kind === 'placed') {
      const cur = result.placements.find((p) => p.sectionId === source.sectionId && p.index === source.index)
      if (!cur) return
      setForm({ roomId: cur.roomId, day: cur.day, start: cur.start })
    } else {
      const fit = findFreePlace(problem, result.placements, source.sectionId, null, room?.id)
      const firstDay = problem.days[0] ?? 0
      const prefer = (room && s.roomIds.includes(room.id) ? room.id : s.roomIds[0]) ?? room?.id ?? ''
      setForm(fit ?? { roomId: prefer, day: firstDay, start: problem.dayHours[firstDay]?.open ?? firstSlot })
    }
    setSel(source)
  }

  function findSpot() {
    if (!sel || sel.kind !== 'unplaced') return
    const fit = findFreePlace(problem, result.placements, sel.sectionId, null, room?.id)
    if (!fit) {
      const why = result.unplaced.find((u) => u.sectionId === sel.sectionId)?.reason
      setRefusal({
        what: `No free time was found for ${nameOf(sel.sectionId)}`,
        reasons: ['Every room that fits this class breaks a rule at every time of the week.', ...(why ? [why] : [])],
      })
      return
    }
    commit(sel, fit)
  }

  function takeOff() {
    if (!sel || sel.kind !== 'placed') return
    const e = unplaceMeeting(problem, result, sel.sectionId, sel.index)
    if (!e.ok) {
      setRefusal({ what: `${nameOf(sel.sectionId)} cannot be taken off`, reasons: e.reasons })
      return
    }
    setRefusal(null)
    onEdit(e.result, `${nameOf(sel.sectionId)} taken off the timetable. It is in the “Not placed” list now.`)
  }

  /** the pointer and keyboard handlers of a block that can be carried or clicked */
  const carry = (source: Source, slots: number, label: string, fromGrid: boolean) => ({
    onPointerDown: (ev: ReactPointerEvent<HTMLElement>) => {
      if (disabled || ev.button !== 0) return
      const rect = ev.currentTarget.getBoundingClientRect()
      ev.currentTarget.setPointerCapture(ev.pointerId)
      press.current = {
        source,
        x0: ev.clientX,
        y0: ev.clientY,
        grabY: fromGrid ? ev.clientY - rect.top : (slots * SLOT_PX) / 2,
        moved: false,
        slots,
        label,
      }
    },
    onPointerMove: (ev: ReactPointerEvent<HTMLElement>) => {
      const p = press.current
      if (!p || !sameSource(p.source, source)) return
      if (!p.moved && Math.hypot(ev.clientX - p.x0, ev.clientY - p.y0) < 5) return
      p.moved = true
      track(ev.clientX, ev.clientY)
    },
    onPointerUp: () => {
      if (sameSource(press.current?.source ?? null, source)) endPress()
    },
    onPointerCancel: () => {
      if (sameSource(press.current?.source ?? null, source)) cancelPress()
    },
    onClick: () => {
      if (!suppressClick.current) select(source)
    },
    onKeyDown: (ev: KeyboardEvent<HTMLElement>) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault()
        select(source)
      }
    },
  })

  const hoursText = (slots: number) => `${slots / 2} h`
  const selSection = sel ? secById.get(sel.sectionId) : undefined
  const formReasons = useMemo(
    () => (sel && form ? placementProblems(problem, result.placements, sel.sectionId, sel.kind === 'placed' ? sel.index : null, form) : []),
    [sel, form, problem, result.placements],
  )
  const selPlaced = sel?.kind === 'placed' ? result.placements.find((p) => p.sectionId === sel.sectionId && p.index === sel.index) : undefined
  const formUnchanged = Boolean(selPlaced && form && selPlaced.roomId === form.roomId && selPlaced.day === form.day && selPlaced.start === form.start)

  if (!room) return <p className="px-1 py-6 text-center text-ink-500">There is no room to show.</p>

  const roomMeetings = result.placements.filter((p) => p.roomId === room.id)
  const roomHours = roomMeetings.reduce((sum, p) => sum + (p.end - p.start) / 2, 0)
  const facilities = room.facilities.map((f) => f.replace(/_/g, ' ')).join(', ')

  return (
    <div data-testid="plan-editor" className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <div className="text-[13px] font-medium text-ink-700">Room</div>
        <div role="tablist" aria-label="Rooms" className="flex flex-wrap gap-1.5">
          {rooms.map((r) => {
            const active = r.id === room.id
            return (
              <button
                key={r.id}
                type="button"
                role="tab"
                aria-selected={active}
                data-testid={`room-tab-${r.code}`}
                onClick={() => onRoomChange(r.id)}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-[14px]',
                  active ? 'border-ink-900 bg-ink-900 text-white' : 'border-ink-200 bg-white text-ink-800 hover:bg-ink-50',
                )}
              >
                {r.code}
                <span className={cn('rounded-full px-1.5 text-[12px] tabular-nums', active ? 'bg-white/20' : 'bg-ink-100 text-ink-600')}>
                  {counts.get(r.id) ?? 0}
                </span>
                {editedRooms.has(r.id) && <span className="size-1.5 rounded-full bg-brass-500" title="Has meetings you placed or moved" aria-label="changed by you" />}
              </button>
            )
          })}
        </div>
      </div>

      <div className="flex min-h-9 flex-wrap items-center justify-between gap-2 text-[13px]">
        <p data-testid="plan-note" role="status" className="min-w-0 flex-1 text-ink-600">
          {note ? (
            <>
              <CircleCheck className="mr-1 inline size-4 align-text-bottom text-emerald-700" aria-hidden />
              {note}
              {changed && <span className="text-ink-500"> ({editSummaryText(edits)} so far.)</span>}
            </>
          ) : (
            'Drag a block onto the timetable to place or move it, or click a block to choose its room and time. Every move is checked against the rules.'
          )}
        </p>
        <div className="flex gap-2">
          <Button variant="secondary" className="h-8 px-2.5 text-[13px]" data-testid="plan-undo" disabled={!canUndo || disabled} onClick={onUndo}>
            <Undo2 className="size-3.5" aria-hidden />
            Undo
          </Button>
          <Button variant="secondary" className="h-8 px-2.5 text-[13px]" data-testid="plan-reset" disabled={!changed || disabled} onClick={onReset}>
            <RotateCcw className="size-3.5" aria-hidden />
            Back to the generated plan
          </Button>
        </div>
      </div>

      {refusal && (
        <div className="flex items-start gap-2 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-[13.5px] text-rose-950" role="alert" data-testid="plan-refusal">
          <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          <div className="min-w-0 flex-1">
            <div className="font-medium">{refusal.what}. Nothing was changed.</div>
            <ul className="list-disc pl-5 text-rose-900">
              {refusal.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </div>
          <button type="button" aria-label="Dismiss" className="rounded p-0.5 hover:bg-rose-100" onClick={() => setRefusal(null)}>
            <X className="size-4" aria-hidden />
          </button>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_280px]">
        <section aria-label={`Timetable of ${room.code}`}>
          <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-3 text-[13px] text-ink-600">
            <h3 className="text-[15px] font-semibold text-ink-900">{room.code}</h3>
            <span>
              seats {room.capacity}
              {facilities ? ` · ${facilities}` : ''} · {roomMeetings.length} meeting{roomMeetings.length === 1 ? '' : 's'}, {roomHours} h a week
            </span>
          </div>

          <div ref={scroller} data-testid="room-grid" className="max-h-[max(50vh,320px)] overflow-auto rounded-md border border-ink-200 bg-white">
            <div className="min-w-[560px]">
              <div
                className="sticky top-0 z-10 grid border-b border-ink-100 bg-ink-50"
                style={{ gridTemplateColumns: `52px repeat(${problem.days.length}, minmax(0, 1fr))`, height: HEAD_PX }}
              >
                <div />
                {problem.days.map((d) => (
                  <div key={d} className="flex items-center justify-center text-[13px] font-medium text-ink-600">
                    {DAY_SHORT[d]}
                  </div>
                ))}
              </div>

              <div className="grid" style={{ gridTemplateColumns: `52px repeat(${problem.days.length}, minmax(0, 1fr))`, height: gridH }}>
                <div className="relative">
                  {hourMarks.map((h, i) => (
                    <div
                      key={h}
                      className="absolute right-2 -translate-y-1/2 text-[12px] text-ink-400"
                      style={{ top: i * HOUR_PX, display: i === 0 ? 'none' : undefined }}
                    >
                      {((h + 11) % 12) + 1} {h >= 12 ? 'PM' : 'AM'}
                    </div>
                  ))}
                </div>

                {problem.days.map((d) => {
                  const hours = problem.dayHours[d]
                  const target = drag?.target
                  return (
                    <div
                      key={d}
                      ref={(el) => {
                        cols.current[d] = el
                      }}
                      data-testid={`day-col-${d}`}
                      className="relative border-l border-ink-100"
                    >
                      {hourMarks.map((h, i) => (
                        <div key={h} className="absolute inset-x-0 border-t border-ink-100" style={{ top: i * HOUR_PX }} />
                      ))}

                      {hours && hours.open > firstSlot && (
                        <div className="closed-hours absolute inset-x-0 top-0" style={{ height: (hours.open - firstSlot) * SLOT_PX }} title="The school is closed" />
                      )}
                      {hours && hours.close < lastSlot && (
                        <div
                          className="closed-hours absolute inset-x-0"
                          style={{ top: (hours.close - firstSlot) * SLOT_PX, height: (lastSlot - hours.close) * SLOT_PX }}
                          title="The school is closed"
                        />
                      )}

                      {problem.fixed
                        .filter((f) => f.roomId === room.id && f.day === d && f.end > firstSlot && f.start < lastSlot)
                        .map((f, i) => (
                          <div
                            key={`fx${i}`}
                            className="booked absolute inset-x-0.5 overflow-hidden rounded-[5px] border border-ink-300 px-1.5 py-0.5 text-[11.5px] text-ink-600"
                            style={{ top: (f.start - firstSlot) * SLOT_PX + 1, height: (f.end - f.start) * SLOT_PX - 2 }}
                            title={`Already booked ${clock(f.start)} to ${clock(f.end)}`}
                          >
                            Already booked
                          </div>
                        ))}

                      {result.placements
                        .filter((p) => p.roomId === room.id && p.day === d)
                        .map((p) => {
                          const s = secById.get(p.sectionId)
                          if (!s) return null
                          const source: Source = { kind: 'placed', sectionId: p.sectionId, index: p.index }
                          const inst = s.instructorId ? problem.instructors[s.instructorId] : undefined
                          const edited = !origSpots.has(spotKey(p))
                          const h = (p.end - p.start) * SLOT_PX
                          const label = `${courseOf(p.sectionId)} (${s.code}), ${inst?.name ?? 'no instructor'}, ${DAY_FULL[p.day]} ${clock(p.start)} to ${clock(p.end)}${edited ? '. You changed this' : ''}. Press Enter to change it.`
                          return (
                            <div
                              key={`${p.sectionId}#${p.index}`}
                              role="button"
                              tabIndex={0}
                              title={label}
                              aria-label={label}
                              data-testid="grid-block"
                              data-section={s.code}
                              data-day={p.day}
                              data-start={p.start}
                              data-edited={edited ? 'true' : undefined}
                              {...carry(source, s.slots, `${courseOf(p.sectionId)} (${s.code})`, true)}
                              className={cn(
                                'absolute inset-x-0.5 select-none overflow-hidden rounded-[5px] border border-l-4 px-1.5 py-1 text-[12px] leading-tight',
                                disabled ? 'cursor-default' : 'cursor-grab touch-none hover:shadow-md',
                                edited ? 'border-brass-300 border-l-brass-500 bg-brass-100 text-ink-900' : 'border-ink-200 border-l-ink-400 bg-ink-50 text-ink-800',
                                sameSource(sel, source) && 'ring-2 ring-ink-900',
                                sameSource(drag?.source ?? null, source) && 'opacity-40',
                              )}
                              style={{ top: (p.start - firstSlot) * SLOT_PX + 1, height: h - 2 }}
                            >
                              <div className="truncate font-semibold">{courseOf(p.sectionId)}</div>
                              {h >= 40 && (
                                <div className="truncate">
                                  {s.code}
                                  {inst ? ` · ${lastName(inst.name)}` : ''}
                                </div>
                              )}
                              {h >= 64 && (
                                <div className="truncate text-[11.5px] opacity-80">
                                  {clock(p.start)} to {clock(p.end)}
                                </div>
                              )}
                            </div>
                          )
                        })}

                      {drag && target && target.day === d && target.roomId === room.id && (
                        <div
                          className={cn(
                            'pointer-events-none absolute inset-x-0.5 z-20 overflow-hidden rounded-[5px] border-2 px-1.5 py-1 text-[12px] font-semibold leading-tight',
                            drag.reasons && drag.reasons.length > 0
                              ? 'border-rose-500 bg-rose-100/85 text-rose-950'
                              : 'border-emerald-500 bg-emerald-100/85 text-emerald-950',
                          )}
                          data-testid="drop-preview"
                          style={{
                            top: (target.start - firstSlot) * SLOT_PX + 1,
                            height: (secById.get(drag.source.sectionId)?.slots ?? 2) * SLOT_PX - 2,
                          }}
                        >
                          {clock(target.start)}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
          <p className="mt-1 text-[12px] text-ink-500">Striped areas are closed hours or already booked. Blocks you placed or moved are shown in brass.</p>
        </section>

        <aside aria-label="Meetings that need a place" className="space-y-3">
          {sel && form && selSection && (
            <div data-testid="selected-panel" className="rounded-md border border-ink-300 bg-white p-3 text-[13.5px] shadow-sm">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-semibold">{nameOf(sel.sectionId)}</div>
                  <div className="text-ink-600">
                    {selSection.instructorId ? (problem.instructors[selSection.instructorId]?.name ?? 'Instructor') : 'No instructor'} · {hoursText(selSection.slots)} per meeting
                  </div>
                </div>
                <button type="button" aria-label="Close" className="rounded p-0.5 text-ink-500 hover:bg-ink-100" onClick={() => setSel(null)}>
                  <X className="size-4" aria-hidden />
                </button>
              </div>

              {selSection.roomIds.length === 0 ? (
                <p className="mt-2 text-rose-800">No active room seats this class or has what it needs, so it cannot be placed until a room or the class size changes.</p>
              ) : (
                <>
                  <div className="mt-2 grid gap-2">
                    <label className="block">
                      <span className="mb-0.5 block text-[12.5px] text-ink-600">Room</span>
                      <select
                        data-testid="panel-room"
                        className="h-9 w-full rounded-md border border-ink-200 bg-white px-2 text-[14px]"
                        value={form.roomId}
                        onChange={(e) => setForm({ ...form, roomId: e.target.value })}
                      >
                        {selSection.roomIds.map((id) => (
                          <option key={id} value={id}>
                            {roomById.get(id)?.code ?? id} (seats {roomById.get(id)?.capacity})
                          </option>
                        ))}
                      </select>
                    </label>
                    <div className="grid grid-cols-2 gap-2">
                      <label className="block">
                        <span className="mb-0.5 block text-[12.5px] text-ink-600">Day</span>
                        <select
                          data-testid="panel-day"
                          className="h-9 w-full rounded-md border border-ink-200 bg-white px-2 text-[14px]"
                          value={form.day}
                          onChange={(e) => {
                            const day = Number(e.target.value)
                            const h = problem.dayHours[day]
                            setForm({ ...form, day, start: h ? Math.min(Math.max(form.start, h.open), h.close - selSection.slots) : form.start })
                          }}
                        >
                          {problem.days.map((d) => (
                            <option key={d} value={d}>
                              {DAY_FULL[d]}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="block">
                        <span className="mb-0.5 block text-[12.5px] text-ink-600">Starts</span>
                        <select
                          data-testid="panel-start"
                          className="h-9 w-full rounded-md border border-ink-200 bg-white px-2 text-[14px]"
                          value={form.start}
                          onChange={(e) => setForm({ ...form, start: Number(e.target.value) })}
                        >
                          {startOptions(problem, form.day, selSection.slots, form.start).map((t) => (
                            <option key={t} value={t}>
                              {clock(t)}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                  </div>

                  {formReasons.length > 0 ? (
                    <ul data-testid="panel-reasons" role="alert" className="mt-2 list-disc pl-5 text-[13px] text-rose-800">
                      {formReasons.map((r) => (
                        <li key={r}>{r}</li>
                      ))}
                    </ul>
                  ) : (
                    <p data-testid="panel-ok" className="mt-2 text-[13px] text-emerald-800">
                      {formUnchanged ? 'It is here now.' : `Until ${clock(form.start + selSection.slots)}. No rule is broken.`}
                    </p>
                  )}

                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button
                      className="h-8 px-3 text-[13px]"
                      data-testid="panel-apply"
                      disabled={formReasons.length > 0 || formUnchanged || disabled}
                      onClick={() => commit(sel, form)}
                    >
                      {sel.kind === 'placed' ? 'Move here' : 'Place here'}
                    </Button>
                    {sel.kind === 'unplaced' && (
                      <Button variant="secondary" className="h-8 px-3 text-[13px]" data-testid="panel-find" disabled={disabled} onClick={findSpot}>
                        Find a free time
                      </Button>
                    )}
                    {sel.kind === 'placed' && (
                      <Button variant="secondary" className="h-8 px-3 text-[13px]" data-testid="panel-unplace" disabled={disabled} onClick={takeOff}>
                        Take off the timetable
                      </Button>
                    )}
                  </div>
                </>
              )}
            </div>
          )}

          <div data-testid="tray">
            <h3 className="text-[15px] font-semibold text-ink-900">
              Not placed <span className="tabular-nums text-ink-500">({tray.length})</span>
            </h3>
            {tray.length === 0 ? (
              <p className="mt-1 flex items-start gap-1.5 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-[13.5px] text-emerald-950">
                <CircleCheck className="mt-0.5 size-4 shrink-0" aria-hidden />
                Every meeting is on the timetable.
              </p>
            ) : (
              <>
                <p className="mb-1.5 text-[12.5px] text-ink-500">Drag one onto the timetable of {room.code}, or click it to choose a room and time.</p>
                <ul className="max-h-[44vh] space-y-1.5 overflow-y-auto pr-0.5">
                  {tray.map((u) => {
                    const s = secById.get(u.sectionId)
                    if (!s) return null
                    const source: Source = { kind: 'unplaced', sectionId: u.sectionId, n: u.n }
                    const inst = s.instructorId ? problem.instructors[s.instructorId] : undefined
                    const fits = s.roomIds.map((id) => roomById.get(id)?.code ?? id)
                    return (
                      <li key={`${u.sectionId}#${u.n}`}>
                        <button
                          type="button"
                          data-testid="tray-block"
                          data-section={s.code}
                          title={u.reason}
                          {...carry(source, s.slots, `${courseOf(u.sectionId)} (${s.code})`, false)}
                          className={cn(
                            'flex w-full select-none items-start gap-1.5 rounded-[6px] border border-l-4 border-amber-200 border-l-amber-500 bg-amber-50 px-2 py-1.5 text-left text-[13px] leading-snug text-amber-950',
                            disabled ? 'cursor-default' : 'cursor-grab touch-none hover:shadow-md',
                            sameSource(sel, source) && 'ring-2 ring-ink-900',
                            sameSource(drag?.source ?? null, source) && 'opacity-40',
                          )}
                        >
                          <GripVertical className="mt-0.5 size-4 shrink-0 text-amber-700/60" aria-hidden />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-semibold">
                              {courseOf(u.sectionId)} <span className="font-normal opacity-70">({s.code})</span>
                            </span>
                            <span className="block truncate text-[12.5px]">
                              {inst ? lastName(inst.name) : 'No instructor'} · {hoursText(s.slots)}
                            </span>
                            <span className="block truncate text-[12px] opacity-80">{fits.length > 0 ? `Fits: ${fits.join(', ')}` : 'No room fits this class'}</span>
                            <span className="mt-0.5 line-clamp-2 text-[12px] opacity-80">{u.reason}</span>
                          </span>
                        </button>
                      </li>
                    )
                  })}
                </ul>
              </>
            )}
          </div>
        </aside>
      </div>

      {drag && (
        <div
          data-testid="drag-ghost"
          className="pointer-events-none fixed z-[60] max-w-[300px] rounded-md bg-ink-900 px-2.5 py-1.5 text-[12.5px] text-white shadow-lg"
          style={{ left: drag.x + 14, top: drag.y + 14 }}
        >
          <div className="font-medium">
            {drag.label}
            {drag.target ? ` · ${DAY_SHORT[drag.target.day]} ${clock(drag.target.start)}` : ''}
          </div>
          {drag.reasons && drag.reasons.length > 0 && <div className="mt-0.5 text-rose-200">{drag.reasons[0]}</div>}
          {drag.reasons && drag.reasons.length === 0 && <div className="mt-0.5 text-emerald-200">Free: let go to put it here</div>}
          {!drag.target && <div className="mt-0.5 text-ink-300">Move over the timetable</div>}
        </div>
      )}
    </div>
  )
}

/** every start slot that fits the school day, always including the one now chosen */
function startOptions(problem: Problem, day: number, slots: number, current: number): number[] {
  const h = problem.dayHours[day]
  const out: number[] = []
  if (h) for (let t = h.open; t + slots <= h.close; t++) out.push(t)
  if (!out.includes(current)) out.push(current)
  return out.sort((a, b) => a - b)
}
