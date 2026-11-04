import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { Modal } from '@/components/Modal'
import { ScheduleStatusBadge } from '@/components/StatusBadges'
import { BLOCK, DEFAULT_END, DEFAULT_START, EntryMarks, HOUR_H, layoutDay, markText } from '@/components/WeeklyGrid'
import { Button, inputCls } from '@/components/ui'
import { cn } from '@/lib/cn'
import { findConflicts, summarizeConflicts, type Conflict } from '@/lib/conflicts'
import { friendlyError } from '@/lib/errors'
import { lastName, STATUS_LABEL } from '@/lib/format'
import { DAY_SHORT, fmtMinutes, fmtRange, minutesToTime, toMinutes } from '@/lib/time'
import type { BusyRow, RoomOption, ScheduleEntryRow } from '@/lib/types'

const SNAP = 15

export interface MoveTarget {
  room_id: string
  day_of_week: number
  start_time: string
  end_time: string
}

interface Props {
  /** The meetings being edited (already narrowed by the page's program and room filters). */
  entries: ScheduleEntryRow[]
  /** Every non-rejected booking the user may see, across departments (schedule_busy). */
  busy: BusyRow[]
  rooms: RoomOption[]
  roomFilter: string
  ownDepartmentId: string | null
  canEdit: (e: ScheduleEntryRow) => boolean
  /** a locked (submitted, approved or published) meeting this person may still move, with a justification */
  canOverride: (e: ScheduleEntryRow) => boolean
  onMove: (entry: ScheduleEntryRow, to: MoveTarget) => void
  /** resolves with the database's warnings; rejects with the reason it was refused */
  onOverride: (entry: ScheduleEntryRow, to: MoveTarget, justification: string) => Promise<void>
  onPin: (entry: ScheduleEntryRow, pinned: boolean) => void
  onBlocked: (lines: string[]) => void
}

interface DragState {
  id: string
  room_id: string
  day: number
  start: number
  over: 'grid' | 'chip' | 'none'
  conflicts: Conflict[]
}

const durationOf = (e: ScheduleEntryRow) => toMinutes(e.end_time) - toMinutes(e.start_time)

function evaluate(e: ScheduleEntryRow, room_id: string, day: number, start: number, busy: BusyRow[]): Conflict[] {
  return findConflicts(
    {
      id: e.id,
      room_id,
      instructor_id: e.instructor_id,
      cohort_key: e.cohort_key,
      day_of_week: day,
      start,
      end: start + durationOf(e),
    },
    busy,
  )
}

/**
 * Weekly grid whose meetings can be dragged to another day or time, or dropped on a room chip to change room.
 * Every drop is checked against all departments' bookings first; the database still has the final say.
 * A click (or Enter) opens a form with the same checks, for keyboards and touch screens.
 */
