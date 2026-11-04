import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CalendarCheck, CircleAlert, Loader2, Minimize2, Sparkles, Square, TriangleAlert } from 'lucide-react'
import { Modal } from '@/components/Modal'
import { PlanEditor } from '@/components/PlanEditor'
import { Button, ErrorNote, inputCls, Loading } from '@/components/ui'
import { cn } from '@/lib/cn'
import { friendlyError } from '@/lib/errors'
import { solveRunArgs } from '@/lib/evaluation/runLog'
import { onGenerateRequest, reportGenerateSaved, type GenerateRequest, type GenerateSaved } from '@/lib/generateBus'
import { runScheduler, type RunHandle } from '@/lib/scheduler/client'
import { totalMeetings } from '@/lib/scheduler/finalize'
import { loadBuildInput } from '@/lib/scheduler/load'
import { buildProblem, isReplaceable, slotTime } from '@/lib/scheduler/problem'
import type { Incumbent, Problem, Progress, SolveResult } from '@/lib/scheduler/types'
import { supabase } from '@/lib/supabase'
import { fmtTime } from '@/lib/time'
import type { Program } from '@/lib/types'

/**
 * The Generate schedule window, kept in the app's frame (see AppShell) so that closing it never loses work:
 * a click outside it, Escape or the Minimize button only hides it. A run goes on, a plan waiting to be saved is kept,
 * and an "Ongoing scheduling" button at the bottom right of every page brings the window back.
 * Only Discard, Try again, Stop-and-discard or a successful save end a session.
 */

type Stage = 'setup' | 'running' | 'review'

const TIMES = [
  { sec: 10, label: 'Quick', hint: '10 seconds' },
  { sec: 30, label: 'Standard', hint: '30 seconds' },
  { sec: 90, label: 'Thorough', hint: '90 seconds' },
] as const

// The school's own opening days and hours decide where classes may go; this can only narrow them.
const DAY_SETS = [
  { id: 'school', label: 'Every day the school is open', weekdays: null },
  { id: 'mon-fri', label: 'Monday to Friday only', weekdays: [1, 2, 3, 4, 5] },
] as const

const DAY_ABBR = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

/** "Mon–Fri 7:00 AM to 9:00 PM; Sat 8:00 AM to 12:00 PM" from the opening hours the scheduler will use */
function schoolHoursText(problem: Problem): string {
  const groups = new Map<string, number[]>()
  for (const d of problem.days) {
    const h = problem.dayHours[d]
    if (!h) continue
    const key = `${fmtTime(`${slotTime(h.open)}:00`)} to ${fmtTime(`${slotTime(h.close)}:00`)}`
    groups.set(key, [...(groups.get(key) ?? []), d])
  }
  return [...groups.entries()]
    .map(([text, days]) => {
      const runs: string[] = []
      let i = 0
      while (i < days.length) {
        let j = i
        while (j + 1 < days.length && days[j + 1] === days[j]! + 1) j++
        runs.push(j - i >= 2 ? `${DAY_ABBR[days[i]!]}–${DAY_ABBR[days[j]!]}` : days.slice(i, j + 1).map((d) => DAY_ABBR[d]).join(', '))
        i = j + 1
      }
      return `${runs.join(', ')} ${text}`
    })
    .join('; ')
}

/** instructors whose classes cannot all fit in their weekly limit or their working hours */
function instructorShortfalls(problem: Problem): string[] {
  const need = new Map<string, number>()
  for (const s of problem.sections) if (s.instructorId) need.set(s.instructorId, (need.get(s.instructorId) ?? 0) + s.toPlace * s.slots)
  const out: string[] = []
  for (const [id, slots] of need) {
    const inst = problem.instructors[id]
    if (!inst) continue
    const hoursOf = (n: number) => Math.round(n) / 2
    if (slots > inst.capSlots) {
      out.push(`${inst.name} has ${hoursOf(slots)} h of classes to place but may teach only ${hoursOf(inst.capSlots)} h more this week.`)
      continue
    }
    const blocked = problem.unavailable.filter((u) => u.instructorId === id)
    if (blocked.length === 0) continue
    let free = 0
    for (const day of problem.days) {
      const h = problem.dayHours[day]
      if (!h) continue
      const taken = new Array<boolean>(h.close - h.open).fill(false)
      for (const u of blocked) if (u.day === day) for (let t = Math.max(u.start, h.open); t < Math.min(u.end, h.close); t++) taken[t - h.open] = true
      free += taken.filter((x) => !x).length
    }
    if (slots > free) out.push(`${inst.name} has ${hoursOf(slots)} h of classes to place but works only ${hoursOf(free)} h a week inside school hours.`)
  }
  return out
}

