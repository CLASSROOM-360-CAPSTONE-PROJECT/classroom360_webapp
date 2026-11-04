import { useEffect, useMemo, useRef, useState } from 'react'
import { CornerDownLeft, Search, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/cn'
import { matchesQuery } from '@/lib/tableView'

export interface PaletteItem {
  id: string
  label: string
  /** words that also find it */
  keywords?: string
  icon: LucideIcon
  run: () => void
}

/**
 * The "Jump to" window (Ctrl or Cmd + K): type a few letters, press Enter. It lists only what the signed-in role can open.
 * Built on the native <dialog>, so Escape and focus handling come for free.
 */
export function CommandPalette({ open, onClose, items }: { open: boolean; onClose: () => void; items: PaletteItem[] }) {
  const ref = useRef<HTMLDialogElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)

  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) {
      setQuery('')
      setActive(0)
      d.showModal()
    }
    if (!open && d.open) d.close()
  }, [open])

  const shown = useMemo(() => items.filter((i) => matchesQuery(`${i.label} ${i.keywords ?? ''}`, query)), [items, query])
  const current = Math.min(active, Math.max(shown.length - 1, 0))

  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [current, shown.length])

  const choose = (item: PaletteItem | undefined) => {
    if (!item) return
    onClose()
    item.run()
  }

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose()
      }}
      aria-label="Jump to a page"
      className="mx-auto mt-[12vh] max-h-[70vh] w-[min(520px,calc(100vw-32px))] overflow-hidden rounded-lg border border-ink-200 bg-white p-0 text-ink-900 shadow-xl"
    >
      <div className="flex items-center gap-2 border-b border-ink-100 px-3">
        <Search className="size-4 shrink-0 text-ink-400" aria-hidden />
        <input
          autoFocus
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setActive(0)
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setActive(shown.length ? (current + 1) % shown.length : 0)
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setActive(shown.length ? (current - 1 + shown.length) % shown.length : 0)
            } else if (e.key === 'Enter') {
              e.preventDefault()
              choose(shown[current])
            }
          }}
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
          aria-activedescendant={shown[current] ? `palette-${shown[current].id}` : undefined}
          aria-label="Jump to a page"
          placeholder="Jump to a page"
          className="h-12 w-full bg-transparent text-[15px] text-ink-900 placeholder:text-ink-400 focus:outline-none"
        />
        <kbd className="hidden shrink-0 rounded border border-ink-200 bg-ink-50 px-1.5 text-[11px] font-medium leading-4 text-ink-400 sm:block">Esc</kbd>
      </div>
      <ul ref={listRef} id="palette-list" role="listbox" aria-label="Pages" className="max-h-[calc(70vh-52px)] overflow-y-auto p-1.5">
        {shown.map((item, i) => {
          const on = i === current
          return (
            <li
              key={item.id}
              id={`palette-${item.id}`}
              role="option"
              aria-selected={on}
              onMouseMove={() => setActive(i)}
              onClick={() => choose(item)}
              className={cn('flex h-10 cursor-pointer items-center gap-3 rounded-md px-3 text-[14px]', on ? 'bg-ink-900 text-white' : 'text-ink-800')}
            >
              <item.icon className={cn('size-[18px] shrink-0', on ? 'text-brass-300' : 'text-ink-400')} aria-hidden />
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
              {on && <CornerDownLeft className="size-4 shrink-0 text-ink-300" aria-hidden />}
            </li>
          )
        })}
        {shown.length === 0 && <li className="px-3 py-6 text-center text-ink-500">No page matches “{query.trim()}”.</li>}
      </ul>
    </dialog>
  )
}
