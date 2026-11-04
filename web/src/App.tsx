import type { ReactNode } from 'react'
import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { useAuth } from '@/auth/AuthProvider'
import { AppShell } from '@/components/AppShell'
import { isConfigured } from '@/lib/supabase'
import { OPS_ROLES, PLANNER_ROLES, type Role } from '@/lib/roles'
import AuditLog from '@/pages/AuditLog'
import Cameras from '@/pages/Cameras'
import Courses from '@/pages/Courses'
import Dashboard from '@/pages/Dashboard'
import Departments from '@/pages/Departments'
import Evaluation from '@/pages/Evaluation'
import Instructors from '@/pages/Instructors'
import Lockers from '@/pages/Lockers'
import Login from '@/pages/Login'
import Reports from '@/pages/Reports'
import Requests from '@/pages/Requests'
import Rooms from '@/pages/Rooms'
import Schedules from '@/pages/Schedules'
import SchoolHours from '@/pages/SchoolHours'
import { Forbidden, FullPageLoading, NotFound, NotProvisioned, SetupNotice } from '@/pages/Status'
import Timetables from '@/pages/Timetables'
import Users from '@/pages/Users'

function ProtectedLayout() {
  const { status } = useAuth()
  const location = useLocation()
  if (status === 'loading') return <FullPageLoading />
  if (status === 'signedOut') return <Navigate to="/login" replace state={{ from: location.pathname }} />
  if (status === 'noProfile') return <NotProvisioned />
  return <AppShell />
}

/** The database enforces access; this only keeps people from landing on pages that would be empty. */
function RoleGate({ roles, children }: { roles: Role[]; children: ReactNode }) {
  const { profile } = useAuth()
  if (!profile || !roles.includes(profile.role)) return <Forbidden />
  return <>{children}</>
}

export default function App() {
  if (!isConfigured) return <SetupNotice />

  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route element={<ProtectedLayout />}>
        <Route index element={<Dashboard />} />
        <Route path="schedules" element={<Schedules />} />
        <Route path="timetables" element={<Timetables />} />
        <Route path="rooms" element={<RoleGate roles={PLANNER_ROLES}><Rooms /></RoleGate>} />
        <Route path="instructors" element={<RoleGate roles={PLANNER_ROLES}><Instructors /></RoleGate>} />
        <Route path="courses" element={<RoleGate roles={PLANNER_ROLES}><Courses /></RoleGate>} />
        <Route path="lockers" element={<RoleGate roles={OPS_ROLES}><Lockers /></RoleGate>} />
        <Route path="cameras" element={<RoleGate roles={OPS_ROLES}><Cameras /></RoleGate>} />
        <Route path="audit" element={<RoleGate roles={OPS_ROLES}><AuditLog /></RoleGate>} />
        <Route path="reports" element={<RoleGate roles={OPS_ROLES}><Reports /></RoleGate>} />
        <Route path="evaluation" element={<RoleGate roles={['admin']}><Evaluation /></RoleGate>} />
        <Route path="requests" element={<RoleGate roles={['admin', 'dean', 'instructor']}><Requests /></RoleGate>} />
        <Route path="departments" element={<RoleGate roles={['admin']}><Departments /></RoleGate>} />
        <Route path="school-hours" element={<RoleGate roles={['admin']}><SchoolHours /></RoleGate>} />
        <Route path="users" element={<RoleGate roles={['admin']}><Users /></RoleGate>} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  )
}
