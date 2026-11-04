import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { ArrowUpRight } from 'lucide-react'
import { cn } from '@/lib/cn'

/**
 * The key ledger: the day's four figures on a dark plate screwed to the page, set in flap digits like a departures
 * board. It is the one loud thing on the campus overview, so the rest of the page can stay quiet. Each figure is
 * still a link or a button to what explains it, and the digits turn over when a number changes.
 */

export interface LedgerFigure {
  label: string
  value: number
  /** the digits shown are padded with zeros to this length */
  pad?: number
  hint: string
  /** red digits and lamps */
  bad?: boolean
  /** a row of lamps under the digits: `lit` of `of` are on */
  lamps?: { lit: number; of: number }
  to?: string
  onClick?: () => void
}

/** The digits of a number, each on its own flap. A flap that changes is a new element, so it plays its turn-over again. */
export function Digits({ value, pad = 2, bad }: { value: number; pad?: number; bad?: boolean }) {
  const text = String(Math.max(0, Math.round(value))).padStart(pad, '0')
  return (
    <span className="inline-flex gap-[3px]" aria-hidden>
      {text.split('').map((ch, i) => (
        <span
          key={`${text.length - i}-${ch}`}
          className={cn(
            'flap relative grid h-12 w-[30px] place-items-center overflow-hidden rounded-[4px] bg-ink-900 font-mono text-[34px] font-medium leading-none ring-1 ring-ink-800',
            'after:absolute after:inset-x-0 after:top-1/2 after:h-px after:bg-ink-950/90',
            bad ? 'text-rose-300' : 'text-brass-300',
          )}
        >
          {ch}
        </span>
      ))}
    </span>
  )
}

/** A row of small lamps, like the ones on a locker door: lit ones glow brass (or red). */
export function Lamps({ lit, of, bad }: { lit: number; of: number; bad?: boolean }) {
  const n = Math.min(Math.max(of, 0), 16)
  const on = of > 16 ? Math.round((lit / of) * 16) : Math.min(lit, n)
  return (
    <span className="flex gap-1.5" aria-hidden>
      {Array.from({ length: n }, (_, i) => (
        <span
          key={i}
          className={cn(
            'size-2 rounded-full transition-colors',
            i < on ? (bad ? 'bg-rose-400 shadow-[0_0_6px_1px_rgb(251_113_133/0.55)]' : 'bg-brass-400 shadow-[0_0_6px_1px_rgb(210_154_63/0.55)]') : 'bg-ink-800 ring-1 ring-inset ring-ink-700',
          )}
        />
      ))}
    </span>
  )
}

export function Screw({ className }: { className: string }) {
  return <span aria-hidden className={cn('absolute size-[7px] rounded-full bg-ink-800 ring-1 ring-ink-700 after:absolute after:inset-x-[1px] after:top-[2.5px] after:h-px after:rotate-[35deg] after:bg-ink-950', className)} />
}

export function Ledger({ figures, footer }: { figures: LedgerFigure[]; footer?: ReactNode }) {
  const cell = 'group relative flex h-full w-full flex-col justify-start bg-ink-950 px-4 py-4 text-left sm:px-6'
  const interactive = 'transition-colors hover:bg-ink-900 focus-visible:z-10'
  return (
    <section
      aria-label="Key ledger"
      className="relative mb-6 overflow-hidden rounded-md bg-ink-950 text-white shadow-[0_8px_20px_-10px_rgb(11_21_36/0.55)] ring-1 ring-ink-800"
    >
      <Screw className="left-2 top-2" />
      <Screw className="right-2 top-2" />
      <Screw className="bottom-2 left-2" />
      <Screw className="bottom-2 right-2" />
      <div className="grid gap-px bg-ink-800 grid-cols-2 lg:grid-cols-4">
        {figures.map((f) => {
          const body = (
            <>
              <span className="block text-[13px] text-ink-300">{f.label}</span>
              <span className="mt-2.5 block">
                <Digits value={f.value} pad={f.pad} bad={f.bad} />
                <span className="sr-only">{f.value}</span>
              </span>
              {f.lamps && (
                <span className="mt-3 block">
                  <Lamps lit={f.lamps.lit} of={f.lamps.of} bad={f.bad} />
                </span>
              )}
              <span className="mt-2.5 block text-[12.5px] leading-4 text-ink-400">{f.hint}</span>
            </>
          )
          const arrow = (
            <ArrowUpRight
              aria-hidden
              className="absolute right-3 top-3 size-4 sm:right-4 sm:top-4 text-ink-600 transition-all group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-brass-300"
            />
          )
          if (f.to)
            return (
              <Link key={f.label} to={f.to} className={cn(cell, interactive)}>
                {body}
                {arrow}
              </Link>
            )
          if (f.onClick)
            return (
              <button key={f.label} type="button" onClick={f.onClick} className={cn(cell, interactive)}>
                {body}
                {arrow}
              </button>
            )
          return (
            <div key={f.label} className={cell}>
              {body}
            </div>
          )
        })}
      </div>
      {footer && <div className="border-t border-ink-800 px-4 py-2.5 sm:px-6 text-[13px] text-ink-300">{footer}</div>}
    </section>
  )
}
