import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@/auth/AuthProvider'
import { useAlertSweep, useUnreadCount } from '@/lib/api'
import { shouldPopUp, withBadge } from '@/lib/notify'
import { supabase } from '@/lib/supabase'
import type { NotificationRow } from '@/lib/types'

export const DESKTOP_ALERTS_KEY = 'c360.desktopAlerts'

export function desktopAlertsWanted(): boolean {
  try {
    return window.localStorage.getItem(DESKTOP_ALERTS_KEY) === '1'
  } catch {
    return false
  }
}

export function setDesktopAlertsWanted(on: boolean) {
  try {
    if (on) window.localStorage.setItem(DESKTOP_ALERTS_KEY, '1')
    else window.localStorage.removeItem(DESKTOP_ALERTS_KEY)
  } catch {
    /* only a convenience */
  }
}

function popUp(n: NotificationRow) {
  try {
    if (typeof Notification === 'undefined') return
    if (!shouldPopUp({ wanted: desktopAlertsWanted(), permission: Notification.permission, tabHidden: document.visibilityState === 'hidden' })) return
    const shown = new Notification(n.title, { body: n.body, tag: n.ref, icon: '/favicon.svg' })
    shown.onclick = () => {
      window.focus()
      shown.close()
    }
  } catch {
    /* a browser that refuses is simply not told */
  }
}

/**
 * Keeps the inbox alive for as long as the app is open (and the tab title, which names the page and carries the unread count):
 *  - listens for new messages (Realtime, own rows only) and refreshes the bell the moment one arrives;
 *  - shows a desktop pop-up for it when the person turned that on and the tab is hidden;
 *  - puts the number of unread messages in the tab title;
 *  - for administrators and deans, asks for the alert sweep once a minute.
 * Everything stays quiet when database update 12 has not been run yet.
 */
export function useInbox(pageTitle?: string) {
  const { profile } = useAuth()
  const qc = useQueryClient()
  const uid = profile?.id
  const unread = useUnreadCount(Boolean(uid))
  useAlertSweep(Boolean(uid) && (profile?.role === 'admin' || profile?.role === 'dean'))

  useEffect(() => {
    if (!uid) return
    const channel = supabase
      .channel(`classroom360-inbox-${uid}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notifications', filter: `user_id=eq.${uid}` }, (payload) => {
        void qc.invalidateQueries({ queryKey: ['notifications'] })
        popUp(payload.new as NotificationRow)
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'notifications', filter: `user_id=eq.${uid}` }, () => {
        void qc.invalidateQueries({ queryKey: ['notifications'] })
      })
    channel.subscribe()
    return () => {
      void supabase.removeChannel(channel)
    }
  }, [uid, qc])

  const count = unread.error ? 0 : (unread.data ?? 0)
  const base = pageTitle ? `${pageTitle} · Classroom360` : 'Classroom360'
  useEffect(() => {
    const apply = () => {
      const next = withBadge(base, count)
      if (next !== document.title) document.title = next
    }
    apply()
    // printing sets a file name as the title and puts the old one back afterwards: count again once it is over
    const afterPrint = () => window.setTimeout(apply, 0)
    window.addEventListener('afterprint', afterPrint)
    return () => window.removeEventListener('afterprint', afterPrint)
  }, [count, base])
}
