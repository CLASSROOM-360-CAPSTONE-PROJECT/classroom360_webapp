import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { Bell, BellOff, CheckCheck, X } from 'lucide-react'
import { useAuth } from '@/auth/AuthProvider'
import { desktopAlertsWanted, setDesktopAlertsWanted } from '@/hooks/useInbox'
import { isMissingMigration, useMarkRead, useNotifications, useUnreadCount } from '@/lib/api'
import { cn } from '@/lib/cn'
import { badgeText, groupByDay, newestFirst, NOTE_SEVERITY_LABEL, safeLink } from '@/lib/notify'
import { fmtRelative } from '@/lib/time'
import type { NotificationRow } from '@/lib/types'

const DOT: Record<NotificationRow['severity'], string> = { high: 'bg-rose-500', medium: 'bg-amber-500', info: 'bg-ink-300' }

type Where = 'sidebar' | 'topbar'

/**
 * The bell: how many messages are unread, and the list. Click a message to open the page it is about.
 * It is hidden when the database does not have update 12 yet, so nothing looks broken before that.
 */
export function NotificationBell({ where }: { where: Where }) {
  const { profile } = useAuth()
  const navigate = useNavigate()
  const tz = profile?.tenants?.timezone ?? 'Asia/Manila'
  const unread = useUnreadCount()
  const list = useNotifications()
  const mark = useMarkRead()
  const [open, setOpen] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)

  const count = unread.data ?? 0
  const rows = useMemo(() => newestFirst(list.data ?? []), [list.data])
  const days = useMemo(() => groupByDay(rows, new Date(), tz), [rows, tz])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false)
        button.current?.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    panel.current?.focus()
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  if (isMissingMigration(unread.error) || isMissingMigration(list.error)) return null

  function openRow(n: NotificationRow) {
    if (!n.read_at) mark.mutate([n.id])
    const to = safeLink(n.link)
    setOpen(false)
    if (to) navigate(to)
  }

  const label = count > 0 ? `Notifications, ${count} unread` : 'Notifications'

  return (
    <>
      <button
        ref={button}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        className={cn(
          'relative grid size-9 place-items-center rounded-md text-white hover:bg-ink-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brass-400',
        )}
      >
        <Bell className="size-5" aria-hidden />
        {count > 0 && (
          <span
            data-testid="bell-count"
            aria-hidden
            className="absolute -right-0.5 -top-0.5 grid h-[18px] min-w-[18px] place-items-center rounded-full bg-brass-400 px-1 text-[11px] font-semibold leading-none text-ink-950"
          >
            {badgeText(count)}
          </span>
        )}
      </button>

      {open &&
        createPortal(
          <>
            <div className="no-print fixed inset-0 z-[60]" onClick={() => setOpen(false)} aria-hidden />
            <div
              ref={panel}
              role="dialog"
              aria-label="Notifications"
              tabIndex={-1}
              className={cn(
                'no-print fixed z-[61] flex max-h-[calc(100vh-1.5rem)] flex-col overflow-hidden rounded-lg border border-ink-200 bg-white text-ink-900 shadow-xl outline-none',
                where === 'sidebar' ? 'left-[252px] top-3 w-[400px] max-w-[calc(100vw-264px)]' : 'inset-x-2 top-14 max-h-[calc(100vh-4rem)]',
              )}
            >
              <header className="flex items-center justify-between gap-2 border-b border-ink-100 px-4 py-3">
                <h2 className="text-[15px] font-semibold">Notifications</h2>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    disabled={count === 0 || mark.isPending}
                    onClick={() => mark.mutate(undefined)}
                    className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-[13px] font-medium text-ink-700 hover:bg-ink-100 disabled:cursor-not-allowed disabled:text-ink-300 disabled:hover:bg-transparent"
                  >
                    <CheckCheck className="size-4" aria-hidden />
                    Mark all read
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setOpen(false)
                      button.current?.focus()
                    }}
                    aria-label="Close notifications"
                    className="grid size-8 place-items-center rounded-md text-ink-500 hover:bg-ink-100"
                  >
                    <X className="size-4" aria-hidden />
                  </button>
                </div>
              </header>

              <div className="min-h-0 flex-1 overflow-y-auto">
                {list.isLoading ? (
                  <p className="px-4 py-6 text-[14px] text-ink-500">Loading…</p>
                ) : list.error ? (
                  <p className="px-4 py-6 text-[14px] text-rose-700">Could not load your notifications.</p>
                ) : rows.length === 0 ? (
                  <p className="px-4 py-8 text-center text-[14px] text-ink-500">Nothing yet. New room requests, decisions and urgent alerts will appear here.</p>
                ) : (
                  days.map((d) => (
                    <section key={d.label} aria-label={d.label}>
                      <h3 className="sticky top-0 bg-ink-50 px-4 py-1.5 text-[12px] font-medium text-ink-500">{d.label}</h3>
                      <ul>
                        {d.rows.map((n) => (
                          <li key={n.id} className="border-t border-ink-100 first:border-t-0">
                            <button
                              type="button"
                              onClick={() => openRow(n)}
                              data-unread={n.read_at ? 'false' : 'true'}
                              className={cn('flex w-full gap-3 px-4 py-3 text-left hover:bg-ink-50 focus-visible:bg-ink-50', !n.read_at && 'bg-brass-50/60')}
                            >
                              <span className={cn('mt-1.5 size-2 shrink-0 rounded-full', n.read_at ? 'bg-transparent' : DOT[n.severity])} aria-hidden />
                              <span className="min-w-0 flex-1">
                                <span className="flex items-baseline justify-between gap-3">
                                  <span className={cn('text-[14px] leading-snug', n.read_at ? 'text-ink-700' : 'font-semibold text-ink-900')}>{n.title}</span>
                                  <time dateTime={n.created_at} className="shrink-0 text-[12px] text-ink-500">
                                    {fmtRelative(n.created_at)}
                                  </time>
                                </span>
                                {n.body && <span className="mt-0.5 block text-[13px] leading-snug text-ink-600">{n.body}</span>}
                                {n.severity !== 'info' && <span className="sr-only">{NOTE_SEVERITY_LABEL[n.severity]}</span>}
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    </section>
                  ))
                )}
              </div>

              <DesktopAlerts />
            </div>
          </>,
          document.body,
        )}
    </>
  )
}

