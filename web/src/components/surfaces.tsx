import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

/*
  Small pieces of the console's "office" vocabulary that more than one page borrows: a rubber stamp, the strip that shows
  a stretch of the school day, a spike with slips on it. Each page puts them to its own use; none of them is a layout.
*/

/** Minutes since midnight from "08:30" or "08:30:00". */
export function toMin(t: string): number {
  const m = /^(\d{1,2}):(\d{2})/.exec(t)
  return m ? Number(m[1]) * 60 + Number(m[2]) : 0
}

/** "7 AM", "12 PM": a whole hour on the strip. */
function hourLabel(h: number): string {
  const x = h % 12 === 0 ? 12 : h % 12
  return `${x} ${h < 12 ? 'AM' : 'PM'}`
}

/**
 * The school day as a thin rail, with the stretch of time in question laid on it in brass. It answers "when, in the
 * day?" at a glance, which "2:00 PM to 3:30 PM" does not.
 */
export function DayBar({
  start,
  end,
  from = 7 * 60,
  to = 21 * 60,
  tone = 'brass',
  labels = true,
  className,
}: {
  start: string
  end: string
  from?: number
  to?: number
  tone?: 'brass' | 'ink' | 'good'
  labels?: boolean
  className?: string
}) {
  const span = to - from
  const s = Math.min(Math.max(toMin(start), from), to)
  const e = Math.min(Math.max(toMin(end), from), to)
  const left = ((s - from) / span) * 100
  const width = Math.max(((e - s) / span) * 100, 2.5)
  const ticks: number[] = []
  for (let m = Math.ceil(from / 180) * 180; m < to; m += 180) ticks.push(m)
  return (
    <div className={className} aria-hidden>
      <div className="relative h-2 rounded-full bg-ink-100 ring-1 ring-inset ring-ink-200/70">
        {ticks.map((m) => (
          <span key={m} className="absolute inset-y-0 w-px bg-white" style={{ left: `${((m - from) / span) * 100}%` }} />
        ))}
        <span
          className={cn(
            'absolute inset-y-[-1px] rounded-full',
            tone === 'brass' && 'bg-brass-400 ring-1 ring-brass-600/40',
            tone === 'ink' && 'bg-ink-600 ring-1 ring-ink-800/40',
            tone === 'good' && 'bg-emerald-500 ring-1 ring-emerald-700/40',
          )}
          style={{ left: `${left}%`, width: `${width}%` }}
        />
      </div>
      {labels && (
        <div className="mt-1 flex justify-between text-[11px] leading-3 text-ink-400">
          <span>{hourLabel(Math.floor(from / 60))}</span>
          <span>{hourLabel(Math.floor(to / 60))}</span>
        </div>
      )}
    </div>
  )
}

/** A rubber stamp impression: a boxed word, tilted a little, as if pressed on the slip by hand. */
export function Stamp({ tone, children, className }: { tone: 'good' | 'bad' | 'neutral' | 'warn'; children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        'inline-block -rotate-2 select-none whitespace-nowrap rounded-[3px] border-2 px-2 py-px font-display text-[14px] font-semibold leading-5 tracking-[0.06em] opacity-90',
        tone === 'good' && 'border-emerald-700/75 text-emerald-800 shadow-[inset_0_0_0_1px_rgb(4_120_87/0.15)]',
        tone === 'bad' && 'border-rose-700/75 text-rose-800 shadow-[inset_0_0_0_1px_rgb(190_18_60/0.15)]',
        tone === 'warn' && 'border-amber-700/75 text-amber-800',
        tone === 'neutral' && 'border-ink-400 text-ink-500',
        className,
      )}
    >
      {children}
    </span>
  )
}

/**
 * A bill spike with slips pushed down onto it, one slip per waiting request (up to six are drawn). An empty spike
 * says there is nothing to do.
 */
export function Spike({ count, className }: { count: number; className?: string }) {
  const n = Math.min(count, 6)
  const tilt = [-3, 2, -1.5, 3, -2, 1]
  return (
    <svg viewBox="0 0 120 112" className={cn('h-[104px] w-[112px]', className)} aria-hidden>
      <ellipse cx="60" cy="102" rx="38" ry="6" fill="#0b1524" opacity="0.14" />
      <rect x="22" y="92" width="76" height="9" rx="4.5" fill="#263d5c" />
      <rect x="22" y="92" width="76" height="2.5" rx="1.25" fill="#3a5578" />
      {Array.from({ length: n }, (_, i) => {
        const y = 86 - i * 9.5
        return (
          <g key={i} transform={`rotate(${tilt[i]} 60 ${y})`}>
            <rect x="30" y={y - 7} width="60" height="11" rx="2" fill="#fffdf7" stroke="#cfd8e5" strokeWidth="1" />
            <rect x="30" y={y - 7} width="15" height="11" rx="2" fill="#f7ebcf" />
            <line x1="46" y1={y - 6} x2="46" y2={y + 3} stroke="#d29a3f" strokeWidth="1" strokeDasharray="1.5 1.5" />
            <line x1="52" y1={y - 2.5} x2="82" y2={y - 2.5} stroke="#cfd8e5" strokeWidth="1.5" strokeLinecap="round" />
            <line x1="52" y1={y + 1} x2="72" y2={y + 1} stroke="#e6ebf2" strokeWidth="1.5" strokeLinecap="round" />
          </g>
        )
      })}
      <path d="M60 92V9" stroke="#8499b6" strokeWidth="3" strokeLinecap="round" />
      <path d="M60 9 L57.6 20 L62.4 20 Z" fill="#a9b8cd" />
      <circle cx="60" cy="7" r="2.2" fill="#d29a3f" />
    </svg>
  )
}

/** A screw head, for the plates and panels that are screwed to the wall. `tone` matches the surface it sits on. */
export function Rivet({ className, light }: { className?: string; light?: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        'absolute size-[7px] rounded-full',
        light ? 'bg-ink-100 ring-1 ring-ink-300 after:bg-ink-400' : 'bg-ink-800 ring-1 ring-ink-700 after:bg-ink-950',
        'after:absolute after:inset-x-[1px] after:top-[2.5px] after:h-px after:rotate-[35deg]',
        className,
      )}
    />
  )
}

/** The two half-circle bites out of a slip where its stub is perforated. They show the page behind. */
export function Notches({ className }: { className?: string }) {
  return (
    <>
      <span aria-hidden className={cn('absolute -top-2 size-4 rounded-full bg-canvas ring-1 ring-ink-200', className)} />
      <span aria-hidden className={cn('absolute -bottom-2 size-4 rounded-full bg-canvas ring-1 ring-ink-200', className)} />
    </>
  )
}

/** A test-bench panel: a dark instrument head with the name of what it holds, and the readings under it. */
export function Panel({
  title,
  description,
  action,
  flush,
  children,
}: {
  title: string
  description?: ReactNode
  action?: ReactNode
  flush?: boolean
  children: ReactNode
}) {
  return (
    <section className="overflow-hidden rounded-lg bg-white shadow-[0_16px_28px_-22px_rgb(11_21_36/0.55)] ring-1 ring-ink-200">
      <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 bg-ink-900 px-4 py-3.5 text-white">
        <div className="min-w-0">
          <h2 className="font-display text-[20px] font-semibold leading-6">{title}</h2>
          {description && <p className="mt-0.5 text-[13px] text-ink-300">{description}</p>}
        </div>
        {action}
      </header>
      <div className={flush ? '' : 'p-4'}>{children}</div>
    </section>
  )
}