const PHASE: Record<Progress['phase'], string> = {
  prepare: 'Preparing',
  baseline: 'Making a first plan',
  optimizing: 'Improving the plan',
  relaxing: 'Looking for the best partial schedule',
  checking: 'Checking every rule',
}

const ENGINE: Record<Incumbent['engine'], string> = {
  'first-fit': 'the quick planner',
  'local-search': 'the quick planner and local search',
  'cp-sat': 'the optimiser (Google OR-Tools CP-SAT) with local search',
}

/** "BSIT", "BSIT and BSCPE", "BSIT, BSCPE and BSEE", "5 programs" */
function programsText(list: Program[]): string {
  if (list.length === 0) return 'no program'
  if (list.length === 1) return list[0]!.code
  if (list.length <= 3) return `${list.slice(0, -1).map((p) => p.code).join(', ')} and ${list[list.length - 1]!.code}`
  return `${list.length} programs`
}

/** what a run was started with: kept as it was, so that a plan is always judged against the data it was made from */
interface Frozen {
  problem: Problem
  programs: Program[]
  termId: string
  programOf: Record<string, string>
}

/** the plan the scheduler made, the plan as it is now, and the earlier versions of it for Undo */
interface Plan {
  original: SolveResult
  current: SolveResult
  past: SolveResult[]
  note: string | null
}

