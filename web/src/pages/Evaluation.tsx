import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, Trash2 } from 'lucide-react'
import { useAuth } from '@/auth/AuthProvider'
import { CaptureQueue } from '@/components/CaptureQueue'
import { Panel } from '@/components/surfaces'
import { Badge, Button, EmptyState, ErrorNote, inputCls, Loading, Notice, Table, TBody, THead, td, th } from '@/components/ui'
import { fetchAll, isMissingMigration, unwrap } from '@/lib/api'
import { cn } from '@/lib/cn'
import { downloadText } from '@/lib/download'
import { friendlyError } from '@/lib/errors'
import { solverRunsCsv, summarize, summaryCsv, trialLogCsv } from '@/lib/evaluation/export'
import {
  LATENCY_TARGET_MS,
  confusionMetrics,
  f1Verdict,
  fmtMs,
  fmtPercent,
  fmtRatio,
  fmtSec,
  latencySummary,
  solverSummary,
  tally,
  isFeasibleRun,
  type Cell,
  type LatencySummary,
} from '@/lib/evaluation/metrics'
import {
  PLANNED_SOLVER_RUNS,
  SUBSYSTEM,
  SUBSYSTEMS,
  actualText,
  cellOf,
  conditionOf,
  expectedText,
  plannedTotal,
  trialCode,
  type Subsystem,
} from '@/lib/evaluation/plan'
import { readObserver, saveObserver } from '@/lib/observer'
import { supabase } from '@/lib/supabase'
import { fmtDateTime, fmtRelative, todayIn } from '@/lib/time'
import type { SolveRunRow, TestTrialRow } from '@/lib/types'

const CELL_TONE: Record<Cell, 'good' | 'bad' | 'warn'> = { TP: 'good', TN: 'good', FP: 'bad', FN: 'warn' }

export default function Evaluation() {
  const { profile } = useAuth()
  const tz = profile?.tenants?.timezone ?? 'Asia/Manila'

  const trials = useQuery({
    queryKey: ['test-trials'],
    retry: (n, e) => !isMissingMigration(e) && n < 2,
    queryFn: () =>
      fetchAll<TestTrialRow>((a, b) =>
        supabase
          .from('test_trials')
          .select('id, subsystem, seq, condition, input_presented, expected_positive, actual_positive, result, latency_ms, access_log_id, observer, notes, occurred_at')
          .order('occurred_at', { ascending: false })
          .order('id')
          .range(a, b),
      ),
  })
  const runs = useQuery({
    queryKey: ['solver-runs'],
    retry: (n, e) => !isMissingMigration(e) && n < 2,
    queryFn: () =>
      fetchAll<SolveRunRow>((a, b) =>
        supabase
          .from('solve_jobs')
          .select('id, status, runtime_ms, hard_violations, soft_penalty, message, created_at, program_id')
          .eq('kind', 'run')
          .order('created_at', { ascending: false })
          .order('id')
          .range(a, b),
      ),
  })
  const taps = useQuery({
    queryKey: ['tap-latency'],
    retry: false,
    queryFn: () =>
      fetchAll<{ id: string; latency_ms: number }>((a, b) =>
        supabase.from('access_logs').select('id, latency_ms').not('latency_ms', 'is', null).order('occurred_at', { ascending: false }).order('id').range(a, b),
      ),
  })

  const missing = isMissingMigration(trials.error) || isMissingMigration(runs.error)
  const rows = trials.data ?? []
  const runRows = runs.data ?? []

  const summary = useMemo(() => summarize(rows, runRows), [rows, runRows])
  const stamp = todayIn(tz)

  return (
    <>
      <header className="mb-7 flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
        <div className="min-w-0 max-w-[68ch]">
          <h1 className="font-display text-[34px] font-semibold leading-none tracking-[-0.02em]">Evaluation</h1>
          <p className="mt-2 text-ink-500">
            Turn each controlled trial of the card checker, the key-return switch and the camera into a record, then read the confusion matrix, precision, recall and F1-score that Chapter 2 asks for. Every figure is worked out from the trials you record here. Nothing is estimated.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" disabled={rows.length === 0} onClick={() => downloadText(`classroom360-trial-log-${stamp}.csv`, trialLogCsv(rows, tz))}>
            <Download className="size-4" aria-hidden />
            Trial log (CSV)
          </Button>
          <Button variant="secondary" disabled={rows.length === 0 && runRows.length === 0} onClick={() => downloadText(`classroom360-summary-${stamp}.csv`, summaryCsv(summary))}>
            <Download className="size-4" aria-hidden />
            Summary (CSV)
          </Button>
        </div>
      </header>

      {missing && (
        <Notice tone="warn">
          This page needs database update 11. Run <code className="rounded bg-amber-100 px-1">supabase/migrations/20261106000011_evaluation_alerts_station_health.sql</code> in the
          Supabase SQL editor, then reload.
        </Notice>
      )}

      {trials.isLoading ? (
        <Loading rows={4} />
      ) : trials.error && !missing ? (
        <ErrorNote error={trials.error} onRetry={() => void trials.refetch()} />
      ) : !missing ? (
        <>
          <div className="mb-6 grid grid-cols-1 gap-6 xl:grid-cols-3">
            {SUBSYSTEMS.map((s) => (
              <SubsystemCard key={s} sub={s} rows={rows.filter((r) => r.subsystem === s)} />
            ))}
          </div>

          <div className="mb-6 grid grid-cols-1 gap-6 xl:grid-cols-2">
            <LatencyCard
              cards={summary.perSubsystem.rfid.latency}
              taps={latencySummary((taps.data ?? []).map((t) => t.latency_ms))}
              tapsError={taps.error}
            />
            <SolverCard runs={runRows} loading={runs.isLoading} error={runs.error} tz={tz} onExport={() => downloadText(`classroom360-solver-runs-${stamp}.csv`, solverRunsCsv(runRows, tz))} />
          </div>

          <div className="space-y-6">
            <CaptureQueue tz={tz} />
            <AddTrial rows={rows} tz={tz} />
            <TrialsTable rows={rows} tz={tz} />
          </div>
        </>
      ) : null}
    </>
  )
}

