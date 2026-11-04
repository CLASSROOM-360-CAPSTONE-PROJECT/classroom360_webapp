/**
 * Printable timetables. Pure functions: schedule rows in, groups, sheet layouts and CSV text out, so they can be
 * tested without a browser. The page (pages/Timetables.tsx) only draws what this works out.
 *
 * Three ways to cut the same meetings, each one a sheet per subject:
 *   block       a student block (program, year, cohort): "what do these students attend"
 *   instructor  one teacher: "where am I teaching" (with the weekly hours)
 *   room        one room: "who is in here, and when"
 */
import { toCsv, type CsvCell } from './csv.ts'
import { STATUS_LABEL } from './format.ts'
import { fmtTime, toMinutes } from './time.ts'

export type TimetableView = 'block' | 'instructor' | 'room'
export type MeetingStatus = 'draft' | 'submitted' | 'approved' | 'published' | 'returned'

export const DAY_LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
export const DAY_ABBR = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

export const VIEW_LABEL: Record<TimetableView, string> = {
  block: 'Student block',
  instructor: 'Instructor',
  room: 'Room',
}

/** A schedule_entries row as the Timetables page selects it. */
export interface TimetableRow {
  id: string
  program_id: string | null
  instructor_id: string | null
  room_id: string
  day_of_week: number
  start_time: string
  end_time: string
  status: MeetingStatus
  sections: {
    code: string
    component: 'lecture' | 'lab' | null
    year_level: number | null
    cohort: string | null
    program_id: string
    courses: { code: string; title: string } | null
    programs: { code: string } | null
  } | null
  instructors: { full_name: string } | null
  rooms: { code: string; name: string } | null
}

/** One weekly meeting, with every name worked out once. */
export interface Meeting {
  id: string
  day: number
  start: string
  end: string
  startMin: number
  endMin: number
  status: MeetingStatus
  programId: string | null
  courseCode: string
  courseTitle: string
  sectionCode: string
  component: 'lecture' | 'lab' | null
  blockKey: string
  block: string
  instructorId: string | null
  instructor: string
  roomId: string
  room: string
  roomName: string
}

export const NO_INSTRUCTOR = 'No instructor assigned'

/** "BSCPE 4A", "BSCPE Year 3", or just the program when the class has no block set. */
export function blockLabel(program: string | null | undefined, year: number | null | undefined, cohort: string | null | undefined): string {
  const p = (program ?? '').trim()
  const c = (cohort ?? '').trim()
  let tail = ''
  if (c) tail = /^\d/.test(c) || year == null ? c : `${year}${c}`
  else if (year != null) tail = `Year ${year}`
  return [p, tail].filter(Boolean).join(' ') || 'No student block'
}

export function toMeeting(r: TimetableRow): Meeting {
  const s = r.sections
  const programId = s?.program_id ?? r.program_id
  return {
    id: r.id,
    day: r.day_of_week,
    start: r.start_time,
    end: r.end_time,
    startMin: toMinutes(r.start_time),
    endMin: toMinutes(r.end_time),
    status: r.status,
    programId,
    courseCode: s?.courses?.code ?? s?.code ?? 'Class',
    courseTitle: s?.courses?.title ?? '',
    sectionCode: s?.code ?? '',
    component: s?.component ?? null,
    // the same three things the database uses to keep one block from being in two rooms at once
    blockKey: `${programId ?? ''}:${s?.year_level ?? ''}:${(s?.cohort ?? '').trim()}`,
    block: blockLabel(s?.programs?.code, s?.year_level, s?.cohort),
    instructorId: r.instructor_id,
    instructor: r.instructors?.full_name ?? NO_INSTRUCTOR,
    roomId: r.room_id,
    room: r.rooms?.code ?? 'No room',
    roomName: r.rooms?.name ?? '',
  }
}

export interface MeetingFilter {
  /** 'published' = what the locker follows; 'all' = also drafts, meetings awaiting approval and rejected ones */
  include: 'published' | 'all'
  programId?: string | null
}

export function filterMeetings(meetings: readonly Meeting[], f: MeetingFilter): Meeting[] {
  return meetings.filter((m) => (f.include === 'all' || m.status === 'published') && (!f.programId || m.programId === f.programId))
}

const byName = (a: string, b: string) => a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' })

const lastWord = (full: string) => full.trim().split(/\s+/).pop() ?? full

