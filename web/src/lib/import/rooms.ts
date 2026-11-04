/**
 * Reads a list of rooms (CSV or Excel, already turned into a table of cells) into rows ready to insert.
 *
 * Nothing here talks to the database. The caller says which buildings exist, which room codes are taken and
 * which building to use when the file does not name one, and gets back the rooms to add plus everything worth
 * telling the person. The same checks the Add room form makes are made here: a code, whole-number seats from
 * 1 to 2000 and a whole-number floor.
 */
import { normFacilities } from '../facilities.ts'
import { Grouped, lineList, locateColumns, MAX_ROWS, normTitle } from './columns.ts'
import { cellText, toNumber, type Issue } from './teachingLoad.ts'

export interface BuildingRef {
  id: string
  code: string
  name: string
}

export interface RoomContext {
  buildings: BuildingRef[]
  /** codes of the rooms that are already in the system */
  existingCodes: string[]
  /** the building for lines that do not name one; null when none is chosen */
  defaultBuildingId: string | null
}

export interface RoomRow {
  /** the line in the file (1 = the first line) */
  row: number
  code: string
  name: string
  building: BuildingRef
  floor: number
  capacity: number
  facilities: string[]
  is_active: boolean
}

export interface ParsedRooms {
  rows: RoomRow[]
  issues: Issue[]
  /** lines left out because the room is already in the system */
  skipped: number
}

type Field = 'code' | 'name' | 'building' | 'floor' | 'seats' | 'types' | 'active'

const ALIASES: Record<Field, string[]> = {
  code: ['room code', 'room', 'room no', 'room number', 'code', 'room id', 'id', 'room label'],
  name: ['name', 'room name', 'description', 'room title', 'title', 'label'],
  building: ['building', 'building code', 'building name', 'bldg', 'bldg code', 'bldg name', 'hall', 'location'],
  floor: ['floor', 'floor level', 'floor no', 'floor number', 'level', 'storey', 'story'],
  seats: ['seats', 'capacity', 'seating capacity', 'no of seats', 'number of seats', 'seat capacity', 'room capacity', 'max students', 'maximum capacity', 'size', 'seating', 'pax'],
  types: ['room types', 'room type', 'type', 'types', 'facilities', 'facility', 'features', 'equipment', 'room features', 'special features', 'kind', 'kind of room'],
  active: ['in service', 'active', 'status', 'is active', 'available', 'in use', 'usable', 'room status', 'availability'],
}

/** what the "room type" cell says when it means an ordinary classroom */
const STANDARD = /^(none|no|n a|na|standard|regular|regular room|regular classroom|lecture|lecture room|classroom|general|general purpose|ordinary|tba|tbd|null|nil)$/

const MAX_CODE = 30
const MAX_NAME = 80

/** "3", "3rd", "3rd floor", "3F", "3/F", "Ground", "B1" to a floor number */
export function parseFloor(text: string): number | null {
  const t = text.trim().toLowerCase().replace(/\s+/g, ' ')
  if (!t) return null
  if (/^(g|gf|g\/f|ground|ground floor|groundfloor)$/.test(t)) return 1
  if (/^(b|basement|lower ground|lg)$/.test(t)) return -1
  const b = /^b(\d)$/.exec(t)
  if (b) return -Number(b[1])
  const m = /^(-?\d{1,3})(?:st|nd|rd|th)?\s*(?:f|fl|flr|floor|\/f)?$/.exec(t)
  return m ? Number(m[1]) : null
}

/** "40", "40 seats", "40 pax" to a number of seats */
export function parseSeats(text: string): number | null {
  const m = /^(\d{1,5})(?:\s*(?:seats?|pax|persons?|people|students?))?$/i.exec(text.trim())
  if (m) return Number(m[1])
  const n = toNumber(text)
  return n !== null && Number.isInteger(n) ? n : null
}

/** "yes", "active", "in service" and the like; null when the text is not recognised */
export function parseActive(text: string): boolean | null {
  const t = normTitle(text)
  if (/^(yes|y|true|1|active|in service|open|available|usable|ok|operational|in use)$/.test(t)) return true
  if (/^(no|n|false|0|inactive|out of service|closed|unavailable|not available|under repair|under maintenance|maintenance|disabled|not in service|out)$/.test(t)) return false
  return null
}

/** "Computer Laboratory, Electronics Lab" to the clean list the database keeps (computer_lab, electronics_lab) */
export function parseRoomTypes(text: string): string[] {
  // "N/A" would otherwise be cut in two at the slash
  if (STANDARD.test(normTitle(text))) return []
  const parts = text
    .split(/[,;|/\n]+/)
    .map((p) => p.trim())
    .filter((p) => p && !STANDARD.test(normTitle(p)))
  return normFacilities(parts)
}

