import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from './supabase'
import type { Department, NotificationRow, OpsAlert, Program, LockerStatusRow, RoomOption, SchoolHour, StationStatusRow, Term, TrialCandidate } from './types'

/** Await a Supabase query and throw its error, so TanStack Query can surface it. */
export async function unwrap<T>(
  query: PromiseLike<{ data: unknown; error: { message: string } | null }>,
): Promise<T> {
  const { data, error } = await query
  if (error) throw new Error(error.message)
  return data as T
}

export function useTerms() {
  return useQuery({
    queryKey: ['terms'],
    queryFn: () => unwrap<Term[]>(supabase.from('terms').select('*').order('starts_on', { ascending: false })),
  })
}

export function useActiveTerm() {
  const q = useTerms()
  const term = q.data?.find((t) => t.is_active) ?? q.data?.[0]
  return { ...q, term }
}

/** The days the school is open and from when to when. A day with no row is a closed day. */
export function useSchoolHours(enabled = true) {
  return useQuery({
    queryKey: ['school-hours'],
    enabled,
    queryFn: () => unwrap<SchoolHour[]>(supabase.from('school_hours').select('day_of_week, opens_at, closes_at').order('day_of_week')),
  })
}

/** The four key doors and who holds each key. */
export function useLockerStatus(enabled = true) {
  return useQuery({
    queryKey: ['locker-status'],
    enabled,
    queryFn: () => unwrap<LockerStatusRow[]>(supabase.from('locker_status').select('*').order('compartment_no')),
  })
}

export function usePrograms() {
  return useQuery({
    queryKey: ['programs'],
    queryFn: () => unwrap<Program[]>(supabase.from('programs').select('*').order('code')),
  })
}

export function useDepartments() {
  return useQuery({
    queryKey: ['departments'],
    queryFn: () => unwrap<Department[]>(supabase.from('departments').select('*').order('code')),
  })
}

/** Departments that can still be picked for new people and programs. */
export function useActiveDepartments(keep?: string | null) {
  const q = useDepartments()
  const data = (q.data ?? []).filter((d) => d.is_active || d.id === keep)
  return { ...q, data }
}

export function useRooms() {
  return useQuery({
    queryKey: ['rooms-options'],
    queryFn: () =>
      unwrap<RoomOption[]>(
        supabase.from('rooms').select('id, code, name, floor, capacity').eq('is_active', true).order('code'),
      ),
  })
}

/** Requests waiting for a dean or administrator (drives the sidebar badge and the dashboard banner). */
export function usePendingRequestCount(enabled: boolean) {
  return useQuery({
    queryKey: ['room-requests', 'pending-count'],
    enabled,
    queryFn: async () => {
      const { count, error } = await supabase
        .from('room_requests')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'pending')
      if (error) throw new Error(error.message)
      return count ?? 0
    },
  })
}

/**
 * True when a call failed because the database does not have a migration yet, 11 or 12 (the function, view or table
 * is missing), so a page can say "update the database" instead of showing a raw error.
 */
export function isMissingMigration(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  return /could not find the (function|table)|schema cache|does not exist|PGRST20[25]|42P01|42883/i.test(msg)
}

/** What an administrator or dean should look at now (keys not returned, rooms, denied taps, a silent locker). */
export function useOpsAlerts(enabled = true) {
  return useQuery({
    queryKey: ['ops-alerts'],
    enabled,
    refetchInterval: 30_000,
    retry: (count, err) => !isMissingMigration(err) && count < 2,
    queryFn: () => unwrap<OpsAlert[]>(supabase.rpc('ops_alerts', { p_hours: 24 })),
  })
}

/** Is the locker station reporting? One row per station. */
export function useStationStatus(enabled = true) {
  return useQuery({
    queryKey: ['station-status'],
    enabled,
    refetchInterval: 30_000,
    retry: (count, err) => !isMissingMigration(err) && count < 2,
    queryFn: () => unwrap<StationStatusRow[]>(supabase.from('station_status').select('*').order('station_label')),
  })
}

/**
 * Read every row of a query, a page of 1000 at a time (the server never sends more than that in one answer).
 * The query must be ordered in a way that does not change between pages, with the id as the last key.
 */
export async function fetchAll<T>(
  page: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>,
  max = 50_000,
): Promise<T[]> {
  const size = 1000
  const out: T[] = []
  for (let from = 0; from < max; from += size) {
    const rows = await unwrap<T[]>(page(from, from + size - 1))
    out.push(...rows)
    if (rows.length < size) break
  }
  return out
}

/* ---------- step 9: the inbox ---------- */

const INBOX_COLUMNS = 'id, kind, severity, title, body, link, ref, created_at, read_at'

/** The latest messages of the signed-in person (row-level security lets them see only their own). */
export function useNotifications(enabled = true) {
  return useQuery({
    queryKey: ['notifications', 'list'],
    enabled,
    refetchInterval: 60_000,
    retry: (count, err) => !isMissingMigration(err) && count < 2,
    queryFn: () =>
      unwrap<NotificationRow[]>(
        supabase.from('notifications').select(INBOX_COLUMNS).order('created_at', { ascending: false }).order('id').limit(50),
      ),
  })
}

/** How many messages are still unread. A count of its own, so it is right even when more than the list shows are waiting. */
export function useUnreadCount(enabled = true) {
  return useQuery({
    queryKey: ['notifications', 'unread'],
    enabled,
    refetchInterval: 60_000,
    retry: (count, err) => !isMissingMigration(err) && count < 2,
    queryFn: async () => {
      const { count, error } = await supabase.from('notifications').select('id', { count: 'exact', head: true }).is('read_at', null)
      if (error) throw new Error(error.message)
      return count ?? 0
    },
  })
}

/** Mark some messages read, or all of them (no ids). */
export function useMarkRead() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (ids?: string[]) => {
      const { error } = await supabase.rpc('mark_notifications_read', ids ? { p_ids: ids } : {})
      if (error) throw new Error(error.message)
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  })
}

/**
 * The alerts have no event of their own (a key simply stays out, a station goes quiet), so an open screen asks the database
 * once a minute to turn them into messages. The database lets one sweep through per school every 20 seconds.
 */
export function useAlertSweep(enabled: boolean) {
  const qc = useQueryClient()
  return useQuery({
    queryKey: ['alert-sweep'],
    enabled,
    retry: false,
    refetchInterval: (q) => (q.state.error ? false : 60_000),
    refetchIntervalInBackground: true,
    queryFn: async () => {
      const made = await unwrap<number>(supabase.rpc('sweep_my_alerts'))
      if (made > 0) void qc.invalidateQueries({ queryKey: ['notifications'] })
      return made
    },
  })
}

/** Locker taps, door closings and camera reports from the last few hours that are not trials yet (administrator only). */
export function useTrialCandidates(hours: number, enabled = true) {
  return useQuery({
    queryKey: ['trial-candidates', hours],
    enabled,
    retry: (count, err) => !isMissingMigration(err) && count < 2,
    queryFn: () => unwrap<TrialCandidate[]>(supabase.rpc('trial_candidates', { p_hours: hours })),
  })
}
