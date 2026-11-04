import { Pencil } from 'lucide-react'
import { Elevation } from '@/components/Elevation'
import { KeyTag } from '@/components/KeyTag'
import { Badge } from '@/components/ui'
import { cn } from '@/lib/cn'
import { facilityLabel } from '@/lib/format'
import type { Room } from '@/lib/types'

/**
 * The room inventory as a plan of the buildings: a tile for each room on its floor, with the number of seats drawn as a bar
 * (longest bar = the largest room), the room types, and a dashed edge for a room that is out of service.
 * With `onPick` a tile opens the room for editing.
 */
export function RoomPlan({ rooms, onPick }: { rooms: Room[]; onPick?: (r: Room) => void }) {
  const biggest = Math.max(1, ...rooms.map((r) => r.capacity))
  return (
    <Elevation
      items={rooms}
      building={(r) => r.buildings?.name ?? 'No building'}
      floor={(r) => r.floor}
      tileMin={200}
      render={(r) => {
        const body = (
          <>
            <span className="flex w-full items-center justify-between gap-2">
              <KeyTag code={r.code} tone={r.is_active ? 'ink' : 'ink'} className={r.is_active ? undefined : 'opacity-60'} />
              {onPick && <Pencil className="size-3.5 shrink-0 text-ink-300 transition-colors group-hover:text-ink-700" aria-hidden />}
            </span>
            <span className="mt-1.5 block w-full truncate text-[13.5px] text-ink-700">{r.name}</span>
            <span className="mt-2 flex w-full items-center gap-2 text-[13px] text-ink-600">
              <span className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-ink-100" aria-hidden>
                <span className={cn('absolute inset-y-0 left-0 rounded-full', r.is_active ? 'bg-brass-400' : 'bg-ink-300')} style={{ width: `${Math.round((r.capacity / biggest) * 100)}%` }} />
              </span>
              <span className="shrink-0 tabular-nums">{r.capacity} seats</span>
            </span>
            {(r.facilities.length > 0 || !r.is_active) && (
              <span className="mt-2 flex w-full flex-wrap gap-1.5">
                {!r.is_active && <Badge>Out of service</Badge>}
                {r.facilities.map((f) => (
                  <Badge key={f}>{facilityLabel(f)}</Badge>
                ))}
              </span>
            )}
          </>
        )
        const tile = cn(
          'group block w-full rounded-md border p-3 text-left transition-shadow',
          r.is_active ? 'border-ink-200 bg-white' : 'border-dashed border-ink-300 bg-ink-50 text-ink-500',
        )
        return (
          <li key={r.id}>
            {onPick ? (
              <button type="button" onClick={() => onPick(r)} aria-label={`Edit room ${r.code}`} className={cn(tile, 'hover:shadow-[0_2px_10px_rgb(11_21_36/0.08)]')}>
                {body}
              </button>
            ) : (
              <div className={tile}>{body}</div>
            )}
          </li>
        )
      }}
    />
  )
}