export function parseRooms(table: unknown[][], ctx: RoomContext): ParsedRooms {
  const issues: Issue[] = []
  const located = locateColumns<Field>(table, ALIASES, 2)
  const fail = (message: string): ParsedRooms => ({ rows: [], issues: [...issues, { row: 0, level: 'error', message }], skipped: 0 })
  if (!located) {
    return fail('Could not find the column titles. The first lines of the file should include titles such as Room code and Seats. Download the template to see an example.')
  }
  const { headerIdx, col, ignored } = located

  const missing: string[] = []
  if (!col.has('code')) missing.push('Room code')
  if (!col.has('seats')) missing.push('Seats (or Capacity)')
  if (missing.length > 0) return fail(`The file has no column for: ${missing.join('; ')}.`)
  if (ignored.length > 0) issues.push({ row: 0, level: 'info', message: `Ignored columns: ${ignored.join(', ')}.` })

  const body = table.slice(headerIdx + 1).filter((line) => (line ?? []).some((c) => cellText(c) !== ''))
  if (body.length === 0) return fail('The file has titles but no lines of data under them.')
  if (body.length > MAX_ROWS) return fail(`The file has ${body.length} rooms. Import at most ${MAX_ROWS} at a time.`)

  // ---- which building each line belongs to
  const byKey = new Map<string, BuildingRef>()
  for (const b of ctx.buildings) {
    byKey.set(normTitle(b.code), b)
    byKey.set(normTitle(b.name), b)
  }
  const fallback = ctx.buildings.find((b) => b.id === ctx.defaultBuildingId) ?? null
  const hasBuildingColumn = col.has('building')
  if (!hasBuildingColumn && !fallback) {
    return fail('The file does not say which building the rooms are in. Choose a building above, or add a Building column.')
  }

  const existing = new Set(ctx.existingCodes.map((c) => c.trim().toLowerCase()))
  const seen = new Map<string, number>()
  const grouped = new Grouped()
  const rows: RoomRow[] = []
  const skippedCodes: string[] = []
  const skippedLines: number[] = []
  const get = (line: unknown[], f: Field) => (col.has(f) ? cellText(line[col.get(f)!]) : '')

  if (!col.has('floor')) issues.push({ row: 0, level: 'info', message: 'The file has no Floor column, so every room is put on floor 1. Edit a room later to change its floor.' })
  const buildingList = ctx.buildings.map((b) => b.code).join(', ')

  for (let i = headerIdx + 1; i < table.length; i++) {
    const line = table[i] ?? []
    if (line.every((c) => cellText(c) === '')) continue
    const row = i + 1
    const bad = (message: string) => issues.push({ row, level: 'error', message })
    let ok = true

    // ---- code
    const code = get(line, 'code').replace(/\s+/g, ' ')
    if (!code) {
      bad('The room code is missing.')
      continue
    }
    if (code.length > MAX_CODE) {
      bad(`The room code "${code}" is longer than ${MAX_CODE} characters.`)
      continue
    }
    const key = code.toLowerCase()
    if (seen.has(key)) {
      bad(`Room ${code} is already on line ${seen.get(key)} of this file.`)
      continue
    }
    seen.set(key, row)
    if (existing.has(key)) {
      skippedCodes.push(code)
      skippedLines.push(row)
      continue
    }

    // ---- seats
    const seatsText = get(line, 'seats')
    const seats = parseSeats(seatsText)
    if (!seatsText) {
      bad(`${code}: the number of seats is missing.`)
      ok = false
    } else if (seats === null || seats < 1 || seats > 2000) {
      bad(`${code}: "${seatsText}" is not a number of seats (a whole number from 1 to 2000).`)
      ok = false
    }

    // ---- floor
    let floor = 1
    const floorText = get(line, 'floor')
    if (floorText) {
      const f = parseFloor(floorText)
      if (f === null || f < -5 || f > 100) {
        bad(`${code}: "${floorText}" is not a floor (a whole number such as 3).`)
        ok = false
      } else floor = f
    } else if (col.has('floor')) {
      grouped.add('nofloor', 'info', row, (r) => `${r.length} ${r.length === 1 ? 'room has' : 'rooms have'} no floor, so floor 1 is used (${lineList(r)}).`)
    }

    // ---- building
    let building: BuildingRef | null = fallback
    const bText = get(line, 'building')
    if (bText) {
      building = byKey.get(normTitle(bText)) ?? null
      if (!building) {
        bad(`${code}: the building "${bText}" is not in the system. The buildings are: ${buildingList || 'none yet'}. Add it with Add building first, or correct the name.`)
        ok = false
      }
    } else if (!fallback) {
      bad(`${code}: the building is missing. Fill it in, or choose a building above for the lines that have none.`)
      ok = false
    }

    // ---- name, types, in service
    let name = get(line, 'name')
    if (!name) {
      name = code
      grouped.add('noname', 'info', row, (r) => `${r.length} ${r.length === 1 ? 'room has' : 'rooms have'} no name, so the room code is used as the name (${lineList(r)}).`)
    }
    if (name.length > MAX_NAME) name = name.slice(0, MAX_NAME)
    const facilities = parseRoomTypes(get(line, 'types'))
    let active = true
    const activeText = get(line, 'active')
    if (activeText) {
      const a = parseActive(activeText)
      if (a === null) {
        bad(`${code}: "${activeText}" is not a status. Use Yes or No for whether the room is in service.`)
        ok = false
      } else active = a
    }

    if (!ok || !building) continue
    rows.push({ row, code, name, building, floor, capacity: seats!, facilities, is_active: active })
  }

  if (skippedCodes.length > 0) {
    const shown = skippedCodes.slice(0, 8).join(', ') + (skippedCodes.length > 8 ? `, and ${skippedCodes.length - 8} more` : '')
    issues.push({
      row: 0,
      level: 'warning',
      message: `${skippedCodes.length} ${skippedCodes.length === 1 ? 'room is' : 'rooms are'} already in the system and ${skippedCodes.length === 1 ? 'was' : 'were'} left out: ${shown}. Existing rooms are not changed by an import; use Edit on the Rooms page to change one.`,
    })
  }
  issues.push(...grouped.issues())
  if (rows.length === 0 && skippedCodes.length === 0 && !issues.some((x) => x.level === 'error')) {
    issues.push({ row: 0, level: 'error', message: 'There is no room to add in this file.' })
  }
  return { rows, issues, skipped: skippedCodes.length }
}