/* ------------------------------------------------------------------ one subsystem */

function SubsystemCard({ sub, rows }: { sub: Subsystem; rows: TestTrialRow[] }) {
  const info = SUBSYSTEM[sub]
  const counts = tally(rows)
  const m = confusionMetrics(counts)
  const verdict = f1Verdict(m.f1, info.f1Target)
  const planned = plannedTotal(sub)

  const f1 = m.f1
  return (
    <section className="overflow-hidden rounded-lg bg-white shadow-[0_16px_28px_-22px_rgb(11_21_36/0.55)] ring-1 ring-ink-200">
      {/* the instrument head: the name, and the F1-score on a readout against the proposal's target */}
      <header className="bg-ink-900 px-4 pb-4 pt-3.5 text-white">
        <h2 className="font-display text-[20px] font-semibold leading-6">{info.title}</h2>
        <p className="text-[13px] text-ink-300">{`${m.n} of about ${planned} planned trials`}</p>
        <div className="mt-3.5 flex items-center gap-4">
          <div className="shrink-0 rounded-md bg-ink-950 px-3.5 py-2 shadow-[inset_0_2px_6px_rgb(0_0_0/0.55)] ring-1 ring-ink-700">
            <div className="text-[11.5px] leading-4 text-ink-400">F1-score</div>
            <div className={cn('font-mono text-[32px] font-medium leading-9 tabular-nums', f1 === null ? 'text-ink-500' : 'text-brass-300')}>{fmtRatio(f1)}</div>
          </div>
          <div className="min-w-0 flex-1" aria-hidden>
            <div className="relative h-2.5 rounded-full bg-ink-700 ring-1 ring-ink-600">
              {f1 !== null && <span className="absolute inset-y-0 left-0 rounded-full bg-brass-400" style={{ width: `${Math.min(100, Math.max(0, f1 * 100))}%` }} />}
              {info.f1Target !== null && <span className="absolute -inset-y-1 w-0.5 rounded-full bg-white" style={{ left: `${info.f1Target * 100}%` }} />}
            </div>
            <div className="relative mt-2 h-4 text-[12px] leading-4 text-ink-300">
              {info.f1Target !== null ? (
                <span className="absolute -translate-x-1/2 whitespace-nowrap" style={{ left: `${Math.min(88, info.f1Target * 100)}%` }}>
                  target {info.f1Target.toFixed(2)}
                </span>
              ) : (
                <span>no target in the proposal</span>
              )}
            </div>
          </div>
        </div>
      </header>

      <div className="p-4">
        <table className="mb-4 w-full border-separate border-spacing-1 text-center text-[14px]" aria-label={`Confusion matrix, ${info.title}`}>
          <thead>
            <tr className="text-[12px] text-ink-500">
              <th className="p-1" />
              <th className="p-1 font-medium">Predicted positive</th>
              <th className="p-1 font-medium">Predicted negative</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th className="p-1 text-left text-[12px] font-medium text-ink-500">Actual positive</th>
              <MatrixCell cell="TP" n={counts.tp} />
              <MatrixCell cell="FN" n={counts.fn} />
            </tr>
            <tr>
              <th className="p-1 text-left text-[12px] font-medium text-ink-500">Actual negative</th>
              <MatrixCell cell="FP" n={counts.fp} />
              <MatrixCell cell="TN" n={counts.tn} />
            </tr>
          </tbody>
        </table>

        <dl className="mb-3 grid grid-cols-4 divide-x divide-ink-200 overflow-hidden rounded-md border border-ink-200 text-center">
          <Metric label="Accuracy" value={fmtRatio(m.accuracy)} />
          <Metric label="Precision" value={fmtRatio(m.precision)} />
          <Metric label="Recall" value={fmtRatio(m.recall)} />
          <Metric label="F1-score" value={fmtRatio(m.f1)} strong />
        </dl>
        <div className="mb-4">
          {verdict === 'met' && <Badge tone="good">F1 meets the {info.f1Target!.toFixed(2)} target</Badge>}
          {verdict === 'below' && <Badge tone="bad">F1 is below the {info.f1Target!.toFixed(2)} target</Badge>}
          {verdict === 'no_data' && <Badge>No trials yet</Badge>}
          {verdict === 'no_target' && <Badge>The proposal sets no F1 target for this</Badge>}
          <p className="mt-1 text-[12px] text-ink-500">A dash means the formula divides by zero (no cases to judge it by).</p>
        </div>

        <h3 className="mb-1.5 text-[13px] font-medium text-ink-500">Trials by test condition</h3>
        <ul className="space-y-2.5">
          {info.conditions.map((c) => {
            const n = rows.filter((r) => r.condition === c.value).length
            return (
              <li key={c.value}>
                <div className="flex justify-between gap-2 text-[13px]">
                  <span>{c.label}</span>
                  <span className="shrink-0 tabular-nums text-ink-500">
                    {n} / {c.planned}
                  </span>
                </div>
                <div className="mt-1 h-2 overflow-hidden rounded-[2px] bg-ink-100 ring-1 ring-inset ring-ink-200" role="presentation">
                  <div className="h-full bg-brass-400" style={{ width: `${Math.min(100, (n / c.planned) * 100)}%` }} />
                </div>
              </li>
            )
          })}
        </ul>

        <details className="mt-4 text-[13px] text-ink-600">
          <summary className="cursor-pointer font-medium text-ink-700">What the four cells mean here</summary>
          <p className="mt-2">
            <strong>Positive class.</strong> {info.positiveClass}
          </p>
          <ul className="mt-1 space-y-1">
            {(['TP', 'FP', 'TN', 'FN'] as const).map((c) => (
              <li key={c}>
                <strong>{c}.</strong> {info.cells[c]}
              </li>
            ))}
          </ul>
        </details>
      </div>
    </section>
  )
}

