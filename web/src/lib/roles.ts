export type Role = 'admin' | 'dean' | 'program_chair' | 'instructor'

export const ROLES: Role[] = ['admin', 'dean', 'program_chair', 'instructor']

export const ROLE_LABEL: Record<Role, string> = {
  admin: 'Administrator',
  dean: 'Dean',
  program_chair: 'Program chair',
  instructor: 'Instructor',
}

/** Roles that see the live key, locker and camera picture of the whole campus. */
export const OPS_ROLES: Role[] = ['admin', 'dean']

/** Roles that manage the timetable inputs (rooms, instructors, courses). */
export const PLANNER_ROLES: Role[] = ['admin', 'dean', 'program_chair']

export const isOps = (role?: Role | null) => role === 'admin' || role === 'dean'
export const isApprover = isOps
