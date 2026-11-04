import { useMemo } from 'react'
import { cn } from '@/lib/cn'
import { STATUS_LABEL } from '@/lib/format'
import {
  buildSheet,
  cellText,
  hourLabel,
  isFinal,
  legendCell,
  legendColumns,
  meetingLabel,
  tintIndex,
  VIEW_LABEL,
  type Group,
  type TimetableView,
} from '@/lib/timetable'

/** Pixels per hour. 40 keeps a full 7 AM to 8 PM week on one landscape page. */
const HOUR_PX = 40

/** Pastel fills with dark text, so a black-and-white printout stays readable and a colour one is easy to scan. */
const TINTS = [
  { bg: '#e3edfb', bd: '#7da3dd' },
  { bg: '#e2f3e8', bd: '#6dbb8a' },
  { bg: '#fdf0d5', bd: '#d9a441' },
  { bg: '#f7e1e8', bd: '#d98aa3' },
  { bg: '#e9e4f7', bd: '#9a8bd6' },
  { bg: '#dff3f2', bd: '#5fb6b1' },
  { bg: '#fbe6d9', bd: '#df9468' },
  { bg: '#eceff3', bd: '#9aa7b8' },
]

export interface SheetProps {
  group: Group
  view: TimetableView
  school: string
  term: string
  printedOn: string
}

/**
 * One printable page: the week as a picture, then the same meetings as a list (the list is what a screen
 * reader reads, and what you check a printout against). The same component is used on screen and for print.
 */
export function TimetableSheet({ group, view, school, term, printedOn }: SheetProps) {
  const sheet = useMemo(() => buildSheet(group.meetings), [group.meetings])
  const final = isFinal(group.meetings)
  const cols = legendColumns(view)
  const gridCols = `54px repeat(${sheet.columns.length}, minmax(0, 1fr))`
  const height = sheet.hours.length * HOUR_PX

  return (
    <article className="timetable-sheet print-exact rounded-lg border border-ink-200 bg-white p-4 sm:p-5" aria-label={`Timetable: ${group.label}`}>
      <header className="mb-3 flex flex-wrap items-start justify-between gap-x-6 gap-y-2 border-b-2 border-ink-900 pb-2">
        <div className="min-w-0">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-500">{school} · Weekly class timetable</div>
          <h2 className="text-[22px] font-semibold leading-tight">{group.label}</h2>
          <div className="text-[13px] text-ink-600">
            {VIEW_LABEL[view]}
            {group.sub ? ` · ${group.sub}` : ''}
          </div>
        </div>
        <div className="text-right text-[12px] leading-snug text-ink-600">
          <div className="text-[13px] font-semibold text-ink-900">{term}</div>
          <div>
            {group.meetings.length} meeting{group.meetings.length === 1 ? '' : 's'} · {group.hours} hour{group.hours === 1 ? '' : 's'} a week
          </div>
          <div className={cn(!final && 'font-semibold text-amber-800')}>
            {final ? 'Final: all meetings are published' : 'NOT FINAL: includes meetings that are not published yet'}
          </div>
          <div>Printed {printedOn}</div>
        </div>
      </header>

      <div className="overflow-x-auto">
        <div className="min-w-[640px]">
          <div className="grid border border-b-0 border-ink-300 bg-ink-50" style={{ gridTemplateColumns: gridCols }}>
            <div />
            {sheet.columns.map((c) => (
              <div key={c.day} className="border-l border-ink-300 px-1 py-1 text-center text-[12px] font-semibold text-ink-800">
                {c.label}
              </div>
            ))}
          </div>

          <div className="grid border border-ink-300" style={{ gridTemplateColumns: gridCols, height }}>
            <div className="relative">
              {sheet.hours.map((h, i) => (
                <div key={h} className="absolute right-1.5 text-[10px] leading-none text-ink-500" style={{ top: i * HOUR_PX + 3 }}>
                  {hourLabel(h)}
                </div>
              ))}
            </div>

            {sheet.columns.map((c) => (
              <div key={c.day} className="relative border-l border-ink-300">
                {sheet.hours.map((h, i) => (
                  <div key={h} className="absolute inset-x-0 border-t border-ink-200" style={{ top: i * HOUR_PX, display: i === 0 ? 'none' : undefined }} />
                ))}
                {c.blocks.map(({ item: m, lane, lanes, topPct, heightPct }) => {
                  const tint = TINTS[tintIndex(m.courseCode, TINTS.length)]
                  const text = cellText(m, view)
                  const label = meetingLabel(m)
                  return (
                    <div
                      key={m.id}
                      title={label}
                      aria-label={label}
                      className="absolute overflow-hidden rounded-[3px] border border-l-[3px] px-1 py-0.5 text-[10px] leading-[1.2] text-ink-950"
                      style={{
                        top: `calc(${topPct}% + 1px)`,
                        height: `calc(${heightPct}% - 2px)`,
                        left: `calc(${(lane / lanes) * 100}% + 1px)`,
                        width: `calc(${100 / lanes}% - 2px)`,
                        background: tint.bg,
                        borderColor: tint.bd,
                        borderLeftColor: tint.bd,
                        // a meeting that is not published yet gets a dashed edge, so it still shows on a black-and-white printout
                        borderStyle: m.status === 'published' ? 'solid' : 'dashed',
                      }}
                    >
                      <div className="truncate text-[11px] font-semibold">{text.title}</div>
                      {text.lines.map((l, i) => (
                        <div key={i} className="truncate">
                          {l}
                        </div>
                      ))}
                    </div>
                  )
                })}
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="mt-3 overflow-x-auto">
        <table className="w-full border-collapse text-[12px]">
          <caption className="sr-only">Meetings of {group.label}</caption>
          <thead>
            <tr className="border-b border-ink-300 text-left text-ink-600">
              {cols.map((c) => (
                <th key={c.key} scope="col" className="whitespace-nowrap px-2 py-1 font-semibold">
                  {c.header}
                </th>
              ))}
              {!final && (
                <th scope="col" className="whitespace-nowrap px-2 py-1 font-semibold">
                  Status
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {group.meetings.map((m) => (
              <tr key={m.id} className="border-b border-ink-100" style={{ breakInside: 'avoid' }}>
                {cols.map((c) => (
                  <td key={c.key} className="px-2 py-1 align-top">
                    {legendCell(m, c.key)}
                  </td>
                ))}
                {!final && <td className="px-2 py-1 align-top">{STATUS_LABEL[m.status]}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </article>
  )
}
