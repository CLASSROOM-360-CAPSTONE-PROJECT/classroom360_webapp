import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { AlertCircle, AlertTriangle, ArrowUpRight, CheckCircle2, Loader2, X } from 'lucide-react'
import { cn } from '@/lib/cn'
import { EmptyArt, type ArtKind } from './art'

/* ---------- layout ---------- */

/** One figure in the row under a page title: what is on the page, counted. */
export interface HeaderFact {
  label: string
  value: ReactNode
}

/**
 * The title of a page, set in the narrow display cut over a patch of drafting paper. `facts` are the few figures that
 * describe what the page holds (rooms, seats, people), read at a glance before the list.
 */
export function PageHeader({
  title,
  description,
  actions,
  facts,
}: {
  title: string
  description?: ReactNode
  actions?: ReactNode
  facts?: HeaderFact[]
}) {
  return (
    <div className="relative mb-6">
      <div aria-hidden className="drafting pointer-events-none absolute -right-4 -top-6 h-[calc(100%+3rem)] w-[min(720px,100%)] sm:-right-8" />
      <div className="relative flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
        <div className="min-w-0">
          <h1 className="font-display text-[30px] font-semibold leading-[1.05] tracking-[-0.015em]">{title}</h1>
          {description && <p className="mt-1.5 max-w-[64ch] text-ink-500">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {facts && facts.length > 0 && (
        <dl className="relative mt-4 flex flex-wrap gap-y-3">
          {facts.map((f, i) => (
            <div key={f.label} className={cn('flex flex-col-reverse pr-5', i > 0 && 'border-l border-ink-200 pl-5')}>
              <dt className="text-[12.5px] leading-4 text-ink-500">{f.label}</dt>
              <dd className="font-display text-[22px] font-semibold leading-7">{f.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  )
}

export function Card({
  id,
  title,
  description,
  action,
  flush,
  className,
  children,
}: {
  /** lets a link or button elsewhere on the page scroll to this card */
  id?: string
  title?: string
  description?: ReactNode
  action?: ReactNode
  /** Remove body padding (for tables that run edge to edge). */
  flush?: boolean
  className?: string
  children: ReactNode
}) {
  return (
    <section id={id} className={cn('rounded-md border border-ink-200 bg-white shadow-[0_1px_2px_rgb(11_21_36/0.04)]', className)}>
      {(title || action) && (
        <header className="ledger-rule flex flex-wrap items-center justify-between gap-3 border-b border-ink-200 px-4 py-3">
          <div>
            {title && <h2 className="font-display text-[17px] font-semibold leading-6 tracking-[-0.005em]">{title}</h2>}
            {description && <p className="text-[13px] text-ink-500">{description}</p>}
          </div>
          {action}
        </header>
      )}
      <div className={flush ? '' : 'p-4'}>{children}</div>
    </section>
  )
}

export interface Stat {
  label: string
  value: ReactNode
  hint?: string
  tone?: 'default' | 'bad'
  /** Makes the figure a link to the page that explains it. */
  to?: string
  /** Makes the figure a button that does something on this page (filter a list, scroll to a card). */
  onClick?: () => void
}

/** One bordered strip of figures; thin gaps act as the dividers at every width. A figure with `to` or `onClick` can be pressed. */
export function StatStrip({ items }: { items: Stat[] }) {
  const tile = 'group relative block w-full bg-white px-4 py-3 text-left transition-colors hover:bg-ink-50 focus-visible:z-10'
  const arrow = (
    <ArrowUpRight
      className="absolute right-3 top-3 size-4 text-ink-300 transition-all group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-ink-700"
      aria-hidden
    />
  )
  return (
    <div className="mb-6 grid gap-px overflow-hidden rounded-lg border border-ink-200 bg-ink-200 sm:grid-cols-2 lg:grid-cols-4">
      {items.map((s) => {
        const body = (
          <>
            <div className="text-[13px] text-ink-500">{s.label}</div>
            <div className={cn('mt-0.5 text-2xl font-semibold leading-8', s.tone === 'bad' && 'text-rose-700')}>{s.value}</div>
            {s.hint && <div className="text-[12px] text-ink-500">{s.hint}</div>}
          </>
        )
        if (s.to)
          return (
            <Link key={s.label} to={s.to} className={tile}>
              {body}
              {arrow}
            </Link>
          )
        if (s.onClick)
          return (
            <button key={s.label} type="button" onClick={s.onClick} className={tile}>
              {body}
              {arrow}
            </button>
          )
        return (
          <div key={s.label} className="bg-white px-4 py-3">
            {body}
          </div>
        )
      })}
    </div>
  )
}

/* ---------- table ---------- */

export const th = 'whitespace-nowrap px-4 py-2 text-left text-[13px] font-medium text-ink-500'
export const td = 'px-4 py-2.5 align-middle'

export function Table({ children }: { children: ReactNode }) {
  return (
    <div className="relative overflow-x-auto">
      <table className="w-full border-collapse text-[14px]">{children}</table>
    </div>
  )
}

export function THead({ children }: { children: ReactNode }) {
  return <thead className="border-b border-ink-100 bg-ink-50/70">{children}</thead>
}

export function TBody({ children }: { children: ReactNode }) {
  return <tbody className="divide-y divide-ink-100 [&>tr]:transition-colors [&>tr:hover]:bg-ink-50/80">{children}</tbody>
}

/* ---------- controls ---------- */

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost'

const buttonVariants: Record<Variant, string> = {
  primary: 'bg-ink-900 text-white hover:bg-ink-700 disabled:bg-ink-300',
  secondary: 'border border-ink-200 bg-white text-ink-800 hover:bg-ink-50 disabled:text-ink-300',
  danger: 'bg-rose-700 text-white hover:bg-rose-800 disabled:bg-rose-300',
  ghost: 'text-ink-700 hover:bg-ink-100 disabled:text-ink-300',
}

export function Button({
  variant = 'primary',
  busy,
  className,
  children,
  disabled,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; busy?: boolean }) {
  return (
    <button
      {...props}
      disabled={disabled || busy}
      className={cn(
        'inline-flex h-9 shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-md px-3.5 text-[14px] font-medium transition-[background-color,transform] enabled:active:translate-y-px disabled:cursor-not-allowed',
        buttonVariants[variant],
        className,
      )}
    >
      {busy && <Loader2 className="size-4 animate-spin" aria-hidden />}
      {children}
    </button>
  )
}

export const inputCls =
  'h-9 w-full rounded-md border border-ink-200 bg-white px-3 text-[14px] text-ink-900 placeholder:text-ink-400 disabled:bg-ink-50 disabled:text-ink-400'

/** A filter drop-down beside a search box: the same look, but only as wide as its choices. */
export const filterSelectCls = inputCls.replace('w-full ', 'w-auto min-w-40 ')

/** A time-of-day input: the same look, but only as wide as a time needs. */
export const timeInputCls = inputCls.replace('w-full ', 'w-[8.5rem] ')

/* ---------- badges ---------- */

type Tone = 'neutral' | 'good' | 'warn' | 'bad' | 'brass'

const badgeTones: Record<Tone, string> = {
  neutral: 'bg-ink-100 text-ink-700 ring-ink-200',
  good: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
  warn: 'bg-amber-50 text-amber-800 ring-amber-200',
  bad: 'bg-rose-50 text-rose-800 ring-rose-200',
  brass: 'bg-brass-100 text-brass-700 ring-brass-300',
}

export function Badge({ tone = 'neutral', dot, children }: { tone?: Tone; /** a small coloured dot before the words */ dot?: boolean; children: ReactNode }) {
  return (
    <span
      className={cn(
        'inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-[12px] font-medium ring-1 ring-inset',
        badgeTones[tone],
      )}
    >
      {dot && <span className="mr-1.5 size-1.5 shrink-0 rounded-full bg-current opacity-70" aria-hidden />}
      {children}
    </span>
  )
}

/* ---------- states ---------- */

/** A grey block that shimmers while the real content loads. */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('skeleton rounded-md', className)} aria-hidden />
}

/** Shown while data loads. With `rows`, grey bars hint at the shape of the table that is coming. */
export function Loading({ label = 'Loading', rows = 0 }: { label?: string; rows?: number }) {
  if (rows <= 0) {
    return (
      <div className="flex items-center gap-2 px-4 py-10 text-ink-500" role="status">
        <Loader2 className="size-4 animate-spin" aria-hidden />
        {label}
      </div>
    )
  }
  const widths = ['w-full', 'w-[92%]', 'w-[97%]', 'w-[86%]', 'w-[94%]']
  return (
    <div role="status" className="px-4 py-4">
      <div className="mb-3 flex items-center gap-2 text-ink-500">
        <Loader2 className="size-4 animate-spin" aria-hidden />
        {label}
      </div>
      <div className="space-y-2.5" aria-hidden>
        {Array.from({ length: rows }, (_, i) => (
          <Skeleton key={i} className={cn('h-8', widths[i % widths.length])} />
        ))}
      </div>
    </div>
  )
}

export function ErrorNote({ error, onRetry }: { error: unknown; /** shows a Try again button */ onRetry?: () => void }) {
  const message = error instanceof Error ? error.message : 'Something went wrong.'
  return (
    <div className="flex items-start gap-2 rounded-md border border-rose-200 bg-rose-50 px-3 py-2.5 text-rose-800" role="alert">
      <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="font-medium">Could not load this data</div>
        <div className="text-[13px]">{message}</div>
      </div>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="shrink-0 rounded-md border border-rose-300 bg-white px-2.5 py-1 text-[13px] font-medium text-rose-800 transition-colors hover:bg-rose-100"
        >
          Try again
        </button>
      )}
    </div>
  )
}

export function EmptyState({
  title,
  children,
  icon,
  art,
  action,
}: {
  title: string
  children?: ReactNode
  /** a lucide icon element shown above the title */
  icon?: ReactNode
  /** which small drawing to show when there is no icon (an empty hook by default) */
  art?: ArtKind
  action?: ReactNode
}) {
  return (
    <div className="px-4 py-9 text-center">
      {icon ? (
        <div className="mx-auto mb-3 grid size-10 place-items-center rounded-full bg-ink-100 text-ink-500 [&>svg]:size-5" aria-hidden>
          {icon}
        </div>
      ) : (
        <EmptyArt kind={art} />
      )}
      <div className="font-display text-[17px] font-semibold">{title}</div>
      {children && <div className="mx-auto mt-1 max-w-[52ch] text-ink-500">{children}</div>}
      {action && <div className="mt-4 flex justify-center gap-2">{action}</div>}
    </div>
  )
}

/** Inline outcome message after an action. With `onDismiss` the person can close it. */
export function Notice({ tone, children, onDismiss }: { tone: 'good' | 'warn' | 'bad'; children: ReactNode; onDismiss?: () => void }) {
  const Icon = tone === 'good' ? CheckCircle2 : tone === 'warn' ? AlertTriangle : AlertCircle
  return (
    <div
      role={tone === 'bad' ? 'alert' : 'status'}
      className={cn(
        'notice-in mb-4 flex items-start gap-2 rounded-md border px-3 py-2 text-[14px]',
        tone === 'good' && 'border-emerald-200 bg-emerald-50 text-emerald-900',
        tone === 'warn' && 'border-amber-200 bg-amber-50 text-amber-950',
        tone === 'bad' && 'border-rose-200 bg-rose-50 text-rose-900',
      )}
    >
      <Icon className={cn('mt-0.5 size-4 shrink-0', tone === 'good' && 'text-emerald-600', tone === 'warn' && 'text-amber-600', tone === 'bad' && 'text-rose-600')} aria-hidden />
      <div className="min-w-0 flex-1">{children}</div>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss message"
          className="-mr-1 grid size-6 shrink-0 place-items-center rounded text-current opacity-60 transition-opacity hover:opacity-100"
        >
          <X className="size-4" aria-hidden />
        </button>
      )}
    </div>
  )
}