/** Day, then start, then end, then course: the order a week is read in. */
export function byWeek(a: Meeting, b: Meeting): number {
  return a.day - b.day || a.startMin - b.startMin || a.endMin - b.endMin || byName(a.courseCode, b.courseCode) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

/** Hours in a week, to a quarter of an hour (1.5, 2.25 ...). */
export function hoursOf(meetings: readonly Meeting[]): number {
  const mins = meetings.reduce((n, m) => n + Math.max(0, m.endMin - m.startMin), 0)
  return Math.round(mins / 15) / 4
}

export interface Group {
  key: string
  /** the heading of the sheet: "BSCPE 4A", "Ana Reyes", "LRC-302" */
  label: string
  /** the line under it: the room's name, or the program of a block */
  sub: string
  meetings: Meeting[]
  hours: number
}

/** One group per block, instructor or room, in the order a person looks for them. */
export function groupMeetings(meetings: readonly Meeting[], view: TimetableView): Group[] {
  const map = new Map<string, Group>()
  for (const m of meetings) {
    const key = view === 'block' ? m.blockKey : view === 'instructor' ? (m.instructorId ?? 'none') : m.roomId
    let g = map.get(key)
    if (!g) {
      g = {
        key,
        label: view === 'block' ? m.block : view === 'instructor' ? m.instructor : m.room,
        sub: view === 'room' ? m.roomName : '',
        meetings: [],
        hours: 0,
      }
      map.set(key, g)
    }
    g.meetings.push(m)
  }
  const groups = [...map.values()]
  for (const g of groups) {
    g.meetings.sort(byWeek)
    g.hours = hoursOf(g.meetings)
  }
  const sortKey = (g: Group) => (view === 'instructor' && g.key !== 'none' ? `${lastWord(g.label)} ${g.label}` : g.label)
  groups.sort((a, b) => {
    // "No instructor assigned" goes last, not first
    if ((a.key === 'none') !== (b.key === 'none')) return a.key === 'none' ? 1 : -1
    return byName(sortKey(a), sortKey(b)) || (a.key < b.key ? -1 : 1)
  })
  return groups
}

/* ---------- the drawing ---------- */

export interface LaneItem<T> {
  item: T
  lane: number
  lanes: number
}

/** Side-by-side lanes for meetings that overlap in time within one day. */
export function layoutLanes<T extends { startMin: number; endMin: number }>(items: readonly T[]): LaneItem<T>[] {
  const sorted = [...items].sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin)
  const out: LaneItem<T>[] = []
  let cluster: LaneItem<T>[] = []
  let clusterEnd = -1
  let laneEnds: number[] = []
  const flush = () => {
    for (const c of cluster) c.lanes = laneEnds.length
    out.push(...cluster)
    cluster = []
    laneEnds = []
    clusterEnd = -1
  }
  for (const item of sorted) {
    if (cluster.length && item.startMin >= clusterEnd) flush()
    let lane = laneEnds.findIndex((end) => end <= item.startMin)
    if (lane === -1) {
      lane = laneEnds.length
      laneEnds.push(item.endMin)
    } else {
      laneEnds[lane] = item.endMin
    }
    cluster.push({ item, lane, lanes: 1 })
    clusterEnd = Math.max(clusterEnd, item.endMin)
  }
  if (cluster.length) flush()
  return out
}

export interface PlacedMeeting extends LaneItem<Meeting> {
  /** 0 to 100, from the top of the day column */
  topPct: number
  heightPct: number
}

export interface SheetColumn {
  day: number
  label: string
  blocks: PlacedMeeting[]
}

export interface Sheet {
  startHour: number
  endHour: number
  hours: number[]
  columns: SheetColumn[]
}

/**
 * The week of one group: Monday to Friday always, Saturday and Sunday only when something is on them, and only
 * the hours that are used (at least four, so a short day does not look squashed).
 */
export function buildSheet(meetings: readonly Meeting[]): Sheet {
  const lastDay = Math.min(7, Math.max(5, ...meetings.map((m) => m.day)))
  let startHour = meetings.length ? Math.floor(Math.min(...meetings.map((m) => m.startMin)) / 60) : 7
  let endHour = meetings.length ? Math.ceil(Math.max(...meetings.map((m) => m.endMin)) / 60) : 11
  if (endHour - startHour < 4) endHour = Math.min(24, startHour + 4)
  if (endHour - startHour < 4) startHour = Math.max(0, endHour - 4)
  const span = (endHour - startHour) * 60
  const columns: SheetColumn[] = []
  for (let day = 1; day <= lastDay; day++) {
    const placed = layoutLanes(meetings.filter((m) => m.day === day)).map(
      (p): PlacedMeeting => ({
        ...p,
        topPct: ((p.item.startMin - startHour * 60) / span) * 100,
        heightPct: ((p.item.endMin - p.item.startMin) / span) * 100,
      }),
    )
    columns.push({ day, label: DAY_ABBR[day - 1], blocks: placed })
  }
  return { startHour, endHour, hours: Array.from({ length: endHour - startHour }, (_, i) => startHour + i), columns }
}

/** "8:00 AM" style label for a whole hour on the time axis. */
export const hourLabel = (h: number) => fmtTime(`${String(h).padStart(2, '0')}:00:00`)

