import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { ChevronLeft, ChevronRight, Download, Printer } from 'lucide-react'
import { useAuth } from '@/auth/AuthProvider'
import { TimetableSheet } from '@/components/TimetableSheet'
import { Button, Card, EmptyState, ErrorNote, inputCls, Loading } from '@/components/ui'
import { fetchAll, usePrograms, useTerms } from '@/lib/api'
import { downloadText } from '@/lib/download'
import { supabase } from '@/lib/supabase'
import {
  filterMeetings,
  groupMeetings,
  timetableCsv,
  timetableFilename,
  toMeeting,
  VIEW_LABEL,
  type TimetableRow,
  type TimetableView,
} from '@/lib/timetable'

const COLUMNS =
  'id, program_id, instructor_id, room_id, day_of_week, start_time, end_time, status, sections(code, component, year_level, cohort, program_id, courses(code, title), programs(code)), instructors(full_name), rooms(code, name)'

/** How many sheets are drawn on screen when "All" is chosen; printing and the file always have every one. */
const SCREEN_MAX = 8

const VIEWS: TimetableView[] = ['block', 'instructor', 'room']
const PLURAL: Record<TimetableView, string> = { block: 'student blocks', instructor: 'instructors', room: 'rooms' }

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block min-w-[170px]">
      <span className="mb-1 block text-[13px] font-medium text-ink-700">{label}</span>
      {children}
    </label>
  )
}

