/** The evaluation files for the paper: Appendix C part I (trial log), part III (solver runs) and the summary. */
import { toCsv, type CsvCell } from '../csv.ts'
import { fmtStamp } from '../time.ts'
import type { SolveRunRow, TestTrialRow } from '../types.ts'
import {
  confusionMetrics,
  f1Verdict,
  isFeasibleRun,
  latencySummary,
  solverSummary,
  tally,
  type ConfusionMetrics,
  type Counts,
  type LatencySummary,
  type SolverSummary,
} from './metrics.ts'
import { actualText, conditionOf, expectedText, SUBSYSTEM, SUBSYSTEMS, trialCode, type Subsystem } from './plan.ts'

/** Appendix C, Part I: Trial ID, Subsystem, Timestamp, Input presented, Expected outcome, Actual outcome, Latency (ms), Result. */
export function trialLogCsv(rows: readonly TestTrialRow[], tz: string): string {
  const sorted = [...rows].sort((a, b) => a.occurred_at.localeCompare(b.occurred_at) || a.seq - b.seq)
  return toCsv([
    ['Trial ID', 'Subsystem', 'Timestamp', 'Input presented', 'Expected outcome', 'Actual outcome', 'Latency (ms)', 'Result (TP / FP / TN / FN)', 'Test condition', 'Observer', 'Notes'],
    ...sorted.map<CsvCell[]>((r) => [
      trialCode(r.subsystem, r.seq),
      SUBSYSTEM[r.subsystem].title,
      fmtStamp(r.occurred_at, tz),
      r.input_presented,
      expectedText(r.subsystem, r.expected_positive),
      actualText(r.subsystem, r.actual_positive),
      r.latency_ms,
      r.result,
      conditionOf(r.subsystem, r.condition)?.label ?? r.condition,
      r.observer,
      r.notes,
    ]),
  ])
}

/** Appendix C, Part III: Run No., Date and time, Hard constraint violations, Solver runtime (s), Soft constraint penalty, Feasible. */
export function solverRunsCsv(runs: readonly SolveRunRow[], tz: string): string {
  const sorted = [...runs].sort((a, b) => a.created_at.localeCompare(b.created_at))
  return toCsv([
    ['Run No.', 'Date and time', 'Hard constraint violations', 'Solver runtime (s)', 'Soft constraint penalty', 'Feasible (Yes / No)', 'Outcome', 'Note'],
    ...sorted.map<CsvCell[]>((r, i) => [
      i + 1,
      fmtStamp(r.created_at, tz),
      r.hard_violations,
      r.runtime_ms === null ? null : Math.round(r.runtime_ms) / 1000,
      r.soft_penalty === null ? null : Number(r.soft_penalty),
      isFeasibleRun(r),
      r.status,
      r.message,
    ]),
  ])
}

export interface EvaluationSummary {
  perSubsystem: Record<Subsystem, { counts: Counts; metrics: ConfusionMetrics; latency: LatencySummary }>
  solver: SolverSummary
}

export function summarize(trials: readonly TestTrialRow[], runs: readonly SolveRunRow[]): EvaluationSummary {
  const per = {} as EvaluationSummary['perSubsystem']
  for (const s of SUBSYSTEMS) {
    const rows = trials.filter((t) => t.subsystem === s)
    const counts = tally(rows)
    per[s] = {
      counts,
      metrics: confusionMetrics(counts),
      latency: latencySummary(rows.filter((t) => t.latency_ms !== null).map((t) => t.latency_ms as number)),
    }
  }
  return { perSubsystem: per, solver: solverSummary(runs) }
}

const num = (x: number | null, d = 4): CsvCell => (x === null ? '' : Number(x.toFixed(d)))

/** One line per subsystem with the confusion matrix and its metrics, then the response time and solver figures. */
export function summaryCsv(s: EvaluationSummary): string {
  const rows: CsvCell[][] = [
    ['Subsystem', 'Trials', 'TP', 'FP', 'TN', 'FN', 'Accuracy', 'Precision', 'Recall', 'F1-score', 'F1 target', 'Target'],
  ]
  for (const sub of SUBSYSTEMS) {
    const { counts: c, metrics: m } = s.perSubsystem[sub]
    const target = SUBSYSTEM[sub].f1Target
    const verdict = f1Verdict(m.f1, target)
    rows.push([
      SUBSYSTEM[sub].title, m.n, c.tp, c.fp, c.tn, c.fn,
      num(m.accuracy), num(m.precision), num(m.recall), num(m.f1),
      target === null ? '' : target,
      verdict === 'met' ? 'Met' : verdict === 'below' ? 'Not met' : verdict === 'no_data' ? 'No data' : 'No target set',
    ])
  }
  const l = s.perSubsystem.rfid.latency
  rows.push([], ['Authentication response time (card trials)', 'Trials', 'Mean (ms)', 'SD (ms)', '95th percentile (ms)', 'Max (ms)', 'Within 500 ms', '95th percentile within 500 ms'])
  rows.push(['RFID', l.n, num(l.mean, 1), num(l.sd, 1), num(l.p95, 1), num(l.max, 0), l.within, l.p95Met === null ? '' : l.p95Met])
  const v = s.solver
  rows.push([], ['Scheduling engine', 'Runs', 'Feasible runs', 'Share feasible', 'Mean runtime (s)', 'SD runtime (s)', 'Hard violations (total)', 'Mean soft penalty'])
  rows.push(['AI scheduling engine', v.runs, v.feasible, num(v.feasibleShare), num(v.runtimeMeanSec, 3), num(v.runtimeSdSec, 3), v.hardViolations, num(v.penaltyMean, 2)])
  return toCsv(rows)
}
