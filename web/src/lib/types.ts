import type { Role } from './roles'

export type ScheduleStatus = 'draft' | 'submitted' | 'approved' | 'published' | 'returned'
export type KeyStatus = 'available' | 'issued' | 'outstanding'

export interface Profile {
  id: string
  tenant_id: string
  role: Role
  full_name: string | null
  email: string | null
  department_id: string | null
  tenants: { name: string; timezone: string } | null
}

export interface Term {
  id: string
  name: string
  starts_on: string
  ends_on: string
  is_active: boolean
}

export interface Department {
  id: string
  code: string
  name: string
  is_active: boolean
}

export interface Program {
  id: string
  department_id: string
  code: string
  name: string
}

export interface Room {
  id: string
  code: string
  name: string
  floor: number
  capacity: number
  facilities: string[]
  is_active: boolean
  building_id: string
  buildings: { name: string } | null
}

export interface Building {
  id: string
  code: string
  name: string
}

export type EmploymentType = 'full_time' | 'part_time'

export interface WorkHourRow {
  day_of_week: number
  start_time: string
  end_time: string
}

export interface Instructor {
  id: string
  employee_no: string | null
  full_name: string
  email: string | null
  max_weekly_hours: number
  employment_type: EmploymentType
  is_active: boolean
  profile_id: string | null
  department_id: string | null
  departments: { code: string } | null
  rfid_cards: { is_active: boolean }[] | null
  instructor_work_hours: WorkHourRow[] | null
}

export interface SchoolHour {
  day_of_week: number
  opens_at: string
  closes_at: string
}

export interface Course {
  id: string
  code: string
  title: string
  units: number
  lecture_units: number
  lab_units: number
  required_facility: string | null
  department_id: string | null
  departments: { code: string } | null
}

export interface SectionRow {
  id: string
  code: string
  component: 'lecture' | 'lab'
  course_id: string
  program_id: string
  instructor_id: string | null
  year_level: number | null
  cohort: string | null
  enrollment: number
  meetings_per_week: number
  minutes_per_meeting: number
  courses: { code: string; title: string } | null
  programs: { code: string } | null
  instructors: { full_name: string } | null
  schedule_entries: { status: ScheduleStatus }[]
}

export interface ScheduleEntryRow {
  id: string
  term_id: string
  section_id: string
  program_id: string | null
  instructor_id: string | null
  cohort_key: string | null
  room_id: string
  day_of_week: number
  start_time: string
  end_time: string
  status: ScheduleStatus
  /** a dean or administrator moved this locked meeting with a justification */
  is_override?: boolean
  /** a chair pinned this draft meeting: generating again keeps it where it is */
  is_pinned?: boolean
  sections: { code: string; courses: { code: string; title: string } | null } | null
  instructors: { full_name: string } | null
  rooms: { code: string; name: string } | null
}

/** One row of schedule_overrides(): a locked meeting that was moved, and why. */
export interface OverrideRow {
  entry_id: string
  program_id: string | null
  section_code: string
  course_code: string | null
  instructor_name: string | null
  actor_name: string | null
  justification: string
  created_at: string
  from_room: string | null
  from_day: number
  from_start: string
  from_end: string
  to_room: string | null
  to_day: number
  to_start: string
  to_end: string
}

export interface RoomStatus {
  room_id: string
  room_code: string
  room_name: string
  building_name: string
  floor: number
  schedule_entry_id: string | null
  start_time: string | null
  end_time: string | null
  instructor_name: string | null
  course_code: string | null
  section_code: string | null
  key_status: KeyStatus | null
  is_occupied: boolean | null
  occupancy_at: string | null
  discrepancy: 'scheduled_but_empty' | 'occupied_not_scheduled' | null
  room_request_id: string | null
  /** people the camera counted in its latest report (null when it has not reported lately, or for a role that may not see it) */
  person_count?: number | null
  /** the timetable, the key and the camera taken together (see room_status_now) */
  presence?:
    | 'no_class'
    | 'occupied_unscheduled'
    | 'teacher_present'
    | 'key_out_room_empty'
    | 'key_out_unchecked'
    | 'key_with_other'
    | 'people_key_in_locker'
    | 'not_started'
    | 'teacher_absent'
    | 'camera_only_present'
    | 'camera_only_empty'
    | 'unchecked'
    | null
}

/** A classroom camera: its picture is served by the parent Raspberry Pi. */
export interface CameraRow {
  id: string
  room_id: string
  label: string
  gateway_url: string
  stream_path: string
  is_active: boolean
  rooms: { code: string; name: string } | null
}

