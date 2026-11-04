import {
  BookOpen,
  Building2,
  CalendarDays,
  DoorOpen,
  FileDown,
  FlaskConical,
  GraduationCap,
  HandHelping,
  KeyRound,
  Clock,
  LayoutDashboard,
  Printer,
  ScrollText,
  UserCog,
  Video,
  type LucideIcon,
} from 'lucide-react'
import { OPS_ROLES, PLANNER_ROLES, ROLES, type Role } from '@/lib/roles'

export interface NavItem {
  to: string
  label: string
  /** Different wording for particular roles. */
  labels?: Partial<Record<Role, string>>
  /** Show the number of requests waiting for a decision. */
  pendingBadge?: boolean
  icon: LucideIcon
  roles: Role[]
  group: number
}

// Each role sees only the pages it can use (wireframe, Figure 2.5).
export const NAV: NavItem[] = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, roles: ROLES, group: 0 },
  { to: '/schedules', label: 'Schedules', icon: CalendarDays, roles: ROLES, group: 0 },
  { to: '/timetables', label: 'Timetables', labels: { instructor: 'My timetable' }, icon: Printer, roles: ROLES, group: 0 },
  {
    to: '/requests',
    label: 'Room requests',
    labels: { instructor: 'Request a room' },
    icon: HandHelping,
    roles: ['admin', 'dean', 'instructor'],
    group: 0,
    pendingBadge: true,
  },
  { to: '/rooms', label: 'Rooms', icon: DoorOpen, roles: PLANNER_ROLES, group: 1 },
  { to: '/instructors', label: 'Instructors', icon: GraduationCap, roles: PLANNER_ROLES, group: 1 },
  { to: '/courses', label: 'Courses and classes', icon: BookOpen, roles: PLANNER_ROLES, group: 1 },
  { to: '/lockers', label: 'Lockers and keys', icon: KeyRound, roles: OPS_ROLES, group: 2 },
  { to: '/cameras', label: 'Cameras', icon: Video, roles: OPS_ROLES, group: 2 },
  { to: '/reports', label: 'Reports', icon: FileDown, roles: OPS_ROLES, group: 2 },
  { to: '/audit', label: 'Audit log', icon: ScrollText, roles: OPS_ROLES, group: 2 },
  { to: '/departments', label: 'Departments', icon: Building2, roles: ['admin'], group: 3 },
  { to: '/school-hours', label: 'School hours', icon: Clock, roles: ['admin'], group: 3 },
  { to: '/evaluation', label: 'Evaluation', icon: FlaskConical, roles: ['admin'], group: 3 },
  { to: '/users', label: 'Users', icon: UserCog, roles: ['admin'], group: 3 },
]

/** The pages a role can open, in menu order. */
export const navFor = (role: Role | null | undefined): NavItem[] => (role ? NAV.filter((n) => n.roles.includes(role)) : [])

/** The page's name as this role sees it ("My timetable" for an instructor). */
export const navLabel = (item: NavItem, role: Role | null | undefined): string => (role && item.labels?.[role]) || item.label

/** Extra words that find a page in the Jump to window. */
export const NAV_KEYWORDS: Record<string, string> = {
  '/': 'home overview today keys alerts',
  '/schedules': 'calendar weekly generate timetable classes plan',
  '/timetables': 'print pdf csv download week',
  '/requests': 'room request approve reject borrow',
  '/rooms': 'classroom building seats capacity laboratory',
  '/instructors': 'teachers faculty staff load hours',
  '/courses': 'subjects classes sections catalog units',
  '/lockers': 'keys locker door cabinet rfid card',
  '/cameras': 'live video people count presence',
  '/reports': 'usage export csv utilisation',
  '/audit': 'history log changes who',
  '/departments': 'college program',
  '/school-hours': 'opening closing time days',
  '/evaluation': 'trials accuracy precision recall f1 chapter',
  '/users': 'accounts roles people sign in',
}
