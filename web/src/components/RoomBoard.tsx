import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { Link } from 'react-router-dom'
import { Elevation } from '@/components/Elevation'
import { KeyBadge } from '@/components/StatusBadges'
import { Badge } from '@/components/ui'
import { cn } from '@/lib/cn'
import { DISCREPANCY_LABEL } from '@/lib/format'
import { needsAttention, peopleText, presenceInfo } from '@/lib/presence/labels'
import { fmtRange, fmtRelative } from '@/lib/time'
import type { RoomStatus } from '@/lib/types'

/** A room with a class (or an approved request) happening now. */
export const hasClassNow = (r: RoomStatus) => Boolean((r.schedule_entry_id || r.room_request_id) && r.start_time && r.end_time)

/** A room someone should look at: the verdict says so, or its key was not returned. */
export const isFlagged = (r: RoomStatus) => needsAttention(r) || r.key_status === 'outstanding'

type Tone = 'brass' | 'ink' | 'alert'

/** The tag's colour follows the key, as everywhere else: brass while it is out, ink in the locker, red when it has not come back. */
const toneOf = (r: RoomStatus): Tone => (r.key_status === 'issued' ? 'brass' : r.key_status === 'outstanding' ? 'alert' : 'ink')

const look: Record<Tone, { card: string; head: string; hole: string }> = {
  brass: { card: 'border-brass-300', head: 'bg-brass-100 text-brass-700 hover:bg-brass-200/70', hole: 'border-brass-400' },
  ink: { card: 'border-ink-200', head: 'bg-ink-100 text-ink-700 hover:bg-ink-200/60', hole: 'border-ink-400' },
  alert: { card: 'border-rose-300', head: 'bg-rose-50 text-rose-700 hover:bg-rose-100', hole: 'border-rose-400' },
}

export function RoomTile({ r, now }: { r: RoomStatus; now: number }) {
  const [open, setOpen] = useState(false)
  const tone = toneOf(r)
  const t = look[tone]
  const info = presenceInfo(r.presence)
  const busy = hasClassNow(r)
  const detailId = `room-${r.room_id}-detail`

  return (
    <li className={cn('overflow-hidden rounded-lg border bg-white transition-shadow hover:shadow-[0_2px_10px_rgb(11_21_36/0.08)]', t.card, isFlagged(r) && 'ring-1 ring-rose-200')}>
      {/* the head is the key tag: the punched hole, the code stamped on it, and the key's state */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={detailId}
        className={cn('flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors', t.head)}
      >
        <span aria-hidden className={cn('size-[10px] shrink-0 rounded-full border-2 bg-white', t.hole)} />
        <span className="font-mono text-[15px] font-medium leading-6">{r.room_code}</span>
        <span className="ml-auto flex items-center gap-1.5">
          <KeyBadge status={r.key_status} />
          <ChevronDown className={cn('size-4 shrink-0 opacity-60 transition-transform', open && 'rotate-180')} aria-hidden />
        </span>
      </button>

      <div className="space-y-1.5 px-3 py-2.5">
        {busy ? (
          <div>
            <div className="flex items-baseline justify-between gap-2">
              <span className="font-medium">{r.course_code}</span>
              <span className="text-[13px] text-ink-500">{fmtRange(r.start_time!, r.end_time!)}</span>
            </div>
            <div className="truncate text-[13px] text-ink-600">{r.instructor_name ?? 'No instructor'}</div>
          </div>
        ) : (
          // a "No class" verdict already says it
          !info && <div className="text-ink-400">No class</div>
        )}

        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {info ? (
            <Badge tone={info.tone} dot>
              {info.label}
            </Badge>
          ) : (
            r.discrepancy && (
              <Badge tone="bad" dot>
                {DISCREPANCY_LABEL[r.discrepancy]}
              </Badge>
            )
          )}
          {r.is_occupied !== null && <span className="text-[13px] text-ink-500">{peopleText(r.person_count, r.is_occupied)}</span>}
          {r.is_occupied === null && !info && !r.discrepancy && <span className="text-[13px] text-ink-400">No camera reading</span>}
        </div>
      </div>

      {open && (
        <div id={detailId} className="space-y-2 border-t border-ink-100 bg-ink-50/60 px-3 py-2.5 text-[13px]">
          {info && <p className="text-ink-700">{info.why}</p>}
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-ink-600">
            <dt className="text-ink-500">Room</dt>
            <dd>
              {r.room_name}, {r.building_name}, floor {r.floor}
            </dd>
            {busy && r.section_code && (
              <>
                <dt className="text-ink-500">Class</dt>
                <dd>{r.section_code}</dd>
              </>
            )}
            {r.occupancy_at && (
              <>
                <dt className="text-ink-500">Camera</dt>
                <dd>last reported {fmtRelative(r.occupancy_at, now)}</dd>
              </>
            )}
          </dl>
          <div className="flex flex-wrap gap-x-4 gap-y-1 pt-0.5">
            <Link to="/lockers" className="font-medium text-ink-800 underline decoration-ink-300 underline-offset-2 hover:decoration-ink-700">
              Open lockers and keys
            </Link>
            <Link to="/cameras" className="font-medium text-ink-800 underline decoration-ink-300 underline-offset-2 hover:decoration-ink-700">
              Open cameras
            </Link>
          </div>
        </div>
      )}
    </li>
  )
}

/** The rooms as a board of key tags: the state of every room readable at a glance, a tap away from the reason. */
export function RoomBoard({ rooms, now }: { rooms: RoomStatus[]; now: number }) {
  return (
    <ul className="grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] items-start gap-3 p-4" aria-label="Rooms">
      {rooms.map((r) => (
        <RoomTile key={r.room_id} r={r} now={now} />
      ))}
    </ul>
  )
}

/** The rooms drawn as the buildings they are in. The same tiles as the board, so a tap opens the same reasons. */
export function RoomFloors({ rooms, now }: { rooms: RoomStatus[]; now: number }) {
  return <Elevation items={rooms} building={(r) => r.building_name} floor={(r) => r.floor} render={(r) => <RoomTile key={r.room_id} r={r} now={now} />} />
}
