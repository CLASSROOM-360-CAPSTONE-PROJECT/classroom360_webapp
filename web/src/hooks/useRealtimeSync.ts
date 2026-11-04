import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'

/** Which cached queries go stale when a table changes. */
const WATCHED: Record<string, string[]> = {
  access_logs: ['access-logs', 'locker-status', 'room-status', 'audit', 'ops-alerts', 'trial-candidates', 'tap-link'],
  key_return_events: ['locker-status', 'room-status', 'ops-alerts', 'trial-candidates'],
  occupancy_events: ['room-status', 'ops-alerts', 'trial-candidates'],
  schedule_entries: ['schedule-entries', 'timetable-rows', 'schedule-busy', 'free-rooms', 'room-status'],
  room_requests: ['room-requests', 'free-rooms', 'room-status', 'locker-status', 'audit', 'ops-alerts'],
}

/**
 * Subscribes to Supabase Realtime so the dashboard refreshes the moment a key is taken or
 * returned, the camera reports, or a schedule changes. Row-level security still applies:
 * a user only receives changes they are allowed to read.
 */
export function useRealtimeSync() {
  const qc = useQueryClient()

  useEffect(() => {
    const channel = supabase.channel('classroom360-live')
    for (const [table, keys] of Object.entries(WATCHED)) {
      channel.on('postgres_changes', { event: '*', schema: 'public', table }, () => {
        keys.forEach((k) => qc.invalidateQueries({ queryKey: [k] }))
      })
    }
    channel.subscribe()
    return () => {
      void supabase.removeChannel(channel)
    }
  }, [qc])
}

/** Current time, refreshed on an interval (drives the clock and "x min ago" labels). */
export function useNow(ms = 30_000): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), ms)
    return () => window.clearInterval(id)
  }, [ms])
  return now
}