export function GenerateHost() {
  const qc = useQueryClient()
  const [request, setRequest] = useState<GenerateRequest | null>(null)
  const [shown, setShown] = useState(false)
  const [ids, setIds] = useState<string[]>([])
  const [stage, setStage] = useState<Stage>('setup')
  const [seconds, setSeconds] = useState<number>(30)
  const [daySet, setDaySet] = useState<(typeof DAY_SETS)[number]['id']>('school')
  const [progress, setProgress] = useState<Progress | null>(null)
  const [firstScore, setFirstScore] = useState<number | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const [frozen, setFrozen] = useState<Frozen | null>(null)
  const [plan, setPlan] = useState<Plan | null>(null)
  const [roomId, setRoomId] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<null | 'discard' | 'again'>(null)
  const handle = useRef<RunHandle | null>(null)
  const stageRef = useRef(stage)
  useEffect(() => {
    stageRef.current = stage
  }, [stage])

  const programs = useMemo(() => request?.programs ?? [], [request])
  const chosen = useMemo(() => programs.filter((p) => ids.includes(p.id)), [programs, ids])
  const idKey = chosen.map((p) => p.id).sort().join(',')

  const input = useQuery({
    queryKey: ['generate-input', request?.termId, idKey],
    enabled: shown && stage === 'setup' && Boolean(request) && chosen.length > 0,
    gcTime: 0,
    staleTime: 0,
    queryFn: () => loadBuildInput(request!.termId, chosen.map((p) => p.id)),
  })

  const weekdays = DAY_SETS.find((d) => d.id === daySet)!.weekdays
  const problem = useMemo<Problem | null>(
    () => (input.data ? buildProblem({ ...input.data, weekdays: weekdays ? [...weekdays] : undefined }) : null),
    [input.data, weekdays],
  )

  // a page asked for the window: a fresh one starts from the programs the page names; a run or plan that is waiting is brought back as it was
  useEffect(
    () =>
      onGenerateRequest((req) => {
        if (stageRef.current === 'setup') {
          setRequest(req)
          setIds(req.initialIds.filter((id) => req.programs.some((p) => p.id === id)))
        }
        setShown(true)
      }),
    [],
  )

  // the worker blocks while it solves, so the clock is kept here
  useEffect(() => {
    if (stage !== 'running') return
    const t0 = performance.now()
    const id = window.setInterval(() => setElapsed((performance.now() - t0) / 1000), 200)
    return () => window.clearInterval(id)
  }, [stage])

  // leaving or reloading the page would lose a run or an unsaved plan: the browser asks first
  useEffect(() => {
    if (stage === 'setup') return
    const warn = (ev: BeforeUnloadEvent) => {
      ev.preventDefault()
      ev.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [stage])
  useEffect(() => () => handle.current?.stop(), [])

  const facts = useMemo(() => {
    if (!input.data || !problem) return null
    const replaceable = input.data.ownEntries.filter(isReplaceable).length
    const pinned = input.data.ownEntries.filter((e) => (e.status === 'draft' || e.status === 'returned') && e.is_pinned).length
    return {
      sections: problem.sections.length,
      meetings: totalMeetings(problem),
      rooms: problem.rooms.length,
      bookings: problem.fixed.length,
      replaceable,
      pinned,
      kept: input.data.ownEntries.length - replaceable - pinned,
      noRoom: problem.sections.filter((s) => s.roomIds.length === 0),
      noInstructor: problem.sections.filter((s) => !s.instructorId).length,
      hours: schoolHoursText(problem),
      shortfalls: instructorShortfalls(problem),
    }
  }, [input.data, problem])

  const minimize = () => setShown(false)

  /** back to an empty setup: only after Discard, Try again or a save */
  function endSession() {
    const h = handle.current
    handle.current = null
    h?.stop()
    setStage('setup')
    setFrozen(null)
    setPlan(null)
    setRoomId(null)
    setProgress(null)
    setFirstScore(null)
    setElapsed(0)
    setConfirm(null)
    save.reset()
  }

  function start() {
    if (!problem || !input.data || !request) return
    const programIds = chosen.map((p) => p.id)
    const termId = request.termId
    setFrozen({
      problem,
      programs: chosen,
      termId,
      programOf: Object.fromEntries(input.data.sections.map((s) => [s.id, s.program_id])),
    })
    setPlan(null)
    setRoomId(null)
    setConfirm(null)
    setStage('running')
    setProgress(null)
    setFirstScore(null)
    setElapsed(0)
    const h = runScheduler(
      problem,
      { timeLimitSec: seconds },
      {
        onProgress: setProgress,
        onIncumbent: (i) => setFirstScore((s) => s ?? i.softPenalty),
      },
    )
    handle.current = h
    void h.result.then((r) => {
      if (handle.current !== h) return
      handle.current = null
      logRun(r, termId, programIds)
      setPlan({ original: r, current: r, past: [], note: null })
      setStage('review')
    })
  }

  /**
   * Every finished run is written down, saved or not: the Evaluation page counts these for the
   * scheduling engine's trials (feasibility, hard-rule violations, run time). It is the scheduler's own
   * answer that is logged, before any change by hand. Best effort: a run that cannot be logged (say, the
   * database update for it has not been applied yet) must not get in the way of the plan itself.
   */
  function logRun(r: SolveResult, termId: string, programIds: string[]) {
    void supabase
      .rpc('record_solve_run', solveRunArgs(r, termId, programIds, ENGINE[r.engine]))
      .then(
        (res) => {
          if (!res.error) void qc.invalidateQueries({ queryKey: ['solver-runs'] })
        },
        () => {},
      )
  }

  const editPlan = (next: SolveResult, note: string) =>
    setPlan((p) => (p ? { ...p, current: next, past: [...p.past, p.current], note } : p))
  const undo = () =>
    setPlan((p) => (p && p.past.length > 0 ? { ...p, current: p.past[p.past.length - 1]!, past: p.past.slice(0, -1), note: 'Undid the last change.' } : p))
  const resetPlan = () =>
    setPlan((p) => (p && p.current !== p.original ? { ...p, current: p.original, past: [...p.past, p.current], note: 'Back to the plan the scheduler made.' } : p))

  const save = useMutation({
    mutationFn: async (): Promise<GenerateSaved> => {
      if (!frozen || !plan) throw new Error('Nothing to save.')
      const result = plan.current
      const entries = result.placements.map((p) => ({
        section_id: p.sectionId,
        room_id: p.roomId,
        day_of_week: p.day + 1,
        start_time: slotTime(p.start),
        end_time: slotTime(p.end),
      }))
      // which program each unplaced meeting belongs to, so every program's history says how many it could not place
      const unplacedBy: Record<string, number> = {}
      for (const u of result.unplaced) {
        const pid = frozen.programOf[u.sectionId]
        if (pid) unplacedBy[pid] = (unplacedBy[pid] ?? 0) + 1
      }
      const byHand = plan.current !== plan.original ? ' Adjusted by hand before saving.' : ''
      const note =
        (result.complete
          ? `All ${entries.length} meetings placed (${result.engine}).`
          : `${entries.length} placed, ${result.unplaced.length} could not be placed (${result.engine}).`) + byHand
      const r = await supabase.rpc('apply_generated_schedules', {
        p_term_id: frozen.termId,
        p_program_ids: frozen.programs.map((p) => p.id),
        p_entries: entries,
        p_job: {
          runtime_ms: result.runtimeMs,
          soft_penalty: result.softPenalty,
          unplaced: result.unplaced.length,
          unplaced_by_program: unplacedBy,
          message: note,
        },
      })
      if (r.error) throw new Error(r.error.message)
      const data = r.data as { replaced: number; inserted: number }
      return { inserted: data.inserted, replaced: data.replaced, unplaced: result.unplaced.length, programs: frozen.programs.map((p) => p.code) }
    },
    onSuccess: (saved) => {
      for (const key of ['schedule-entries', 'schedule-overrides', 'schedule-busy', 'schedule-review', 'audit']) {
        void qc.invalidateQueries({ queryKey: [key] })
      }
      endSession()
      setShown(false)
      reportGenerateSaved(saved)
    },
  })

  const names = programsText(stage === 'setup' ? chosen : (frozen?.programs ?? chosen))
  const title = stage === 'setup' ? `Generate schedule for ${names}` : stage === 'running' ? `Building ${names}` : `Review ${names}`
  const limit = seconds
  const pct = Math.min(100, Math.round((elapsed / limit) * 100))
  const cur = plan?.current ?? null
  const safe = cur ? cur.violations.length === 0 : false
  const improvement =
    plan && firstScore && firstScore > 0 ? Math.round(((firstScore - plan.original.softPenalty) / firstScore) * 100) : 0
  const edited = Boolean(plan && plan.current !== plan.original)

  const footer =
    stage === 'setup' ? (
      <>
        <Button variant="secondary" onClick={minimize}>
          Cancel
        </Button>
        <Button onClick={start} disabled={!problem || !facts || facts.meetings === 0 || chosen.length === 0}>
          <Sparkles className="size-4" aria-hidden />
          Generate
        </Button>
      </>
    ) : stage === 'running' ? (
      <>
        <Button variant="secondary" className="mr-auto" onClick={minimize} data-testid="minimize">
          <Minimize2 className="size-4" aria-hidden />
          Minimize
        </Button>
        <Button variant="secondary" onClick={() => handle.current?.stop()}>
          <Square className="size-3.5" aria-hidden />
          Stop and use the best so far
        </Button>
      </>
    ) : confirm ? (
      <>
        <span className="mr-auto self-center text-[14px] text-ink-800" role="alert">
          {confirm === 'discard' ? 'Throw this plan away?' : 'Make a new plan?'} {edited ? 'Your changes are lost too. ' : ''}Nothing has been saved.
        </span>
        <Button variant="secondary" onClick={() => setConfirm(null)} data-testid="confirm-no">
          Keep it
        </Button>
        <Button
          data-testid="confirm-yes"
          onClick={() => {
            const again = confirm === 'again'
            endSession()
            if (!again) setShown(false)
          }}
        >
          {confirm === 'discard' ? 'Yes, discard' : 'Yes, start again'}
        </Button>
      </>
    ) : (
      <>
        <Button variant="secondary" className="mr-auto" onClick={minimize} data-testid="minimize">
          <Minimize2 className="size-4" aria-hidden />
          Minimize
        </Button>
        <Button variant="secondary" onClick={() => setConfirm('discard')} disabled={save.isPending} data-testid="discard">
          Discard
        </Button>
        <Button variant="secondary" disabled={save.isPending} onClick={() => setConfirm('again')} data-testid="try-again">
          Try again
        </Button>
        <Button busy={save.isPending} disabled={!cur || cur.placements.length === 0 || !safe} onClick={() => save.mutate()} data-testid="save">
          Save as drafts
        </Button>
      </>
    )

  const chip =
    request && stage !== 'setup' && !shown ? (
      <button
        type="button"
        data-testid="ongoing-scheduling"
        onClick={() => setShown(true)}
        className={cn(
          'no-print fixed bottom-4 right-4 z-30 flex max-w-[calc(100vw-32px)] items-center gap-3 rounded-lg border px-4 py-2.5 text-left shadow-lg transition-colors',
          stage === 'running' ? 'border-ink-700 bg-ink-900 text-white hover:bg-ink-800' : 'border-brass-400 bg-brass-100 text-ink-900 hover:bg-brass-200',
        )}
      >
        {stage === 'running' || save.isPending ? <Loader2 className="size-5 shrink-0 animate-spin" aria-hidden /> : <CalendarCheck className="size-5 shrink-0" aria-hidden />}
        <span className="min-w-0" role="status">
          <span className="block text-[14px] font-semibold">
            {save.isPending ? 'Saving the schedule' : stage === 'running' ? 'Ongoing scheduling' : 'Schedule ready to review'}
          </span>
          <span className="block truncate text-[12.5px] opacity-80">
            {names} ·{' '}
            {stage === 'running'
              ? `${Math.min(Math.round(elapsed), limit)} of ${limit} s${progress ? ` · ${progress.placed} of ${progress.total} placed` : ''}`
              : cur
                ? `${cur.placements.length} of ${cur.placements.length + cur.unplaced.length} placed · not saved yet`
                : ''}
          </span>
        </span>
        <span className="shrink-0 text-[13px] font-medium underline underline-offset-2">Open</span>
      </button>
    ) : null

  return (
    <>
      {chip}
      {request && (
        <Modal open={shown} onClose={minimize} title={title} footer={footer} wide stickyFooter>
          {shown && stage === 'setup' && (
            <div className="space-y-4">
              {programs.length > 1 && (
                <fieldset>
                  <legend className="mb-1 text-[13px] font-medium text-ink-700">Programs to plan together</legend>
                  <div className="flex flex-wrap gap-2">
                    {programs.map((p) => {
                      const on = ids.includes(p.id)
                      return (
                        <label
                          key={p.id}
                          className={`cursor-pointer rounded-md border px-3 py-1.5 text-[14px] ${
                            on ? 'border-ink-900 bg-ink-900 text-white' : 'border-ink-200 bg-white text-ink-800 hover:bg-ink-50'
                          }`}
                        >
                          <input
                            type="checkbox"
                            className="sr-only"
                            checked={on}
                            onChange={() => setIds((cur) => (on ? cur.filter((x) => x !== p.id) : [...cur, p.id]))}
                          />
                          {p.code}
                        </label>
                      )
                    })}
                    <button
                      type="button"
                      className="px-2 text-[13px] text-ink-600 underline-offset-2 hover:underline"
                      onClick={() => setIds(ids.length === programs.length ? [] : programs.map((p) => p.id))}
                    >
                      {ids.length === programs.length ? 'Clear' : 'Select all'}
                    </button>
                  </div>
                  <p className="mt-1 text-[12.5px] text-ink-500">
                    Programs planned together share rooms and instructors without clashes. Planning one at a time can leave the second with
                    what the first left over.
                  </p>
                </fieldset>
              )}
              {chosen.length === 0 && <p className="text-[14px] text-ink-600">Choose at least one program.</p>}
              {input.isLoading && <Loading label="Reading sections, rooms and other departments’ bookings" />}
              {input.error && <ErrorNote error={input.error} />}
              {facts && problem && (
                <>
                  <p className="text-[14px] text-ink-700">
                    The scheduler places each class meeting in a room, day and time, here in your browser. It will not double-book a room,
                    an instructor or a student block, and it works around everything other departments have already booked.
                  </p>

                  <dl className="grid grid-cols-2 gap-x-6 gap-y-1 rounded-md border border-ink-200 bg-ink-50/60 px-4 py-3 text-[14px] sm:grid-cols-4">
                    <Fact label="Sections to place" value={facts.sections} />
                    <Fact label="Weekly meetings" value={facts.meetings} />
                    <Fact label="Rooms in use" value={facts.rooms} />
                    <Fact label="Fixed bookings it avoids" value={facts.bookings} />
                  </dl>

                  {facts.meetings === 0 ? (
                    <p className="rounded-md border border-ink-200 px-3 py-2 text-[14px] text-ink-700">
                      Nothing to place. {names} {chosen.length === 1 ? 'has' : 'have'} no sections for this term, or all their meetings are already submitted,
                      approved, published or pinned.
                    </p>
                  ) : (
                    <p className="text-[13px] text-ink-600">
                      {facts.replaceable > 0 ? (
                        <>
                          Saving replaces the <strong>{facts.replaceable}</strong> draft/rejected meeting{facts.replaceable === 1 ? '' : 's'} of{' '}
                          {names}.{' '}
                        </>
                      ) : (
                        <>{names} {chosen.length === 1 ? 'has' : 'have'} no draft meetings yet. </>
                      )}
                      {facts.pinned > 0 && (
                        <>
                          The <strong>{facts.pinned}</strong> pinned meeting{facts.pinned === 1 ? '' : 's'} stay{facts.pinned === 1 ? 's' : ''} where {facts.pinned === 1 ? 'it is' : 'they are'}, and the rest is planned around {facts.pinned === 1 ? 'it' : 'them'}.{' '}
                        </>
                      )}
                      {facts.kept > 0 && (
                        <>
                          The {facts.kept} submitted, approved or published meeting{facts.kept === 1 ? '' : 's'} stay{facts.kept === 1 ? 's' : ''} as they are.{' '}
                        </>
                      )}
                      Nothing is saved until you press Save.
                    </p>
                  )}

                  {facts.noRoom.length > 0 && (
                    <Warning>
                      <strong>No suitable room</strong> for {facts.noRoom.map((s) => s.code).join(', ')}: no active room is big enough or has the
                      required facility. These cannot be placed until a room or the class size is changed.
                    </Warning>
                  )}
                  {facts.shortfalls.length > 0 && (
                    <Warning>
                      <strong>Not everything will fit</strong> for {facts.shortfalls.length === 1 ? 'one instructor' : `${facts.shortfalls.length} instructors`}:
                      <ul className="mt-1 list-disc pl-5">
                        {facts.shortfalls.slice(0, 5).map((m) => (
                          <li key={m}>{m}</li>
                        ))}
                      </ul>
                      {facts.shortfalls.length > 5 && <span>…and {facts.shortfalls.length - 5} more.</span>} Change the hours on the Instructors page, or reassign
                      a section.
                    </Warning>
                  )}
                  {facts.noInstructor > 0 && (
                    <Warning>
                      {facts.noInstructor} section{facts.noInstructor === 1 ? ' has' : 's have'} no instructor assigned, so instructor clashes
                      cannot be checked for {facts.noInstructor === 1 ? 'it' : 'them'}.
                    </Warning>
                  )}

                  <div className="grid gap-4 sm:grid-cols-2">
                    <fieldset>
                      <legend className="mb-1 text-[13px] font-medium text-ink-700">How long may it think?</legend>
                      <div className="flex flex-wrap gap-2">
                        {TIMES.map((t) => (
                          <label
                            key={t.sec}
                            className={`cursor-pointer rounded-md border px-3 py-1.5 text-[14px] ${
                              seconds === t.sec ? 'border-ink-900 bg-ink-900 text-white' : 'border-ink-200 bg-white text-ink-800 hover:bg-ink-50'
                            }`}
                          >
                            <input type="radio" name="gen-time" className="sr-only" checked={seconds === t.sec} onChange={() => setSeconds(t.sec)} />
                            {t.label} <span className="opacity-70">({t.hint})</span>
                          </label>
                        ))}
                      </div>
                      <p className="mt-1 text-[12.5px] text-ink-500">Longer gives a tidier timetable. A first valid plan is ready within a second.</p>
                    </fieldset>
                    <label className="block">
                      <span className="mb-1 block text-[13px] font-medium text-ink-700">Days classes may be on</span>
                      <select className={inputCls} value={daySet} onChange={(e) => setDaySet(e.target.value as typeof daySet)}>
                        {DAY_SETS.map((d) => (
                          <option key={d.id} value={d.id}>
                            {d.label}
                          </option>
                        ))}
                      </select>
                      <span className="mt-1 block text-[12.5px] text-ink-500">
                        {facts.hours ? `School hours: ${facts.hours}.` : 'The school has no open days set.'} Classes stay inside them and inside each instructor’s working hours.
                      </span>
                    </label>
                  </div>
                </>
              )}
            </div>
          )}

          {shown && stage === 'running' && (
            <div className="space-y-4" aria-live="polite">
              <div>
                <div className="mb-1 flex items-center justify-between text-[14px]">
                  <span className="font-medium">{progress ? PHASE[progress.phase] : 'Starting'}…</span>
                  <span className="tabular-nums text-ink-500">
                    {Math.min(Math.round(elapsed), limit)} of {limit} s
                  </span>
                </div>
                <div
                  className="h-2 overflow-hidden rounded-full bg-ink-100"
                  role="progressbar"
                  aria-label="Time used"
                  aria-valuemin={0}
                  aria-valuemax={limit}
                  aria-valuenow={Math.min(Math.round(elapsed), limit)}
                >
                  <div className="h-full rounded-full bg-brass-500 transition-[width] duration-200" style={{ width: `${pct}%` }} />
                </div>
              </div>
              <dl className="grid grid-cols-2 gap-x-6 gap-y-1 rounded-md border border-ink-200 bg-ink-50/60 px-4 py-3 text-[14px] sm:grid-cols-3">
                <Fact label="Meetings placed" value={progress ? `${progress.placed} of ${progress.total}` : '…'} />
                <Fact label="Untidiness score" value={progress?.softPenalty ?? '…'} hint="lower is better" />
                <Fact
                  label="Better than the first plan"
                  value={
                    firstScore && progress?.softPenalty != null
                      ? `${Math.max(0, Math.round(((firstScore - progress.softPenalty) / firstScore) * 100))}%`
                      : '…'
                  }
                />
              </dl>
              <p className="text-[13px] text-ink-600">
                You can minimize this window (the button below, Escape, or a click outside it). The schedule keeps building, and an{' '}
                <strong>Ongoing scheduling</strong> button stays at the bottom right of every page to bring you back. Or stop at any time: the
                best plan found so far is kept. Nothing is saved yet.
              </p>
            </div>
          )}

          {shown && stage === 'review' && plan && cur && frozen && (
            <div className="space-y-4">
              <div
                className={`rounded-md border px-3 py-2.5 ${
                  cur.complete ? 'border-emerald-200 bg-emerald-50 text-emerald-950' : 'border-amber-200 bg-amber-50 text-amber-950'
                }`}
                role="status"
                data-testid="review-status"
              >
                <div className="font-medium">
                  {cur.complete
                    ? `All ${cur.placements.length} meetings are placed.`
                    : `${cur.placements.length} of ${cur.placements.length + cur.unplaced.length} meetings are placed. ${cur.unplaced.length} need attention.`}
                </div>
                <div className="mt-0.5 text-[13px]">
                  {safe
                    ? 'Checked: no room, instructor or student-block clashes (including with other departments’ bookings), and every class is inside school hours and the instructor’s working hours.'
                    : 'This plan failed the safety check and cannot be saved.'}
                </div>
              </div>

              {!safe && (
                <ul className="list-disc pl-5 text-[13px] text-rose-800">
                  {cur.violations.slice(0, 6).map((v) => (
                    <li key={v}>{v}</li>
                  ))}
                </ul>
              )}

              {save.error && (
                <div className="flex items-start gap-2 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-[14px] text-rose-900" role="alert">
                  <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
                  <div>
                    {friendlyError(save.error, 'The schedule was not saved.')}
                    <div className="text-[13px] text-rose-800">
                      Nothing was changed. If someone just booked a room, choose Try again to plan around it.
                    </div>
                  </div>
                </div>
              )}

              <PlanEditor
                problem={frozen.problem}
                result={cur}
                original={plan.original}
                roomId={roomId}
                onRoomChange={setRoomId}
                onEdit={editPlan}
                onUndo={undo}
                onReset={resetPlan}
                canUndo={plan.past.length > 0}
                note={plan.note}
                disabled={save.isPending}
              />

              <p className="text-[12.5px] text-ink-500">
                Built in {(plan.original.runtimeMs / 1000).toFixed(1)} s by {ENGINE[plan.original.engine]}
                {improvement > 0 ? `, ${improvement}% tidier than the first plan` : ''}
                {plan.original.proven ? '. Nothing better exists.' : '.'} {plan.original.notes.join(' ')} Saved meetings are drafts. You can still
                change them later with Edit timetable, then submit the schedule for the dean’s approval.
              </p>
            </div>
          )}
        </Modal>
      )}
    </>
  )
}

function Fact({ label, value, hint }: { label: string; value: number | string; hint?: string }) {
  return (
    <div>
      <dt className="text-[12.5px] text-ink-500">
        {label}
        {hint ? <span className="text-ink-400"> ({hint})</span> : null}
      </dt>
      <dd className="font-medium tabular-nums">{value}</dd>
    </div>
  )
}

function Warning({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[13.5px] text-amber-950" role="note">
      <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div>{children}</div>
    </div>
  )
}