/** A small number for picking a pastel colour per course, the same every time. */
export function tintIndex(courseCode: string, n = 8): number {
  let h = 0
  for (let i = 0; i < courseCode.length; i++) h = (h * 31 + courseCode.charCodeAt(i)) >>> 0
  return h % n
}

/** What goes inside a meeting's box: the course, then the two things this view does not already say. */
export function cellText(m: Meeting, view: TimetableView): { title: string; lines: string[] } {
  const title = m.component === 'lab' ? `${m.courseCode} Lab` : m.courseCode
  const lines =
    view === 'block'
      ? [m.room, m.instructor === NO_INSTRUCTOR ? '' : m.instructor]
      : view === 'instructor'
        ? [m.block, m.room]
        : [m.block, m.instructor === NO_INSTRUCTOR ? '' : m.instructor]
  return { title, lines: lines.filter(Boolean) }
}

/** The full sentence for a tooltip or a screen reader. */
export function meetingLabel(m: Meeting): string {
  return [
    m.courseCode + (m.courseTitle ? `, ${m.courseTitle}` : ''),
    m.component === 'lab' ? 'laboratory' : m.component === 'lecture' ? 'lecture' : '',
    `${DAY_LONG[m.day - 1]} ${fmtTime(m.start)} to ${fmtTime(m.end)}`,
    `room ${m.room}`,
    m.instructor,
    m.block,
    STATUS_LABEL[m.status],
  ]
    .filter(Boolean)
    .join(', ')
}

/** "Mon 8:00 AM to 9:30 AM" */
export const whenText = (m: Meeting) => `${DAY_ABBR[m.day - 1]} ${fmtTime(m.start)} to ${fmtTime(m.end)}`

/* ---------- the list under the picture ---------- */

export interface LegendColumn {
  key: string
  header: string
}

export function legendColumns(view: TimetableView): LegendColumn[] {
  const when = { key: 'when', header: 'Day and time' }
  const course = { key: 'course', header: 'Course' }
  const title = { key: 'title', header: 'Title' }
  const type = { key: 'type', header: 'Type' }
  const room = { key: 'room', header: 'Room' }
  const block = { key: 'block', header: 'Student block' }
  const instructor = { key: 'instructor', header: 'Instructor' }
  if (view === 'block') return [when, course, title, type, room, instructor]
  if (view === 'instructor') return [when, course, title, type, block, room]
  return [when, course, title, type, block, instructor]
}

export function legendCell(m: Meeting, key: string): string {
  switch (key) {
    case 'when':
      return whenText(m)
    case 'course':
      return m.courseCode
    case 'title':
      return m.courseTitle
    case 'type':
      return m.component === 'lab' ? 'Laboratory' : m.component === 'lecture' ? 'Lecture' : ''
    case 'room':
      return m.room
    case 'block':
      return m.block
    case 'instructor':
      return m.instructor === NO_INSTRUCTOR ? '' : m.instructor
    default:
      return ''
  }
}

/* ---------- the file ---------- */

const hhmm = (t: string) => `${String(Math.floor(toMinutes(t) / 60)).padStart(2, '0')}:${String(toMinutes(t) % 60).padStart(2, '0')}`

/**
 * One row per meeting, for every group given, the subject of the view first. Times are 24-hour (08:00) so
 * Excel sorts and reads them as times. Starts with a byte order mark so Excel opens it as UTF-8.
 */
export function timetableCsv(groups: readonly Group[], view: TimetableView): string {
  const head: CsvCell[] = [VIEW_LABEL[view], 'Day', 'Start', 'End', 'Hours', 'Course', 'Title', 'Type', 'Section', 'Student block', 'Room', 'Instructor', 'Status']
  const rows: CsvCell[][] = [head]
  for (const g of groups) {
    for (const m of g.meetings) {
      rows.push([
        g.label,
        DAY_LONG[m.day - 1],
        hhmm(m.start),
        hhmm(m.end),
        Math.round(((m.endMin - m.startMin) / 60) * 100) / 100,
        m.courseCode,
        m.courseTitle,
        m.component === 'lab' ? 'Laboratory' : m.component === 'lecture' ? 'Lecture' : '',
        m.sectionCode,
        m.block,
        m.room,
        m.instructor === NO_INSTRUCTOR ? '' : m.instructor,
        STATUS_LABEL[m.status],
      ])
    }
  }
  return toCsv(rows, { bom: true })
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)

/** classroom360-timetable-block-1st-sem-2026-2027-bscpe-4a.csv */
export function timetableFilename(view: TimetableView, termName: string, subject: string | null, ext: 'csv'): string {
  return ['classroom360-timetable', view, slug(termName) || 'term', subject ? slug(subject) : 'all'].filter(Boolean).join('-') + `.${ext}`
}

/** True when every meeting is published, so the sheet can be called final. */
export const isFinal = (meetings: readonly Meeting[]) => meetings.length > 0 && meetings.every((m) => m.status === 'published')