function MatrixCell({ cell, n }: { cell: Cell; n: number }) {
  return (
    <td className="p-0">
      <div
        className={cn(
          'rounded-md border border-l-4 px-3 py-2 text-left',
          CELL_TONE[cell] === 'good' && 'border-emerald-200 border-l-emerald-500 bg-emerald-50',
          CELL_TONE[cell] === 'bad' && 'border-rose-200 border-l-rose-500 bg-rose-50',
          CELL_TONE[cell] === 'warn' && 'border-amber-200 border-l-amber-500 bg-amber-50',
        )}
      >
        <div className="text-[12px] text-ink-500">{cell}</div>
        <div className="font-mono text-[24px] font-medium leading-7 tabular-nums">{n}</div>
      </div>
    </td>
  )
}

function Metric({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={cn('px-1 py-2', strong && 'bg-brass-50')}>
      <dt className="text-[12px] text-ink-500">{label}</dt>
      <dd className="font-mono text-[16px] font-medium tabular-nums">{value}</dd>
    </div>
  )
}

/* ------------------------------------------------------------------ response time */

function LatencyRows({ s }: { s: LatencySummary }) {
  if (s.n === 0) return <p className="text-ink-500">No response times yet.</p>
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-[14px] sm:grid-cols-3">
      <Fact label="Measured" value={String(s.n)} />
      <Fact label="Mean" value={fmtMs(s.mean)} />
      <Fact label="Standard deviation" value={fmtMs(s.sd)} />
      <Fact label="95th percentile" value={fmtMs(s.p95)} />
      <Fact label="Slowest" value={fmtMs(s.max)} />
      <Fact label={`Within ${LATENCY_TARGET_MS} ms`} value={`${s.within} of ${s.n} (${fmtPercent(s.within / s.n, 0)})`} />
    </dl>
  )
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[12px] text-ink-500">{label}</dt>
      <dd className="font-medium tabular-nums">{value}</dd>
    </div>
  )
}