export interface LockerStatusRow {
  locker_id: string
  room_id: string
  room_code: string
  room_name: string
  compartment_no: number
  station_label: string
  holder_name: string | null
  issued_at: string | null
  key_status: KeyStatus
}

export interface AccessLogRow {
  id: string
  occurred_at: string
  decision: 'granted' | 'denied'
  reason: string
  card_uid_presented: string
  instructors: { full_name: string } | null
  lockers: { compartment_no: number; rooms: { code: string } | null } | null
}

export interface AuditRow {
  id: number
  created_at: string
  action: string
  table_name: string
  record_id: string | null
  justification: string | null
  old_data?: Record<string, unknown> | null
  new_data: Record<string, unknown> | null
  profiles: { full_name: string | null; email: string | null } | null
}

export interface ProfileRow {
  id: string
  full_name: string | null
  email: string | null
  role: Role
  department_id: string | null
  created_at: string
}

/** One existing booking as other departments' planners may see it (no course or instructor names). */
export interface BusyRow {
  entry_id: string
  room_id: string
  instructor_id: string | null
  cohort_key: string | null
  department_id: string | null
  department_code: string | null
  day_of_week: number
  start_time: string
  end_time: string
  status: ScheduleStatus
}

/** The dean's latest decision on a program's schedule (schedule_review_note). */
export interface ReviewNote {
  action: 'SCHEDULE_RETURNED' | 'SCHEDULE_APPROVED' | 'SCHEDULE_PUBLISHED' | 'SCHEDULE_DRAFT'
  note: string | null
  actor_name: string | null
  created_at: string
}

export type RequestStatus = 'pending' | 'approved' | 'rejected' | 'cancelled'

export interface RoomRequestRow {
  id: string
  instructor_id: string
  room_id: string
  requested_for: string
  start_time: string
  end_time: string
  reason: string
  status: RequestStatus
  decided_at: string | null
  decision_note: string | null
  created_at: string
  instructors: { full_name: string } | null
  rooms: { code: string; name: string } | null
}

export interface FreeRoom {
  room_id: string
  code: string
  name: string
  floor: number
  capacity: number
}

export interface RoomOption {
  id: string
  code: string
  name: string
  floor: number
  capacity: number
}

/* ---------- step 8: evaluation, alerts, station health ---------- */

/** One row of test_trials: a controlled trial of the card checker, the key switch or the camera. */
export interface TestTrialRow {
  id: string
  subsystem: 'rfid' | 'key_return' | 'cctv'
  seq: number
  condition: string
  input_presented: string
  expected_positive: boolean
  actual_positive: boolean
  result: 'TP' | 'FP' | 'TN' | 'FN'
  latency_ms: number | null
  access_log_id: string | null
  observer: string
  notes: string
  occurred_at: string
}

/** One row of solve_jobs written by record_solve_run (kind = 'run'). */
export interface SolveRunRow {
  id: string
  status: 'queued' | 'running' | 'feasible' | 'infeasible' | 'error'
  runtime_ms: number | null
  hard_violations: number | null
  soft_penalty: number | null
  message: string | null
  created_at: string
  program_id: string | null
}

/** One row of ops_alerts(). The wording is made by lib/alerts.ts. */
export interface OpsAlert {
  kind: 'key_not_returned' | 'room_attention' | 'denied_attempts' | 'station_offline'
  severity: 'high' | 'medium' | 'low'
  code: string | null
  room_code: string | null
  subject: string | null
  occurred_at: string | null
  attempts: number
  ref: string
}

/** One row of the station_status view. */
export interface StationStatusRow {
  station_label: string
  doors: number
  first_seen_at: string | null
  last_seen_at: string | null
  info: Record<string, unknown> | null
  online: boolean
}

/* ---------- step 9: notifications and automatic trial capture ---------- */

/** One line of a person's inbox (public.notifications). The database writes them; a person only reads and marks them read. */
export interface NotificationRow {
  id: string
  kind: string
  severity: 'high' | 'medium' | 'info'
  title: string
  body: string
  /** a page of the web app, such as "/requests" */
  link: string | null
  ref: string
  created_at: string
  read_at: string | null
}

/** One thing the system did that can be turned into a trial (trial_candidates). The system's answer comes from the log. */
export interface TrialCandidate {
  subsystem: 'rfid' | 'key_return' | 'cctv'
  source_id: string
  occurred_at: string
  room_code: string | null
  door: number | null
  system_says: boolean
  subject: string | null
  reason: string | null
  people: number | null
  latency_ms: number | null
}
