import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronDown, ChevronUp, ChevronsUpDown, Search, X } from 'lucide-react'
import { cn } from '@/lib/cn'
import { inputCls, th } from '@/components/ui'
import type { SortDir } from '@/lib/tableView'

/* ---------- search ---------- */

/**
 * A search box with a magnifier and a clear button. With `shortcut`, pressing "/" anywhere on the page (outside a field or
 * an open window) jumps into it. Use `shortcut` on one box per page.
 */
export function SearchInput({
  value,
  onChange,
  label,
  placeholder,
  className,
  shortcut,
}: {
  value: string
  onChange: (value: string) => void
  /** read out for the box, and shown inside it when there is no placeholder */
  label: string
  placeholder?: string
  className?: string
  shortcut?: boolean
}) {
  const ref = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!shortcut) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return
      if (document.querySelector('dialog[open]')) return
      e.preventDefault()
      ref.current?.focus()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [shortcut])

  return (
    <div className={cn('relative', className)}>
      <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-400" aria-hidden />
      <input
        ref={ref}
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && value) {
            e.preventDefault()
            onChange('')
          }
        }}
        placeholder={placeholder ?? label}
        aria-label={label}
        className={cn(inputCls, 'pl-9 pr-9 [&::-webkit-search-cancel-button]:appearance-none')}
      />
      {value ? (
        <button
          type="button"
          onClick={() => {
            onChange('')
            ref.current?.focus()
          }}
          aria-label="Clear search"
          className="absolute right-1.5 top-1/2 grid size-6 -translate-y-1/2 place-items-center rounded text-ink-400 transition-colors hover:bg-ink-100 hover:text-ink-800"
        >
          <X className="size-4" aria-hidden />
        </button>
      ) : shortcut ? (
        <kbd
          className="pointer-events-none absolute right-2.5 top-1/2 hidden -translate-y-1/2 rounded border border-ink-200 bg-ink-50 px-1.5 text-[11px] font-medium leading-4 text-ink-400 sm:block"
          aria-hidden
        >
          /
        </kbd>
      ) : null}
    </div>
  )
}

/* ---------- filter chips ---------- */

export interface SegmentOption<T extends string> {
  value: T
  label: ReactNode
  /** how many rows the choice would show */
  count?: number
}

/** A row of choices where one is picked: a filter such as All / In service / Out of service. */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
  className,
}: {
  value: T
  onChange: (value: T) => void
  options: SegmentOption<T>[]
  /** read out for the group, for example "Show rooms" */
  label: string
  className?: string
}) {
  return (
    <div role="group" aria-label={label} className={cn('inline-flex max-w-full flex-wrap gap-0.5 rounded-lg bg-ink-100 p-0.5', className)}>
      {options.map((o) => {
        const on = o.value === value
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(o.value)}
            className={cn(
              'inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-md px-3 text-[13px] font-medium transition-[background-color,color,box-shadow]',
              on ? 'bg-white text-ink-900 shadow-[0_0_0_1px_var(--color-ink-200),0_1px_2px_rgb(11_21_36/0.06)]' : 'text-ink-600 hover:bg-white/60 hover:text-ink-900',
            )}
          >
            {o.label}
            {o.count !== undefined && <span className={cn('text-[12px] tabular-nums', on ? 'text-ink-500' : 'text-ink-400')}>{o.count}</span>}
          </button>
        )
      })}
    </div>
  )
}

/** "5 of 12 rooms" under a filtered list; read out politely when it changes. */
export function ResultNote({ shown, total, noun }: { shown: number; total: number; noun: readonly [string, string] }) {
  return (
    <p className="text-[13px] text-ink-500" aria-live="polite">
      {shown === total ? `${total} ${total === 1 ? noun[0] : noun[1]}` : `${shown} of ${total} ${total === 1 ? noun[0] : noun[1]}`}
    </p>
  )
}

/* ---------- sortable column headings ---------- */

export interface SortState<K extends string> {
  key: K | null
  dir: SortDir
  /** sort by this column; pressing it again reverses the order */
  toggle: (key: K) => void
}

export function useSort<K extends string>(initialKey: K | null = null, initialDir: SortDir = 'asc'): SortState<K> {
  const [state, setState] = useState<{ key: K | null; dir: SortDir }>({ key: initialKey, dir: initialDir })
  const toggle = useCallback((key: K) => setState((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' })), [])
  return { key: state.key, dir: state.dir, toggle }
}

/** A column heading that sorts the table when pressed. */
export function SortTh<K extends string>({ label, k, sort, className }: { label: ReactNode; k: K; sort: SortState<K>; className?: string }) {
  const on = sort.key === k
  const Icon = !on ? ChevronsUpDown : sort.dir === 'asc' ? ChevronUp : ChevronDown
  return (
    <th className={cn(th, className)} aria-sort={on ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button
        type="button"
        onClick={() => sort.toggle(k)}
        className={cn('-mx-1.5 inline-flex items-center gap-1 rounded px-1.5 py-0.5 transition-colors hover:bg-ink-100 hover:text-ink-900', on && 'text-ink-900')}
      >
        {label}
        <Icon className={cn('size-3.5', on ? 'text-ink-700' : 'text-ink-300')} aria-hidden />
      </button>
    </th>
  )
}

/** A small keyboard key drawn inline, for hints such as "Press Ctrl K". */
export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-ink-200 bg-ink-50 px-1.5 text-[11px] font-medium leading-4 text-ink-500">{children}</kbd>
}