/** The choice to also get a pop-up on this computer. It works while the app is open in a tab, even a hidden one. */
function DesktopAlerts() {
  const supported = typeof Notification !== 'undefined'
  const [permission, setPermission] = useState<string>(supported ? Notification.permission : 'unsupported')
  const [wanted, setWanted] = useState(desktopAlertsWanted)

  async function turnOn() {
    try {
      const result = permission === 'granted' ? 'granted' : await Notification.requestPermission()
      setPermission(result)
      if (result === 'granted') {
        setDesktopAlertsWanted(true)
        setWanted(true)
      }
    } catch {
      setPermission('denied')
    }
  }

  function turnOff() {
    setDesktopAlertsWanted(false)
    setWanted(false)
  }

  const on = permission === 'granted' && wanted

  return (
    <footer className="border-t border-ink-100 bg-ink-50 px-4 py-3 text-[13px] text-ink-600">
      {permission === 'unsupported' ? (
        <p>This browser cannot show pop-ups on the computer.</p>
      ) : permission === 'denied' ? (
        <p className="flex items-start gap-2">
          <BellOff className="mt-0.5 size-4 shrink-0" aria-hidden />
          Pop-ups are blocked for this site. Allow notifications in the browser’s site settings to use them.
        </p>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span>{on ? 'Pop-ups are on while this page is open in a tab.' : 'Get a pop-up on this computer when a message arrives.'}</span>
          <button
            type="button"
            onClick={on ? turnOff : () => void turnOn()}
            className="h-8 rounded-md border border-ink-300 bg-white px-3 text-[13px] font-medium text-ink-800 hover:bg-ink-100"
          >
            {on ? 'Turn off' : 'Turn on'}
          </button>
        </div>
      )}
    </footer>
  )
}
