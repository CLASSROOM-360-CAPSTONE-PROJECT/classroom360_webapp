import { useEffect, useMemo, useState } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { LogOut, Menu, Search, X } from 'lucide-react'
import { useAuth } from '@/auth/AuthProvider'
import { useInbox } from '@/hooks/useInbox'
import { useRealtimeSync } from '@/hooks/useRealtimeSync'
import { usePendingRequestCount } from '@/lib/api'
import { cn } from '@/lib/cn'
import { isOps, ROLE_LABEL } from '@/lib/roles'
import { CampusPulse } from './CampusPulse'
import { CommandPalette, type PaletteItem } from './CommandPalette'
import { GenerateHost } from './GenerateHost'
import { Logo } from './Logo'
import { NAV_KEYWORDS, navFor, navLabel } from './nav'
import { NotificationBell } from './NotificationBell'

export function AppShell() {
  const { profile, signOut } = useAuth()
  const [open, setOpen] = useState(false)
  const [jump, setJump] = useState(false)
  const { pathname } = useLocation()
  const navigate = useNavigate()
  useRealtimeSync()
  const pending = usePendingRequestCount(isOps(profile?.role))

  const items = useMemo(() => navFor(profile?.role), [profile?.role])
  const displayName = profile?.full_name || profile?.email || 'Signed in'
  const initials = displayName
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('')

  // each page opens from the top, and the tab says where you are (the inbox adds the unread count to it)
  const here = items.find((n) => (n.to === '/' ? pathname === '/' : pathname.startsWith(n.to)))
  useInbox(here ? navLabel(here, profile?.role) : undefined)
  useEffect(() => {
    // braces on purpose: in some browsers scrollTo returns a Promise, and an effect must not return one
    window.scrollTo(0, 0)
  }, [pathname])

  // Ctrl or Cmd + K opens the Jump to window from anywhere
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setJump((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const paletteItems: PaletteItem[] = useMemo(
    () => [
      ...items.map((n) => ({
        id: n.to === '/' ? 'home' : n.to.slice(1),
        label: navLabel(n, profile?.role),
        keywords: NAV_KEYWORDS[n.to],
        icon: n.icon,
        run: () => {
          setOpen(false)
          navigate(n.to)
        },
      })),
      { id: 'sign-out', label: 'Sign out', keywords: 'log out leave', icon: LogOut, run: () => void signOut() },
    ],
    [items, profile?.role, navigate, signOut],
  )

  return (
    <div className="app-root min-h-screen lg:grid lg:grid-cols-[240px_minmax(0,1fr)]">
      <div className="no-print sticky top-0 z-30 flex h-12 items-center justify-between bg-ink-900 px-4 text-white lg:hidden">
        <Logo />
        <div className="flex items-center gap-1">
          <NotificationBell where="topbar" />
          <button
            type="button"
            onClick={() => setOpen(true)}
            aria-label="Open menu"
            className="grid size-9 place-items-center rounded-md hover:bg-ink-800"
          >
            <Menu className="size-5" />
          </button>
        </div>
      </div>

      {open && <div className="fixed inset-0 z-30 bg-ink-950/50 lg:hidden" onClick={() => setOpen(false)} aria-hidden />}

      <aside
        className={cn(
          'no-print fixed inset-y-0 left-0 z-40 flex w-[240px] flex-col bg-ink-900 text-ink-200 transition-transform motion-reduce:transition-none',
          'lg:sticky lg:top-0 lg:h-screen lg:translate-x-0',
          open ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <div className="flex items-start justify-between px-5 pb-3 pt-4 text-white">
          <div>
            <Logo />
            <div className="mt-2 max-w-[170px] text-[12.5px] leading-snug text-ink-300">{profile?.tenants?.name}</div>
          </div>
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Close menu"
            className="grid size-8 place-items-center rounded-md hover:bg-ink-800 lg:hidden"
          >
            <X className="size-5" />
          </button>
          <div className="hidden lg:block">
            <NotificationBell where="sidebar" />
          </div>
        </div>

        <div className="px-3 pb-2">
          <button
            type="button"
            onClick={() => setJump(true)}
            className="flex h-9 w-full items-center gap-2 rounded-md border border-ink-700 bg-ink-800/60 px-3 text-[13px] text-ink-300 transition-colors hover:border-ink-600 hover:bg-ink-800 hover:text-white"
          >
            <Search className="size-4 shrink-0" aria-hidden />
            <span className="flex-1 text-left">Jump to a page</span>
            <kbd className="hidden rounded border border-ink-600 px-1.5 text-[11px] leading-4 text-ink-400 lg:block" aria-hidden>
              Ctrl K
            </kbd>
          </button>
        </div>

        <CampusPulse />

        <nav className="flex-1 overflow-y-auto px-3 pb-5 [mask-image:linear-gradient(to_bottom,#000_calc(100%-14px),transparent)]" aria-label="Main">
          {items.map((item, i) => (
            <div key={item.to} className={cn(i > 0 && items[i - 1].group !== item.group && 'mt-2 border-t border-ink-800 pt-2')}>
              <NavLink
                to={item.to}
                end={item.to === '/'}
                onClick={() => setOpen(false)}
                className={({ isActive }) =>
                  cn(
                    'relative flex h-[34px] items-center gap-3 rounded-md px-3 text-[14px] transition-colors',
                    isActive ? 'bg-ink-800 text-white' : 'text-ink-300 hover:bg-ink-800/60 hover:text-white',
                  )
                }
              >
                {({ isActive }) => (
                  <>
                    {isActive && <span className="absolute inset-y-1.5 left-0 w-[3px] rounded-r bg-brass-400" aria-hidden />}
                    <item.icon className="size-[18px] shrink-0" aria-hidden />
                    <span className="min-w-0 flex-1 truncate">{navLabel(item, profile?.role)}</span>
                    {item.pendingBadge && (pending.data ?? 0) > 0 && (
                      <span
                        className="grid h-5 min-w-5 place-items-center rounded-full bg-brass-400 px-1.5 text-[12px] font-semibold text-ink-950"
                        aria-label={`${pending.data} waiting`}
                      >
                        {pending.data}
                      </span>
                    )}
                  </>
                )}
              </NavLink>
            </div>
          ))}
        </nav>

        <div className="border-t border-ink-800 p-4">
          <div className="flex items-center gap-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-full bg-ink-700 text-[13px] font-semibold text-brass-300" aria-hidden>
              {initials || '?'}
            </span>
            <div className="min-w-0">
              <div className="truncate text-[14px] font-medium text-white">{displayName}</div>
              <div className="text-[12.5px] text-ink-300">{profile ? ROLE_LABEL[profile.role] : ''}</div>
            </div>
          </div>
          <button
            type="button"
            onClick={() => void signOut()}
            className="mt-3 inline-flex items-center gap-2 text-[13px] text-ink-300 transition-colors hover:text-white"
          >
            <LogOut className="size-4" aria-hidden />
            Sign out
          </button>
        </div>
      </aside>

      <main className="app-main mx-auto w-full max-w-[1240px] px-4 py-6 sm:px-8 sm:py-8">
        <div key={pathname} className="page-enter">
          <Outlet />
        </div>
      </main>

      <CommandPalette open={jump} onClose={() => setJump(false)} items={paletteItems} />

      {/* the Generate schedule window lives here, not in a page, so a run keeps going when it is minimized or the page changes */}
      <GenerateHost />
    </div>
  )
}
