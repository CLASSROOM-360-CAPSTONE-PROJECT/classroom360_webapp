import { useCallback, useState } from 'react'
import { useAuth } from '@/auth/AuthProvider'
import { ImportFileDialog, plural } from '@/components/ImportFileDialog'
import { Badge, inputCls } from '@/components/ui'
import { unwrap } from '@/lib/api'
import { facilityLabel } from '@/lib/format'
import { parseRooms, type RoomRow } from '@/lib/import/rooms'
import { roomsTemplateCsv } from '@/lib/import/template'
import { supabase } from '@/lib/supabase'
import type { Building } from '@/lib/types'

/** Add many rooms at once from a CSV or Excel file. Rooms already in the system are left out, never changed. */
export function ImportRoomsDialog({
  open,
  onClose,
  onImported,
  buildings,
  existingCodes,
}: {
  open: boolean
  onClose: () => void
  onImported: (text: string) => void
  buildings: Building[]
  existingCodes: string[]
}) {
  const { profile } = useAuth()
  const [chosen, setChosen] = useState('')
  // with a single building there is nothing to choose
  const defaultBuildingId = chosen && buildings.some((b) => b.id === chosen) ? chosen : buildings.length === 1 ? buildings[0]!.id : null

  const parse = useCallback(
    (table: unknown[][]) => parseRooms(table, { buildings, existingCodes, defaultBuildingId }),
    [buildings, existingCodes, defaultBuildingId],
  )

  return (
    <ImportFileDialog<RoomRow>
      open={open}
      onClose={onClose}
      onImported={onImported}
      title="Import rooms"
      fileLabel="Rooms file"
      noun={['room', 'rooms']}
      template={{ filename: 'rooms-template.csv', text: roomsTemplateCsv() }}
      blockedReason={buildings.length === 0 ? 'There is no building yet, so rooms cannot be added. Use Add building first.' : null}
      intro={
        <>
          Upload a CSV or Excel file with one line per room: its code, the number of seats, and optionally its building, floor, name and room types. You see what would be added
          before anything is saved. Rooms that are already in the system are left out, not changed.
        </>
      }
      options={
        buildings.length > 1 ? (
          <label className="block max-w-sm">
            <span className="mb-1 block text-[13px] font-medium text-ink-700">Building for lines that do not name one</span>
            <select value={defaultBuildingId ?? ''} onChange={(e) => setChosen(e.target.value)} className={inputCls} aria-label="Building for lines that do not name one">
              <option value="">None: every line must name its building</option>
              {buildings.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.code}: {b.name}
                </option>
              ))}
            </select>
          </label>
        ) : null
      }
      help={
        <>
          <p>Column titles can be worded in your own way (for example “Capacity” for Seats, “Bldg” for Building). The first sheet of an Excel file is used.</p>
          <ul className="list-disc space-y-1 pl-5">
            <li><strong>Required:</strong> Room code (such as LRC-305) and Seats (a whole number from 1 to 2000).</li>
            <li>
              <strong>Building:</strong> the building’s code or name, as it is on this page. Add a building first if it is new. A line with no building goes in the building chosen above
              {buildings.length === 1 ? ` (${buildings[0]!.code}, the only one)` : ''}.
            </li>
            <li><strong>Floor:</strong> a whole number such as 3 (or “3rd floor”, “3F”). Ground floor counts as 1. Without it, floor 1 is used.</li>
            <li><strong>Name:</strong> without it, the room code is used as the name.</li>
            <li><strong>Room types:</strong> for rooms with something special, such as “Chemistry Laboratory” or “Computer Laboratory; Electronics Laboratory”. Leave it blank for an ordinary classroom.</li>
            <li><strong>In service:</strong> Yes or No. Without it, every room is in service.</li>
          </ul>
        </>
      }
      parse={parse}
      columns={[
        {
          head: 'Room',
          cell: (r) => (
            <>
              <div className="font-medium">{r.code}</div>
              <div className="text-[13px] text-ink-500">{r.name}</div>
            </>
          ),
        },
        { head: 'Building', cell: (r) => r.building.code },
        { head: 'Floor', cell: (r) => r.floor },
        { head: 'Seats', cell: (r) => r.capacity },
        {
          head: 'Room types',
          cell: (r) =>
            r.facilities.length === 0 ? (
              <span className="text-ink-400">Standard</span>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {r.facilities.map((f) => (
                  <Badge key={f}>{facilityLabel(f)}</Badge>
                ))}
              </div>
            ),
        },
        { head: 'Status', cell: (r) => (r.is_active ? <Badge tone="good">In service</Badge> : <Badge>Out of service</Badge>) },
      ]}
      summary={(rows, skipped) => [
        ['Rooms to add', String(rows.length)],
        ['Already in the system', String(skipped)],
        ['Seats in all', String(rows.reduce((n, r) => n + r.capacity, 0))],
        ['With a special room type', String(rows.filter((r) => r.facilities.length > 0).length)],
      ]}
      apply={async (rows, fileName) => {
        // one insert, so either every room is added or none is
        await unwrap(
          supabase.from('rooms').insert(
            rows.map((r) => ({
              tenant_id: profile!.tenant_id,
              building_id: r.building.id,
              code: r.code,
              name: r.name,
              floor: r.floor,
              capacity: r.capacity,
              facilities: r.facilities,
              is_active: r.is_active,
            })),
          ),
        )
        return `Imported ${fileName}: added ${plural(rows.length, 'room')}.`
      }}
    />
  )
}