function LatencyCard({ cards, taps, tapsError }: { cards: LatencySummary; taps: LatencySummary; tapsError: unknown }) {
  return (
    <Panel
      title="Authentication response time"
      description={`From the card tap until the locker acts on the answer. The target is ${LATENCY_TARGET_MS} ms.`}
      action={cards.p95Met === null ? undefined : cards.p95Met ? <Badge tone="good">95th percentile within target</Badge> : <Badge tone="bad">95th percentile over target</Badge>}
    >
      <h3 className="mb-1 text-[13px] font-medium text-ink-500">Card trials (the figure for the paper)</h3>
      <LatencyRows s={cards} />
      <h3 className="mb-1 mt-4 text-[13px] font-medium text-ink-500">Every tap the locker station has timed</h3>
      {tapsError ? <p className="text-ink-500">Could not read the locker log.</p> : <LatencyRows s={taps} />}
      <p className="mt-3 text-[12px] text-ink-500">
        The locker station times each tap by itself. Link a card trial to its locker log line below and its time is copied across. The 95th
        percentile is worked out by interpolation, like Excel&rsquo;s PERCENTILE.INC.
      </p>
    </Panel>
  )
}

/* ------------------------------------------------------------------ scheduling engine */

function SolverCard({ runs, loading, error, tz, onExport }: { runs: SolveRunRow[]; loading: boolean; error: unknown; tz: string; onExport: () => void }) {
  const s = solverSummary(runs)
  return (
    <Panel
      title="AI scheduling engine runs"
      description={`Every run of the Generate dialog is logged, saved or not. The proposal plans ${PLANNED_SOLVER_RUNS}.`}
      action={
        <Button variant="secondary" disabled={runs.length === 0} onClick={onExport}>
          <Download className="size-4" aria-hidden />
          Runs (CSV)
        </Button>
      }
    >
      {loading ? (
        <Loading />
      ) : error ? (
        <ErrorNote error={error} />
      ) : runs.length === 0 ? (
        <p className="text-ink-500">No runs yet. Open Schedules, choose Generate and let the engine finish; the run appears here.</p>
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-[14px] sm:grid-cols-3">
            <Fact label="Runs" value={`${s.runs} of ${PLANNED_SOLVER_RUNS}`} />
            <Fact label="Feasible" value={`${s.feasible} (${fmtPercent(s.feasibleShare, 0)})`} />
            <Fact label="Hard violations" value={String(s.hardViolations)} />
            <Fact label="Mean run time" value={fmtSec(s.runtimeMeanSec)} />
            <Fact label="Standard deviation" value={fmtSec(s.runtimeSdSec)} />
            <Fact label="Mean soft penalty" value={s.penaltyMean === null ? '—' : s.penaltyMean.toFixed(1)} />
          </dl>
          <p className="mt-2 text-[12px] text-ink-500">
            Feasible means every meeting was placed with no hard-rule violation. Hard violations must be 0: the app refuses to save a plan that breaks a hard rule.
          </p>
          <ul className="mt-3 divide-y divide-ink-100 rounded-md border border-ink-200 text-[14px]">
            {runs.slice(0, 5).map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3 py-2">
                <span>{fmtDateTime(r.created_at, tz)}</span>
                <span className="flex items-center gap-3">
                  <Badge tone={isFeasibleRun(r) ? 'good' : r.status === 'error' ? 'bad' : 'warn'}>{isFeasibleRun(r) ? 'Feasible' : r.status === 'infeasible' ? 'Meetings left out' : 'Error'}</Badge>
                  <span className="w-16 text-right tabular-nums">{r.runtime_ms === null ? '—' : fmtSec(r.runtime_ms / 1000)}</span>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </Panel>
  )
}

/* ------------------------------------------------------------------ add a trial */

interface RecentTap {
  id: string
  occurred_at: string
  decision: 'granted' | 'denied'
  reason: string
  card_uid_presented: string
  latency_ms: number | null
  instructors: { full_name: string } | null
}

function AddTrial({ rows, tz }: { rows: TestTrialRow[]; tz: string }) {
  const qc = useQueryClient()
  const [sub, setSub] = useState<Subsystem>('rfid')
  const [condition, setCondition] = useState(SUBSYSTEM.rfid.conditions[0].value)
  const [answer, setAnswer] = useState<boolean | null>(null)
  const [input, setInput] = useState('')
  const [latency, setLatency] = useState('')
  const [observer, setObserver] = useState(readObserver)
  const [notes, setNotes] = useState('')
  const [linkId, setLinkId] = useState('')
  const [notice, setNotice] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null)

  const info = SUBSYSTEM[sub]
  const cond = conditionOf(sub, condition) ?? info.conditions[0]

  // the last few taps at the locker, to copy a card trial's answer and time from
  const recent = useQuery({
    queryKey: ['tap-link'],
    enabled: sub === 'rfid',
    retry: false,
    queryFn: () =>
      unwrap<RecentTap[]>(
        supabase
          .from('access_logs')
          .select('id, occurred_at, decision, reason, card_uid_presented, latency_ms, instructors(full_name)')
          .gte('occurred_at', new Date(Date.now() - 3 * 3600_000).toISOString())
          .order('occurred_at', { ascending: false })
          .limit(30),
      ),
  })
  const used = useMemo(() => new Set(rows.map((r) => r.access_log_id).filter(Boolean) as string[]), [rows])
  const linkable = (recent.data ?? []).filter((t) => !used.has(t.id))
  const linked = linkable.find((t) => t.id === linkId)

  useEffect(() => {
    // a tap that is already used (or gone) cannot stay selected
    if (linkId && !linked) setLinkId('')
  }, [linkId, linked])

  function changeSub(next: Subsystem) {
    setSub(next)
    setCondition(SUBSYSTEM[next].conditions[0].value)
    setAnswer(null)
    setLinkId('')
    setNotice(null)
  }

  function pickLink(id: string) {
    setLinkId(id)
    const t = linkable.find((x) => x.id === id)
    if (t) {
      setAnswer(t.decision === 'granted')
      setInput(t.card_uid_presented)
      setLatency(t.latency_ms === null ? '' : String(t.latency_ms))
    }
  }

  const effectiveAnswer = linked ? linked.decision === 'granted' : answer
  const preview = effectiveAnswer === null ? null : cellOf(cond.positive, effectiveAnswer)

  const save = useMutation({
    mutationFn: async () => {
      const ms = latency.trim() === '' ? null : Number(latency)
      if (ms !== null && (!Number.isFinite(ms) || ms < 0 || ms > 60000)) throw new Error('The response time must be between 0 and 60000 ms.')
      const r = await supabase.rpc('record_test_trial', {
        p_subsystem: sub,
        p_condition: condition,
        p_actual_positive: linked ? null : answer,
        p_input: input.trim(),
        p_latency_ms: ms === null ? null : Math.round(ms),
        p_access_log_id: linked ? linked.id : null,
        p_observer: observer.trim(),
        p_notes: notes.trim(),
      })
      if (r.error) throw new Error(r.error.message)
      return r.data as { code: string; result: Cell }
    },
    onSuccess: (r) => {
      setNotice({ tone: 'good', text: `Recorded ${r.code}: ${r.result}.` })
      saveObserver(observer)
      setAnswer(null)
      setInput('')
      setLatency('')
      setNotes('')
      setLinkId('')
      void qc.invalidateQueries({ queryKey: ['test-trials'] })
      void qc.invalidateQueries({ queryKey: ['tap-link'] })
    },
    onError: (e) => setNotice({ tone: 'bad', text: friendlyError(e, 'The trial was not saved.') }),
  })

  function submit(e: FormEvent) {
    e.preventDefault()
    setNotice(null)
    save.mutate()
  }

  const next = rows.filter((r) => r.subsystem === sub).reduce((a, r) => Math.max(a, r.seq), 0) + 1

  return (
    <Panel title="Record a trial by hand" description={`For anything the log does not show. The next one is ${trialCode(sub, next)}.`}>
      {notice && (
        <Notice tone={notice.tone} onDismiss={() => setNotice(null)}>
          {notice.text}
        </Notice>
      )}
      <form onSubmit={submit} className="grid grid-cols-1 gap-x-8 gap-y-4 lg:grid-cols-2">
        <div className="space-y-4">
          <fieldset>
            <legend className="mb-1 text-[13px] font-medium text-ink-500">What is being tested</legend>
            <div className="inline-flex overflow-hidden rounded-md border border-ink-200" role="radiogroup" aria-label="Subsystem">
              {SUBSYSTEMS.map((s) => (
                <button
                  key={s}
                  type="button"
                  role="radio"
                  aria-checked={sub === s}
                  onClick={() => changeSub(s)}
                  className={cn('h-9 px-3 text-[14px] font-medium', sub === s ? 'bg-ink-900 text-white' : 'bg-white text-ink-700 hover:bg-ink-50')}
                >
                  {s === 'rfid' ? 'Card' : s === 'key_return' ? 'Key return' : 'Camera'}
                </button>
              ))}
            </div>
          </fieldset>

          <label className="block">
            <span className="mb-1 block text-[13px] font-medium text-ink-500">Test condition (what you set up)</span>
            <select className={inputCls} value={condition} onChange={(e) => { setCondition(e.target.value); setAnswer(null) }}>
              {info.conditions.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
            <span className="mt-1 block text-[12px] text-ink-500">
              The system should say: <strong>{expectedText(sub, cond.positive)}</strong>.
            </span>
          </label>

          {sub === 'rfid' && (
            <label className="block">
              <span className="mb-1 block text-[13px] font-medium text-ink-500">Copy the answer from a recent locker tap (optional)</span>
              <select className={inputCls} value={linkId} onChange={(e) => pickLink(e.target.value)} disabled={recent.isLoading}>
                <option value="">No, I will enter it myself</option>
                {linkable.map((t) => (
                  <option key={t.id} value={t.id}>
                    {fmtDateTime(t.occurred_at, tz)} · {t.instructors?.full_name ?? t.card_uid_presented} · {t.decision === 'granted' ? 'Granted' : 'Denied'}
                    {t.latency_ms !== null ? ` · ${t.latency_ms} ms` : ''}
                  </option>
                ))}
              </select>
              {recent.error ? <span className="mt-1 block text-[12px] text-ink-500">The locker log could not be read.</span> : null}
            </label>
          )}

        </div>
        <div className="space-y-4">
          <fieldset disabled={Boolean(linked)}>
            <legend className="mb-1 text-[13px] font-medium text-ink-500">What the system did</legend>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {([true, false] as const).map((v) => (
                <button
                  key={String(v)}
                  type="button"
                  aria-pressed={effectiveAnswer === v}
                  onClick={() => setAnswer(v)}
                  disabled={Boolean(linked)}
                  className={cn(
                    'rounded-md border px-3 py-2.5 text-left text-[14px] font-medium disabled:cursor-not-allowed',
                    effectiveAnswer === v ? 'border-ink-900 bg-ink-900 text-white' : 'border-ink-200 bg-white text-ink-800 hover:bg-ink-50 disabled:hover:bg-white',
                  )}
                >
                  {v ? info.yes : info.no}
                </button>
              ))}
            </div>
          </fieldset>

          {preview && (
            <p className="text-[14px]">
              This trial counts as <Badge tone={CELL_TONE[preview]}>{preview}</Badge> <span className="text-ink-500">{info.cells[preview]}</span>
            </p>
          )}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-[13px] font-medium text-ink-500">Input presented</span>
              <input className={inputCls} value={input} onChange={(e) => setInput(e.target.value)} maxLength={200} placeholder={sub === 'rfid' ? 'Card number' : sub === 'key_return' ? 'Door number' : 'Room'} disabled={Boolean(linked)} />
            </label>
            <label className="block">
              <span className="mb-1 block text-[13px] font-medium text-ink-500">Response time (ms)</span>
              <input className={inputCls} value={latency} onChange={(e) => setLatency(e.target.value)} inputMode="numeric" placeholder="Optional" />
            </label>
            <label className="block">
              <span className="mb-1 block text-[13px] font-medium text-ink-500">Observer</span>
              <input className={inputCls} value={observer} onChange={(e) => setObserver(e.target.value)} maxLength={100} placeholder="Your name" />
            </label>
            <label className="block">
              <span className="mb-1 block text-[13px] font-medium text-ink-500">Note</span>
              <input className={inputCls} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} placeholder="Optional" />
            </label>
        </div>

        <Button type="submit" busy={save.isPending} disabled={effectiveAnswer === null}>
          Save trial
        </Button>
        </div>
      </form>
    </Panel>
  )
}

/* ------------------------------------------------------------------ the log */

function TrialsTable({ rows, tz }: { rows: TestTrialRow[]; tz: string }) {
  const qc = useQueryClient()
  const [filter, setFilter] = useState<Subsystem | 'all'>('all')
  const [shown, setShown] = useState(25)
  const [confirm, setConfirm] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const list = rows.filter((r) => filter === 'all' || r.subsystem === filter)

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const r = await supabase.rpc('delete_test_trial', { p_id: id })
      if (r.error) throw new Error(r.error.message)
    },
    onSuccess: () => {
      setConfirm(null)
      setError(null)
      void qc.invalidateQueries({ queryKey: ['test-trials'] })
      void qc.invalidateQueries({ queryKey: ['tap-link'] })
      void qc.invalidateQueries({ queryKey: ['audit'] })
    },
    onError: (e) => setError(friendlyError(e, 'The trial was not deleted.')),
  })

  /** the delete control of one trial: a bin, then a question, so one tap never deletes */
  function actions(r: TestTrialRow) {
    return confirm === r.id ? (
      <span className="inline-flex items-center gap-1">
        <Button variant="danger" className="h-8 px-2.5" busy={remove.isPending} onClick={() => remove.mutate(r.id)}>
          Delete
        </Button>
        <Button variant="ghost" className="h-8 px-2.5" onClick={() => setConfirm(null)}>
          Keep
        </Button>
      </span>
    ) : (
      <Button variant="ghost" className="h-8 px-2 text-rose-700" aria-label={`Delete trial ${trialCode(r.subsystem, r.seq)}`} onClick={() => setConfirm(r.id)}>
        <Trash2 className="size-4" aria-hidden />
      </Button>
    )
  }

  const detail = (r: TestTrialRow) => [r.input_presented, r.observer, r.notes].filter(Boolean).join(' · ')

  return (
    <Panel
      title="Trial log"
      description="The System Testing and Observation Log (Appendix C), newest first. Deleting a trial is recorded in the audit log."
      flush
      action={
        <select className={inputCls.replace("w-full ", "w-48 ")} value={filter} onChange={(e) => { setFilter(e.target.value as Subsystem | 'all'); setShown(25) }} aria-label="Show">
          <option value="all">All subsystems</option>
          {SUBSYSTEMS.map((s) => (
            <option key={s} value={s}>
              {SUBSYSTEM[s].prefix}
            </option>
          ))}
        </select>
      }
    >
      {error && (
        <div className="p-4 pb-0">
          <Notice tone="bad">{error}</Notice>
        </div>
      )}
      {list.length === 0 ? (
        <EmptyState title="No trials yet">Record the first one above. Each trial is one try, with what should have happened next to what did.</EmptyState>
      ) : (
        <>
          {/* a phone gets a card per trial: eight columns do not fit */}
          <ul className="divide-y divide-ink-100 md:hidden">
            {list.slice(0, shown).map((r) => (
              <li key={r.id} className="px-4 py-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{trialCode(r.subsystem, r.seq)}</span>
                  <span className="flex items-center gap-2">
                    <Badge tone={CELL_TONE[r.result]}>{r.result}</Badge>
                    {actions(r)}
                  </span>
                </div>
                <div className="text-[13px] text-ink-500">
                  {fmtDateTime(r.occurred_at, tz)} · {fmtRelative(r.occurred_at)}
                </div>
                <div className="mt-1">{conditionOf(r.subsystem, r.condition)?.label ?? r.condition}</div>
                <div className="text-[13px] text-ink-600">
                  Should be: {expectedText(r.subsystem, r.expected_positive)}. Was: {actualText(r.subsystem, r.actual_positive)}
                  {r.latency_ms === null ? '' : `, ${r.latency_ms} ms`}.
                </div>
                {detail(r) && <div className="text-[12px] text-ink-500">{detail(r)}</div>}
              </li>
            ))}
          </ul>
          <div className="hidden md:block">
            <Table>
              <THead>
                <tr>
                  <th className={th}>Trial</th>
                  <th className={th}>When</th>
                  <th className={th}>Condition</th>
                  <th className={th}>Should be</th>
                  <th className={th}>Was</th>
                  <th className={th}>Time</th>
                  <th className={th}>Result</th>
                  <th className={th} />
                </tr>
              </THead>
              <TBody>
                {list.slice(0, shown).map((r) => (
                  <tr key={r.id}>
                    <td className={`${td} whitespace-nowrap font-medium`}>{trialCode(r.subsystem, r.seq)}</td>
                    <td className={`${td} whitespace-nowrap`}>
                      <div>{fmtDateTime(r.occurred_at, tz)}</div>
                      <div className="text-[12px] text-ink-500">{fmtRelative(r.occurred_at)}</div>
                    </td>
                    <td className={td}>
                      <div>{conditionOf(r.subsystem, r.condition)?.label ?? r.condition}</div>
                      {detail(r) && <div className="text-[12px] text-ink-500">{detail(r)}</div>}
                    </td>
                    <td className={td}>{expectedText(r.subsystem, r.expected_positive)}</td>
                    <td className={td}>{actualText(r.subsystem, r.actual_positive)}</td>
                    <td className={`${td} whitespace-nowrap tabular-nums`}>{r.latency_ms === null ? <span className="text-ink-400">—</span> : `${r.latency_ms} ms`}</td>
                    <td className={td}>
                      <Badge tone={CELL_TONE[r.result]}>{r.result}</Badge>
                    </td>
                    <td className={`${td} whitespace-nowrap text-right`}>{actions(r)}</td>
                  </tr>
                ))}
              </TBody>
            </Table>
          </div>
          {list.length > shown && (
            <div className="border-t border-ink-100 p-3 text-center">
              <Button variant="secondary" onClick={() => setShown((n) => n + 50)}>
                Show more ({list.length - shown} left)
              </Button>
            </div>
          )}
        </>
      )}
    </Panel>
  )
}
