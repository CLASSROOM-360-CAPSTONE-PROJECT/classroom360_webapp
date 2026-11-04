import { useMemo, useState } from 'react'
import { Rows3, ScrollText } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { useAuth } from '@/auth/AuthProvider'
import { ResultNote, SearchInput, Segmented, SortTh, useSort } from '@/components/controls'
import { Panel } from '@/components/surfaces'
import { Badge, Button, EmptyState, ErrorNote, filterSelectCls, Loading, Table, TBody, td, th, THead } from '@/components/ui'
import { useStoredState } from '@/hooks/useStoredState'
import { unwrap } from '@/lib/api'
import { cn } from '@/lib/cn'
import { supabase } from '@/lib/supabase'
import { matchesQuery, sortRows } from '@/lib/tableView'
import { ACTION_LABEL, auditDetail, auditTone, type AuditTone } from '@/lib/auditText'
import { fmtDateTime } from '@/lib/time'
import type { AuditRow } from '@/lib/types'

const DOT: Record<AuditTone, string> = {
  neutral: 'bg-ink-400',
  good: 'bg-emerald-500',
  warn: 'bg-amber-500',
  bad: 'bg-rose-500',
  brass: 'bg-brass-500',
}

/** "2026-11-04": the calendar day of a moment, in the school's own time zone. */
const dayKey = (iso: string, tz: string) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso))
const timeOf = (iso: string, tz: string) => new Intl.DateTimeFormat('en-PH', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(new Date(iso)).toUpperCase()
const noon = (key: string) => new Date(`${key}T12:00:00Z`)
const dayWord = (key: string, part: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-PH', { timeZone: 'UTC', ...part }).format(noon(key))

const initials = (name: string | null | undefined, email: string | null | undefined) => {
  const words = (name || email || '').replace(/@.*/, '').split(/[\s._-]+/).filter(Boolean)
  if (words.length === 0) return 'SY'
  return ((words[0]?.[0] ?? '') + (words.length > 1 ? (words[words.length - 1]?.[0] ?? '') : '')).toUpperCase()
}

/** Changes per day over the last two weeks, as bars on a dark plate: a quiet stretch or a busy one is obvious at a glance. */
function ActivityPlate({ rows, tz }: { rows: AuditRow[]; tz: string }) {
  const today = dayKey(new Date().toISOString(), tz)
  const days = Array.from({ length: 14 }, (_, i) => {
    const key = new Date(noon(today).getTime() - (13 - i) * 86_400_000).toISOString().slice(0, 10)
    return { key, n: rows.filter((r) => dayKey(r.created_at, tz) === key).length }
  })
  const top = Math.max(1, ...days.map((d) => d.n))
  const total = days.reduce((n, d) => n + d.n, 0)
  return (
    <div className="w-full max-w-[340px] rounded-lg bg-ink-900 p-3.5 text-white shadow-[0_16px_28px_-22px_rgb(11_21_36/0.7)] ring-1 ring-ink-700">
      <div className="flex items-baseline justify-between gap-3">
        <p className="font-display text-[15px] font-semibold">Past 14 days</p>
        <p className="text-[12.5px] text-ink-300">{total === 1 ? '1 change' : `${total} changes`}</p>
      </div>
      <div role="img" aria-label={`Changes each day over the past 14 days: ${days.map((d) => d.n).join(', ')}`} className="mt-3 flex h-14 items-end gap-1">
        {days.map((d, i) => (
          <span key={d.key} title={`${dayWord(d.key, { weekday: 'short', month: 'short', day: 'numeric' })}: ${d.n}`} className="flex h-full flex-1 items-end">
            <span
              className={cn('w-full rounded-t-[3px]', d.n === 0 ? 'bg-ink-700' : i === 13 ? 'bg-brass-300' : 'bg-brass-500')}
              style={{ height: d.n === 0 ? '3px' : `${Math.max(12, (d.n / top) * 100)}%` }}
            />
          </span>
        ))}
      </div>
      <div className="mt-1.5 flex justify-between text-[11px] text-ink-400" aria-hidden>
        <span>{dayWord(days[0]!.key, { month: 'short', day: 'numeric' })}</span>
        <span>Today</span>
      </div>
    </div>
  )
}

/** One change on the rail: the time on the left, a dot coloured by what kind of change it was, then who, what and why. */
function Entry({ r, tz }: { r: AuditRow; tz: string }) {
  const name = r.profiles?.full_name || r.profiles?.email
  return (
    <li className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-3 sm:grid-cols-[5.25rem_minmax(0,1fr)] sm:gap-x-4">
      <time dateTime={r.created_at} className="pt-[13px] text-right text-[12.5px] tabular-nums leading-5 text-ink-500">
        {timeOf(r.created_at, tz)}
      </time>
      <div className="relative border-l border-ink-200 pb-5 pl-5 pt-2.5">
        <span aria-hidden className={cn('absolute -left-[5px] top-[18px] size-[9px] rounded-full ring-4 ring-white', DOT[auditTone(r.action)])} />
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
          <span aria-hidden className="grid size-6 shrink-0 place-items-center rounded-full bg-ink-100 text-[10px] font-semibold tracking-wide text-ink-700 ring-1 ring-ink-200">
            {initials(r.profiles?.full_name, r.profiles?.email)}
          </span>
          <span className={cn('font-medium', !name && 'text-ink-500')}>{name || 'System'}</span>
          <Badge tone={auditTone(r.action)}>{ACTION_LABEL[r.action] ?? r.action}</Badge>
        </div>
        <p className="mt-1.5 max-w-[78ch] text-[14px] text-ink-700">{auditDetail(r)}</p>
        {r.justification && (
          <p className="mt-2 max-w-[78ch] border-l-2 border-brass-300 bg-brass-50/70 py-1 pl-3 pr-2 text-[13px] text-ink-700">
            <span className="font-medium text-brass-800">Reason given: </span>
            {r.justification}
          </p>
        )}
      </div>
    </li>
  )
}

/** The changes grouped under the day they happened, newest day first, like the pages of a logbook. */
function Logbook({ rows, tz }: { rows: AuditRow[]; tz: string }) {
  const today = dayKey(new Date().toISOString(), tz)
  const yesterday = new Date(noon(today).getTime() - 86_400_000).toISOString().slice(0, 10)
  const days: { key: string; rows: AuditRow[] }[] = []
  for (const r of [...rows].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())) {
    const key = dayKey(r.created_at, tz)
    const last = days[days.length - 1]
    if (last && last.key === key) last.rows.push(r)
    else days.push({ key, rows: [r] })
  }
  return (
    <div>
      {days.map((d) => (
        <section key={d.key} aria-label={dayWord(d.key, { weekday: 'long', month: 'long', day: 'numeric' })}>
          <div className="flex items-center gap-3 border-y border-ink-100 bg-ink-50/80 px-4 py-2 first:border-t-0">
            <span aria-hidden className="w-[2.6rem] text-center font-display text-[30px] font-semibold leading-none">
              {dayWord(d.key, { day: 'numeric' })}
            </span>
            <h2 className="text-[14px] font-medium">
              {dayWord(d.key, { weekday: 'long' })}, {dayWord(d.key, { month: 'long' })}
              {d.key === today ? <span className="ml-2 rounded-sm bg-ink-900 px-1.5 py-px text-[11.5px] font-semibold text-white">Today</span> : d.key === yesterday ? <span className="ml-2 text-[12.5px] font-normal text-ink-500">Yesterday</span> : null}
            </h2>
            <span className="ml-auto text-[12.5px] text-ink-500">{d.rows.length === 1 ? '1 change' : `${d.rows.length} changes`}</span>
          </div>
          <ol className="px-4 pt-2.5 sm:pr-6">
            {d.rows.map((r) => (
              <Entry key={r.id} r={r} tz={tz} />
            ))}
          </ol>
        </section>
      ))}
    </div>
  )
}

export default function AuditLog() {
  const { profile } = useAuth()
  const tz = profile?.tenants?.timezone ?? 'Asia/Manila'
  const [search, setSearch] = useState('')
  const [action, setAction] = useState('')
  const [within, setWithin] = useState<'all' | 'day' | 'week'>('all')
  const sort = useSort<'when' | 'who' | 'action'>('when', 'desc')
  const [layout, setLayout] = useStoredState('c360.audit.layout', 'log', ['log', 'table'] as const)
  const q = useQuery({
    queryKey: ['audit'],
    queryFn: () =>
      unwrap<AuditRow[]>(
        supabase
          .from('audit_logs')
          .select('id, created_at, action, table_name, record_id, justification, old_data, new_data, profiles(full_name, email)')
          .order('created_at', { ascending: false })
          .limit(200),
      ),
  })

  const all = q.data ?? []
  const filtering = Boolean(search.trim()) || action !== '' || within !== 'all'
  const actionsPresent = useMemo(() => [...new Set(all.map((r) => r.action))].sort((a, b) => (ACTION_LABEL[a] ?? a).localeCompare(ACTION_LABEL[b] ?? b)), [all])
  const who = (r: AuditRow) => r.profiles?.full_name || r.profiles?.email || 'System'
  const list = useMemo(() => {
    const since = within === 'all' ? 0 : Date.now() - (within === 'day' ? 1 : 7) * 86_400_000
    const kept = all.filter(
      (r) =>
        (!action || r.action === action) &&
        (since === 0 || new Date(r.created_at).getTime() >= since) &&
        matchesQuery(`${who(r)} ${ACTION_LABEL[r.action] ?? r.action} ${auditDetail(r)} ${r.justification ?? ''}`, search),
    )
    const get = {
      when: (r: AuditRow) => new Date(r.created_at).getTime(),
      who: (r: AuditRow) => who(r),
      action: (r: AuditRow) => ACTION_LABEL[r.action] ?? r.action,
    }[sort.key ?? 'when']
    return sortRows(kept, get, sort.key ? sort.dir : 'desc')
  }, [all, action, within, search, sort.key, sort.dir])

  return (
    <>
      <header className="mb-7 flex flex-wrap items-start justify-between gap-x-10 gap-y-5">
        <div className="min-w-0 max-w-[60ch]">
          <h1 className="font-display text-[34px] font-semibold leading-none tracking-[-0.02em]">Audit log</h1>
          <p className="mt-2 text-ink-500">Who changed what, and why. Approvals, returns, overrides and changes to rooms, lockers, cards and people are recorded here and cannot be edited.</p>
          {all.length > 0 && (
            <dl className="mt-4 flex flex-wrap gap-x-7 gap-y-2">
              {[
                { label: 'Latest changes kept', value: all.length },
                { label: 'In the past day', value: all.filter((r) => Date.now() - new Date(r.created_at).getTime() < 86_400_000).length },
                { label: 'People who made them', value: new Set(all.map((r) => who(r))).size },
              ].map((f) => (
                <div key={f.label} className="flex flex-col-reverse">
                  <dt className="text-[12.5px] leading-4 text-ink-500">{f.label}</dt>
                  <dd className="font-display text-[26px] font-semibold leading-8">{f.value}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
        {all.length > 0 && <ActivityPlate rows={all} tz={tz} />}
      </header>
      {all.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <SearchInput value={search} onChange={setSearch} label="Search the audit log" placeholder="Search person, action, reason" className="w-full sm:w-80" shortcut />
          <Segmented
            label="Show changes from"
            value={within}
            onChange={setWithin}
            options={[
              { value: 'all', label: 'All' },
              { value: 'day', label: 'Past day' },
              { value: 'week', label: 'Past week' },
            ]}
          />
          <select value={action} onChange={(e) => setAction(e.target.value)} aria-label="Action" className={filterSelectCls}>
            <option value="">All actions</option>
            {actionsPresent.map((a) => (
              <option key={a} value={a}>
                {ACTION_LABEL[a] ?? a}
              </option>
            ))}
          </select>
          {filtering && <ResultNote shown={list.length} total={all.length} noun={['change', 'changes']} />}
          <Segmented
            label="Audit log layout"
            value={layout}
            onChange={setLayout}
            className="ml-auto"
            options={[
              {
                value: 'log',
                label: (
                  <>
                    <ScrollText className="size-4" aria-hidden />
                    Logbook
                  </>
                ),
              },
              {
                value: 'table',
                label: (
                  <>
                    <Rows3 className="size-4" aria-hidden />
                    Table
                  </>
                ),
              },
            ]}
          />
        </div>
      )}
      <Panel title={layout === 'log' ? 'Logbook' : 'Every change'} description={layout === 'log' ? 'Newest day first. Entries are written by the system and cannot be edited or removed.' : 'Sort by a column heading.'} flush>
        {q.isLoading ? (
          <Loading rows={6} />
        ) : q.error ? (
          <div className="p-4">
            <ErrorNote error={q.error} onRetry={() => void q.refetch()} />
          </div>
        ) : all.length === 0 ? (
          <EmptyState title="Nothing recorded yet">Changes made in Classroom360 will be listed here.</EmptyState>
        ) : list.length === 0 ? (
          <EmptyState
            title="No change matches"
            action={
              <Button
                variant="secondary"
                onClick={() => {
                  setSearch('')
                  setAction('')
                  setWithin('all')
                }}
              >
                Clear search and filters
              </Button>
            }
          >
            Try a different word, action or time range.
          </EmptyState>
        ) : layout === 'log' ? (
          <Logbook rows={list} tz={tz} />
        ) : (
          <Table>
            <THead>
              <tr>
                <SortTh label="When" k="when" sort={sort} />
                <SortTh label="Who" k="who" sort={sort} />
                <SortTh label="Action" k="action" sort={sort} />
                <th className={th}>What</th>
                <th className={th}>Reason given</th>
              </tr>
            </THead>
            <TBody>
              {list.map((r) => (
                <tr key={r.id}>
                  <td className={`${td} whitespace-nowrap`}>{fmtDateTime(r.created_at, tz)}</td>
                  <td className={td}>{r.profiles?.full_name || r.profiles?.email || <span className="text-ink-400">System</span>}</td>
                  <td className={td}>
                    <Badge tone={auditTone(r.action)}>{ACTION_LABEL[r.action] ?? r.action}</Badge>
                  </td>
                  <td className={td}>{auditDetail(r)}</td>
                  <td className={`${td} max-w-[320px]`}>{r.justification ?? <span className="text-ink-400">None</span>}</td>
                </tr>
              ))}
            </TBody>
          </Table>
        )}
      </Panel>
      {all.length >= 200 && <p className="mt-3 text-[13px] text-ink-500">Showing the latest 200 changes.</p>}
    </>
  )
}