export default function Timetables() {
  const { profile } = useAuth()
  const role = profile?.role
  const tz = profile?.tenants?.timezone ?? 'Asia/Manila'
  const school = profile?.tenants?.name ?? 'Classroom360'
  const isInstructor = role === 'instructor'

  const [params] = useSearchParams()
  const terms = useTerms()
  const programs = usePrograms()

  const [termSel, setTermSel] = useState(params.get('term') ?? '')
  const [programId, setProgramId] = useState(params.get('program') && params.get('program') !== 'all' ? (params.get('program') as string) : 'all')
  const [viewSel, setViewSel] = useState<TimetableView>('block')
  const [includeAll, setIncludeAll] = useState(false)
  const [subject, setSubject] = useState('')

  const view: TimetableView = isInstructor ? 'instructor' : viewSel
  const termId = termSel || terms.data?.find((t) => t.is_active)?.id || terms.data?.[0]?.id || ''
  const termName = terms.data?.find((t) => t.id === termId)?.name ?? ''

  const myPrograms = useMemo(
    () => (programs.data ?? []).filter((p) => role !== 'program_chair' || p.department_id === profile?.department_id),
    [programs.data, role, profile?.department_id],
  )

  const rows = useQuery({
    queryKey: ['timetable-rows', termId],
    enabled: Boolean(termId),
    queryFn: () =>
      fetchAll<TimetableRow>((from, to) =>
        supabase
          .from('schedule_entries')
          .select(COLUMNS)
          .eq('term_id', termId)
          .order('day_of_week')
          .order('start_time')
          .order('id')
          .range(from, to),
      ),
  })

  const meetings = useMemo(() => (rows.data ?? []).map(toMeeting), [rows.data])
  const shownMeetings = useMemo(
    () => filterMeetings(meetings, { include: isInstructor || !includeAll ? 'published' : 'all', programId: programId === 'all' ? null : programId }),
    [meetings, includeAll, programId, isInstructor],
  )
  const groups = useMemo(() => groupMeetings(shownMeetings, view), [shownMeetings, view])

  // what is chosen, or the first sheet when the choice no longer exists (another term, another view)
  const effective = subject === 'all' ? 'all' : groups.some((g) => g.key === subject) ? subject : (groups[0]?.key ?? '')
  const index = groups.findIndex((g) => g.key === effective)
  const current = index >= 0 ? groups[index] : null
  const sheets = effective === 'all' ? groups : current ? [current] : []
  const onScreen = sheets.slice(0, SCREEN_MAX)

  const printedOn = useMemo(
    () => new Intl.DateTimeFormat('en-PH', { timeZone: tz, dateStyle: 'medium' }).format(new Date()),
    [tz],
  )

  // the left and right arrow keys turn the page, as on the buttons beside the list
  useEffect(() => {
    if (effective === 'all' || groups.length < 2) return
    const onKey = (e: KeyboardEvent) => {
      if ((e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return
      if (document.querySelector('dialog[open]')) return
      const next = groups[index + (e.key === 'ArrowRight' ? 1 : -1)]
      if (next) setSubject(next.key)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [effective, groups, index])

  const hiddenByFilter = meetings.length - shownMeetings.length
  const fileBase = timetableFilename(view, termName, effective === 'all' ? null : (current?.label ?? null), 'csv')

  // the name of the page becomes the suggested name of the PDF, so it is put back when printing is over
  function print() {
    const saved = document.title
    document.title = fileBase.replace(/\.csv$/, '')
    const restore = () => {
      document.title = saved
      window.removeEventListener('afterprint', restore)
    }
    window.addEventListener('afterprint', restore)
    window.print()
  }

  function download() {
    downloadText(fileBase, timetableCsv(sheets, view))
  }

  return (
    <>
      <div className="no-print">
        <header className="mb-7 max-w-[62ch]">
          <h1 className="font-display text-[34px] font-semibold leading-none tracking-[-0.02em]">{isInstructor ? 'My timetable' : 'Timetables'}</h1>
          <p className="mt-2 text-ink-500">
            {isInstructor
              ? 'Your published classes for the term, ready to print or save.'
              : 'A page for each student block, instructor or room, to print, save as a PDF, or open in Excel.'}
          </p>
        </header>

        <div className="grid gap-8 lg:grid-cols-[272px_minmax(0,1fr)] lg:items-start">
          {/* the settings of the printout, set down the side like the ones in a print window */}
          <section aria-label="Print setup" className="rounded-lg bg-white p-4 shadow-[0_12px_22px_-18px_rgb(11_21_36/0.5)] ring-1 ring-ink-200 lg:sticky lg:top-6">
            <h2 className="font-display text-[19px] font-semibold leading-6">Print setup</h2>
            <div className="mt-4 space-y-3.5 [&_label]:min-w-0">
              <Field label="Term">
                <select value={termId} onChange={(e) => setTermSel(e.target.value)} className={inputCls}>
                  {(terms.data ?? []).map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </Field>

              {!isInstructor && (
                <>
                  <Field label="One page for each">
                    <select
                      value={view}
                      onChange={(e) => {
                        setViewSel(e.target.value as TimetableView)
                        setSubject('')
                      }}
                      className={inputCls}
                    >
                      {VIEWS.map((v) => (
                        <option key={v} value={v}>
                          {VIEW_LABEL[v]}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Program">
                    <select
                      value={programId}
                      onChange={(e) => {
                        setProgramId(e.target.value)
                        setSubject('')
                      }}
                      className={inputCls}
                    >
                      <option value="all">{role === 'program_chair' ? 'All my programs' : 'All programs'}</option>
                      {myPrograms.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.code}
                        </option>
                      ))}
                    </select>
                  </Field>
                </>
              )}

              {groups.length > 0 && (
                <Field label={`Show (${groups.length})`}>
                  <select value={effective} onChange={(e) => setSubject(e.target.value)} className={inputCls}>
                    {groups.length > 1 && <option value="all">All {PLURAL[view]} ({groups.length} pages)</option>}
                    {groups.map((g) => (
                      <option key={g.key} value={g.key}>
                        {g.label}
                        {g.sub ? `, ${g.sub}` : ''}
                      </option>
                    ))}
                  </select>
                </Field>
              )}

              {effective !== 'all' && groups.length > 1 && (
                <div className="flex items-center justify-between gap-2" role="group" aria-label="Move between pages">
                  <Button variant="secondary" className="w-9 shrink-0 px-0" aria-label="Previous page" title="Previous page (left arrow key)" disabled={index <= 0} onClick={() => setSubject(groups[index - 1].key)}>
                    <ChevronLeft className="size-4 shrink-0" aria-hidden />
                  </Button>
                  <span className="text-[13px] text-ink-500">
                    Page {index + 1} of {groups.length}
                  </span>
                  <Button variant="secondary" className="w-9 shrink-0 px-0" aria-label="Next page" title="Next page (right arrow key)" disabled={index >= groups.length - 1} onClick={() => setSubject(groups[index + 1].key)}>
                    <ChevronRight className="size-4 shrink-0" aria-hidden />
                  </Button>
                </div>
              )}

              {!isInstructor && (
                <label className="flex items-start gap-2 text-[13px] leading-[1.45] text-ink-700">
                  <input
                    type="checkbox"
                    checked={includeAll}
                    onChange={(e) => {
                      setIncludeAll(e.target.checked)
                      setSubject('')
                    }}
                    className="mt-0.5 size-4 shrink-0 accent-ink-800"
                  />
                  <span>Also include meetings that are not published yet (drafts, waiting for approval, rejected). The page is then marked NOT FINAL.</span>
                </label>
              )}
            </div>

            <div className="mt-5 grid gap-2 border-t border-ink-100 pt-4">
              <Button className="w-full" disabled={sheets.length === 0} onClick={print}>
                <Printer className="size-4" aria-hidden />
                {effective === 'all' && groups.length > 1 ? `Print all ${groups.length}` : 'Print or save PDF'}
              </Button>
              <Button variant="secondary" className="w-full" disabled={sheets.length === 0} onClick={download}>
                <Download className="size-4" aria-hidden />
                Download CSV
              </Button>
            </div>
          </section>

          {/* the preview: paper laid on a desk */}
          <div className="min-w-0">
            {rows.isLoading || terms.isLoading ? (
              <Card flush>
                <Loading rows={4} />
              </Card>
            ) : rows.error ? (
              <ErrorNote error={rows.error} onRetry={() => void rows.refetch()} />
            ) : sheets.length === 0 ? (
              <div className="rounded-lg border-2 border-dashed border-ink-300 bg-white/50">
                <EmptyState title="Nothing to print here">
                  {isInstructor
                    ? 'Your classes appear here once your program’s timetable is published.'
                    : hiddenByFilter > 0 && !includeAll
                      ? `${hiddenByFilter} meeting${hiddenByFilter === 1 ? ' is' : 's are'} not published yet. Tick “Also include meetings that are not published yet” to print them as a draft.`
                      : 'Change the term or the program, or build a timetable on the Schedules page first.'}
                </EmptyState>
              </div>
            ) : (
              <div className="rounded-xl bg-ink-200/70 p-3 ring-1 ring-ink-200 sm:p-6" data-testid="screen-sheets">
                <div className="space-y-6 [&>article]:rounded-[3px] [&>article]:border-ink-300 [&>article]:shadow-[0_2px_3px_rgb(11_21_36/0.12),0_18px_30px_-14px_rgb(11_21_36/0.45)]">
                  {onScreen.map((g) => (
                    <TimetableSheet key={g.key} group={g} view={view} school={school} term={termName} printedOn={printedOn} />
                  ))}
                </div>
                {sheets.length > onScreen.length && (
                  <p className="mt-4 text-[13px] text-ink-600">
                    Showing the first {onScreen.length} of {sheets.length} pages here. Print and Download CSV include all {sheets.length}.
                  </p>
                )}
                <p className="mt-4 text-[13px] text-ink-600">
                  To save a PDF, choose Print, then pick “Save as PDF” as the printer. Landscape paper fits the week best. Colours are only a
                  guide: meetings that are not published have a dashed edge, so they still show on a black-and-white copy.
                </p>
              </div>
            )}
          </div>
        </div>
      </div>

      {sheets.length > 0 && (
        /* the pages as they are printed: hidden on screen, the only thing shown on paper */
        <div className="print-only" data-testid="print-sheets" aria-hidden>
          {sheets.map((g) => (
            <TimetableSheet key={g.key} group={g} view={view} school={school} term={termName} printedOn={printedOn} />
          ))}
        </div>
      )}
    </>
  )
}