export function ScheduleEditor({
  entries,
  busy,
  rooms,
  roomFilter,
  ownDepartmentId,
  canEdit,
  canOverride,
  onMove,
  onOverride,
  onPin,
  onBlocked,
}: Props) {
  const [drag, setDrag] = useState<DragState | null>(null)
  const dragRef = useRef<DragState | null>(null)
  const press = useRef<{ e: ScheduleEntryRow; x0: number; y0: number; grabY: number; moved: boolean } | null>(null)
  const colRefs = useRef<(HTMLDivElement | null)[]>([])
  const [dialog, setDialog] = useState<ScheduleEntryRow | null>(null)

  const roomCode = useCallback((id: string) => rooms.find((r) => r.id === id)?.code ?? 'That room', [rooms])
  const explain = useCallback(
    (list: Conflict[]) => summarizeConflicts(list, roomCode, ownDepartmentId),
    [roomCode, ownDepartmentId],
  )

  // bookings that belong to somebody else, shown hatched in the room being worked on
  const overlayRoom = drag ? drag.room_id : roomFilter !== 'all' ? roomFilter : null
  const overlay = useMemo(() => {
    if (!overlayRoom) return []
    const mine = new Set(entries.map((e) => e.id))
    return busy.filter((b) => b.room_id === overlayRoom && !mine.has(b.entry_id))
  }, [busy, entries, overlayRoom])

  // meetings that clash with something right now (only rejected ones can: they hold no slot)
  const clashing = useMemo(() => {
    const m = new Map<string, Conflict[]>()
    for (const e of entries) {
      const c = evaluate(e, e.room_id, e.day_of_week, toMinutes(e.start_time), busy)
      if (c.length) m.set(e.id, c)
    }
    return m
  }, [entries, busy])

  const { days, startHour, endHour, byDay } = useMemo(() => {
    const days = entries.some((e) => e.day_of_week === 7) || overlay.some((o) => o.day_of_week === 7) ? 7 : 6
    let startHour = DEFAULT_START
    let endHour = DEFAULT_END
    for (const x of [...entries, ...overlay]) {
      startHour = Math.min(startHour, Math.floor(toMinutes(x.start_time) / 60))
      endHour = Math.max(endHour, Math.ceil(toMinutes(x.end_time) / 60))
    }
    const byDay = Array.from({ length: days }, (_, i) => layoutDay(entries.filter((e) => e.day_of_week === i + 1)))
    return { days, startHour, endHour, byDay }
  }, [entries, overlay])

  const hours = Array.from({ length: endHour - startHour }, (_, i) => startHour + i)
  const gridH = hours.length * HOUR_H
  const cols = `52px repeat(${days}, minmax(0, 1fr))`

  // Escape abandons a drag in progress
  useEffect(() => {
    function onKey(ev: globalThis.KeyboardEvent) {
      if (ev.key === 'Escape' && press.current) {
        press.current = null
        dragRef.current = null
        setDrag(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  function track(ev: PointerEvent) {
    const p = press.current
    if (!p) return
    const e = p.e
    const dur = durationOf(e)
    const origStart = toMinutes(e.start_time)

    const hit = document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>('[data-room-drop]')
    let next: DragState
    if (hit?.dataset.roomDrop) {
      const room_id = hit.dataset.roomDrop
      next = { id: e.id, room_id, day: e.day_of_week, start: origStart, over: 'chip', conflicts: evaluate(e, room_id, e.day_of_week, origStart, busy) }
    } else {
      let col = -1
      let top = 0
      colRefs.current.forEach((el, i) => {
        if (!el) return
        const r = el.getBoundingClientRect()
        if (ev.clientX >= r.left && ev.clientX < r.right) {
          col = i
          top = r.top
        }
      })
      if (col < 0) {
        next = { id: e.id, room_id: e.room_id, day: e.day_of_week, start: origStart, over: 'none', conflicts: [] }
      } else {
        const raw = startHour * 60 + ((ev.clientY - top - p.grabY) / HOUR_H) * 60
        const start = Math.min(Math.max(Math.round(raw / SNAP) * SNAP, startHour * 60), endHour * 60 - dur)
        next = { id: e.id, room_id: e.room_id, day: col + 1, start, over: 'grid', conflicts: evaluate(e, e.room_id, col + 1, start, busy) }
      }
    }
    dragRef.current = next
    setDrag(next)
  }

  function finish() {
    const p = press.current
    const d = dragRef.current
    press.current = null
    dragRef.current = null
    setDrag(null)
    if (!p) return
    if (!p.moved) {
      setDialog(p.e)
      return
    }
    if (!d || d.over === 'none') return
    const e = p.e
    if (d.room_id === e.room_id && d.day === e.day_of_week && d.start === toMinutes(e.start_time)) return
    if (d.conflicts.length) {
      onBlocked(explain(d.conflicts))
      return
    }
    onMove(e, {
      room_id: d.room_id,
      day_of_week: d.day,
      start_time: minutesToTime(d.start),
      end_time: minutesToTime(d.start + durationOf(e)),
    })
  }

  const dragging = drag ? entries.find((e) => e.id === drag.id) : undefined
  const preview = (() => {
    if (!drag || !dragging) return null
    if (drag.over === 'none') return { ok: false, text: 'Drop it inside the week to move it.' }
    const where = `${DAY_SHORT[drag.day - 1]} ${fmtMinutes(drag.start)} to ${fmtMinutes(drag.start + durationOf(dragging))}, ${roomCode(drag.room_id)}`
    return drag.conflicts.length
      ? { ok: false, text: `${where}. ${explain(drag.conflicts).join(' ')}` }
      : { ok: true, text: `${where}. Release to move.` }
  })()

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 border-b border-ink-100 px-3 py-2.5">
        <span className="text-[13px] text-ink-500">Drop on a room to move it there:</span>
        {rooms.map((r) => {
          const over = drag?.over === 'chip' && drag.room_id === r.id
          return (
            <span
              key={r.id}
              data-room-drop={r.id}
              className={cn(
                'rounded-[5px] border px-2 py-0.5 text-[12.5px] font-medium transition-colors',
                over
                  ? drag && drag.conflicts.length
                    ? 'border-rose-400 bg-rose-100 text-rose-800'
                    : 'border-emerald-500 bg-emerald-100 text-emerald-900'
                  : 'border-ink-200 bg-ink-100 text-ink-700',
              )}
            >
              {r.code}
            </span>
          )
        })}
      </div>

      <div
        className={cn(
          'border-b px-3 py-2 text-[13px]',
          preview ? (preview.ok ? 'border-emerald-200 bg-emerald-50 text-emerald-900' : 'border-rose-200 bg-rose-50 text-rose-900') : 'border-ink-100 bg-ink-50/60 text-ink-600',
        )}
        role="status"
        aria-live="polite"
      >
        {preview
          ? preview.text
          : 'Drag a meeting to another day or time. Hatched blocks are booked by someone else. Click a meeting to set its time and room exactly.'}
      </div>

      <div className="overflow-x-auto">
        <div className="min-w-[820px]">
          <div className="grid border-b border-ink-100 bg-ink-50/70" style={{ gridTemplateColumns: cols }}>
            <div />
            {DAY_SHORT.slice(0, days).map((d) => (
              <div key={d} className="px-2 py-2 text-center text-[13px] font-medium text-ink-600">
                {d}
              </div>
            ))}
          </div>

          <div className="grid" style={{ gridTemplateColumns: cols, height: gridH }}>
            <div className="relative">
              {hours.map((h, i) => (
                <div
                  key={h}
                  className="absolute right-2 -translate-y-1/2 text-[12px] text-ink-400"
                  style={{ top: i * HOUR_H, display: i === 0 ? 'none' : undefined }}
                >
                  {((h + 11) % 12) + 1} {h >= 12 ? 'PM' : 'AM'}
                </div>
              ))}
            </div>

            {byDay.map((items, di) => (
              <div
                key={di}
                ref={(el) => {
                  colRefs.current[di] = el
                }}
                className="relative border-l border-ink-100"
              >
                {hours.map((h, i) => (
                  <div key={h} className="absolute inset-x-0 border-t border-ink-100" style={{ top: i * HOUR_H }} />
                ))}

                {overlay
                  .filter((o) => o.day_of_week === di + 1)
                  .map((o) => {
                    const top = ((toMinutes(o.start_time) - startHour * 60) / 60) * HOUR_H
                    const h = ((toMinutes(o.end_time) - toMinutes(o.start_time)) / 60) * HOUR_H
                    const own = o.department_id === ownDepartmentId
                    return (
                      <div
                        key={o.entry_id}
                        title={`Booked ${fmtRange(o.start_time, o.end_time)} by ${own ? 'your department (another program)' : (o.department_code ?? 'another department')}`}
                        className="absolute inset-x-0.5 overflow-hidden rounded-[5px] border border-ink-300 px-1.5 py-1 text-[11.5px] leading-tight text-ink-600"
                        style={{
                          top: top + 1,
                          height: h - 2,
                          backgroundImage:
                            'repeating-linear-gradient(135deg, rgb(169 184 205 / 0.35) 0 6px, rgb(244 246 250 / 0.9) 6px 12px)',
                        }}
                      >
                        <div className="truncate font-medium">{o.department_code ?? 'Booked'}</div>
                        {h >= 40 && <div className="truncate">{own ? 'Other program' : 'Other department'}</div>}
                      </div>
                    )
                  })}

                {items.map(({ e, s, en, lane, lanes }) => {
                  const top = ((s - startHour * 60) / 60) * HOUR_H
                  const h = Math.max(((en - s) / 60) * HOUR_H, 22)
                  const editable = canEdit(e)
                  const overridable = !editable && canOverride(e)
                  const clash = clashing.has(e.id)
                  const course = e.sections?.courses?.code ?? e.sections?.code ?? 'Class'
                  const label = `${course}, ${e.rooms?.code ?? 'no room'}, ${e.instructors?.full_name ?? 'no instructor'}, ${DAY_SHORT[e.day_of_week - 1]} ${fmtRange(
                    e.start_time,
                    e.end_time,
                  )} (${STATUS_LABEL[e.status]})${markText(e)}${clash ? '. Clashes with another booking.' : ''}${
                    editable ? '. Press Enter to change.' : overridable ? '. Press Enter to override it with a justification.' : ''
                  }`
                  return (
                    <div
                      key={e.id}
                      title={label}
                      aria-label={label}
                      role={editable || overridable ? 'button' : undefined}
                      tabIndex={editable || overridable ? 0 : undefined}
                      onKeyDown={(ev: KeyboardEvent) => {
                        if ((editable || overridable) && (ev.key === 'Enter' || ev.key === ' ')) {
                          ev.preventDefault()
                          setDialog(e)
                        }
                      }}
                      onClick={() => {
                        if (overridable) setDialog(e)
                      }}
                      onPointerDown={(ev) => {
                        if (!editable || ev.button !== 0) return
                        const rect = ev.currentTarget.getBoundingClientRect()
                        ev.currentTarget.setPointerCapture(ev.pointerId)
                        press.current = { e, x0: ev.clientX, y0: ev.clientY, grabY: ev.clientY - rect.top, moved: false }
                      }}
                      onPointerMove={(ev) => {
                        const p = press.current
                        if (!p || p.e.id !== e.id) return
                        if (!p.moved && Math.hypot(ev.clientX - p.x0, ev.clientY - p.y0) < 5) return
                        p.moved = true
                        track(ev)
                      }}
                      onPointerUp={() => {
                        if (press.current?.e.id === e.id) finish()
                      }}
                      onPointerCancel={() => {
                        if (press.current?.e.id === e.id) {
                          press.current = null
                          dragRef.current = null
                          setDrag(null)
                        }
                      }}
                      className={cn(
                        'absolute overflow-hidden rounded-[5px] border border-l-4 px-1.5 py-1 text-[12px] leading-tight',
                        BLOCK[e.status],
                        editable && 'cursor-grab touch-none select-none hover:shadow-md',
                        overridable && 'cursor-pointer hover:shadow-md',
                        drag?.id === e.id && 'opacity-40',
                        clash && 'ring-2 ring-rose-500',
                      )}
                      style={{
                        top: top + 1,
                        height: h - 2,
                        left: `calc(${(lane / lanes) * 100}% + 2px)`,
                        width: `calc(${100 / lanes}% - 4px)`,
                      }}
                    >
                      <EntryMarks e={e} locked={!editable} />
                      <div className="truncate font-semibold">{course}</div>
                      {h >= 40 && <div className="truncate">{e.rooms?.code}</div>}
                      {h >= 56 && e.instructors && (
                        <div className="truncate text-[11.5px] opacity-80">{lastName(e.instructors.full_name)}</div>
                      )}
                      {clash && h >= 56 && <div className="truncate text-[11.5px] font-semibold text-rose-800">Clash</div>}
                    </div>
                  )
                })}

                {drag && dragging && drag.over === 'grid' && drag.day === di + 1 && (
                  <div
                    className={cn(
                      'pointer-events-none absolute inset-x-0.5 z-20 overflow-hidden rounded-[5px] border-2 px-1.5 py-1 text-[12px] font-semibold leading-tight',
                      drag.conflicts.length
                        ? 'border-rose-500 bg-rose-100/85 text-rose-950'
                        : 'border-emerald-500 bg-emerald-100/85 text-emerald-950',
                    )}
                    style={{
                      top: ((drag.start - startHour * 60) / 60) * HOUR_H + 1,
                      height: (durationOf(dragging) / 60) * HOUR_H - 2,
                    }}
                  >
                    {fmtMinutes(drag.start)}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>

      {dialog && (
        <MoveDialog
          key={dialog.id}
          entry={dialog}
          rooms={rooms}
          busy={busy}
          ownDepartmentId={ownDepartmentId}
          startHour={startHour}
          endHour={endHour}
          mode={canEdit(dialog) ? 'move' : 'override'}
          onClose={() => setDialog(null)}
          onMove={(to) => {
            onMove(dialog, to)
            setDialog(null)
          }}
          onPin={(pinned) => onPin(dialog, pinned)}
          onOverride={(to, why) => onOverride(dialog, to, why).then(() => setDialog(null))}
        />
      )}
    </div>
  )
}

function MoveDialog({
  entry,
  rooms,
  busy,
  ownDepartmentId,
  startHour,
  endHour,
  mode,
  onClose,
  onMove,
  onPin,
  onOverride,
}: {
  entry: ScheduleEntryRow
  rooms: RoomOption[]
  busy: BusyRow[]
  ownDepartmentId: string | null
  startHour: number
  endHour: number
  /** 'move' edits a draft or rejected meeting; 'override' moves a locked one and needs a justification */
  mode: 'move' | 'override'
  onClose: () => void
  onMove: (to: MoveTarget) => void
  onPin: (pinned: boolean) => void
  onOverride: (to: MoveTarget, justification: string) => Promise<void>
}) {
  const dur = durationOf(entry)
  const override = mode === 'override'
  const [day, setDay] = useState(entry.day_of_week)
  const [start, setStart] = useState(toMinutes(entry.start_time))
  const [roomId, setRoomId] = useState(entry.room_id)
  const [pinned, setPinned] = useState(Boolean(entry.is_pinned))
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  const roomCode = (id: string) => rooms.find((r) => r.id === id)?.code ?? 'That room'
  const conflicts = evaluate(entry, roomId, day, start, busy)
  const unchanged = day === entry.day_of_week && start === toMinutes(entry.start_time) && roomId === entry.room_id
  const pinChanged = !override && pinned !== Boolean(entry.is_pinned)
  const reasonOk = reason.trim().length >= 8
  const times: number[] = []
  for (let m = startHour * 60; m + dur <= endHour * 60; m += SNAP) times.push(m)
  const course = entry.sections?.courses
  const sectionLabel = course ? `${course.code} ${course.title}` : (entry.sections?.code ?? 'Class meeting')
  const target: MoveTarget = { room_id: roomId, day_of_week: day, start_time: minutesToTime(start), end_time: minutesToTime(start + dur) }

  function save() {
    if (override) {
      setSaving(true)
      setFailure(null)
      onOverride(target, reason.trim()).catch((err: unknown) => {
        setFailure(friendlyError(err, 'The meeting was not changed.'))
        setSaving(false)
      })
      return
    }
    if (pinChanged) onPin(pinned)
    if (!unchanged) onMove(target)
    else onClose()
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={override ? 'Override this meeting' : 'Move this meeting'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            busy={saving}
            disabled={override ? unchanged || conflicts.length > 0 || !reasonOk : (unchanged && !pinChanged) || conflicts.length > 0}
            onClick={save}
          >
            {override ? 'Override' : unchanged ? 'Save' : 'Move'}
          </Button>
        </>
      }
    >
      <div className="mb-3">
        <div className="font-medium">{sectionLabel}</div>
        <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[13px] text-ink-500">
          <span>{entry.instructors?.full_name ?? 'No instructor yet'}</span>
          <span aria-hidden>·</span>
          <span>{Math.round(dur)} minutes</span>
          <ScheduleStatusBadge status={entry.status} />
        </div>
      </div>

      {override && (
        <p className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] text-amber-950">
          This meeting is {STATUS_LABEL[entry.status].toLowerCase()}, so it is locked. Overriding moves only this meeting and leaves the rest of the
          timetable as it is.
          {entry.status === 'published' ? ' The key locker follows the new time right away.' : ''} Your reason is kept in the audit log and shown to
          the program chair and the instructor.
        </p>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <label className="block">
          <span className="mb-1 block text-[13px] font-medium text-ink-700">Day</span>
          <select value={day} onChange={(e) => setDay(Number(e.target.value))} className={inputCls}>
            {DAY_SHORT.slice(0, 7).map((d, i) => (
              <option key={d} value={i + 1}>
                {d}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-[13px] font-medium text-ink-700">Starts</span>
          <select value={start} onChange={(e) => setStart(Number(e.target.value))} className={inputCls}>
            {times.map((m) => (
              <option key={m} value={m}>
                {fmtMinutes(m)}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-[13px] font-medium text-ink-700">Room</span>
          <select value={roomId} onChange={(e) => setRoomId(e.target.value)} className={inputCls}>
            {rooms.map((r) => (
              <option key={r.id} value={r.id}>
                {r.code}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="mt-2 text-[13px] text-ink-500">Ends at {fmtMinutes(start + dur)}.</p>

      {conflicts.length > 0 ? (
        <ul className="mt-3 space-y-1 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-[13px] text-rose-900" role="alert">
          {summarizeConflicts(conflicts, roomCode, ownDepartmentId).map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : (
        !unchanged && (
          <p className="mt-3 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-[13px] text-emerald-900" role="status">
            No clash with any department.
          </p>
        )
      )}

      {override ? (
        <div className="mt-3">
          <label className="block text-[13px] font-medium text-ink-700" htmlFor="override-reason">
            Why is this meeting being moved?
          </label>
          <textarea
            id="override-reason"
            value={reason}
            onChange={(e) => {
              setReason(e.target.value)
              setFailure(null)
            }}
            rows={3}
            className={`${inputCls} mt-1 h-auto py-2`}
            placeholder="For example: the chemistry laboratory is closed for repairs on Tuesday morning."
          />
          {reason.trim().length > 0 && !reasonOk && <p className="mt-1 text-[12.5px] text-ink-500">Write a few words, so the chair and the instructor understand.</p>}
          {failure && (
            <p className="mt-2 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-[13px] text-rose-900" role="alert">
              {failure}
            </p>
          )}
        </div>
      ) : (
        <label className="mt-4 flex cursor-pointer items-start gap-2 text-[14px]">
          <input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} className="mt-1 size-4 accent-ink-900" />
          <span>
            Keep this meeting where it is
            <span className="block text-[12.5px] text-ink-500">
              When the schedule is generated again, a pinned meeting stays and the rest is planned around it.
            </span>
          </span>
        </label>
      )}
    </Modal>
  )
}
