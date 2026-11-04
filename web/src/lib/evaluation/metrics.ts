/**
 * The numbers of Chapter 2, "Statistical Treatment": the confusion matrix and its metrics (Tharwat, 2021),
 * the response-time summary, and the scheduling-engine run statistics. Plain functions, no database.
 *
 * A metric is `null` when its formula divides by zero (no cases to judge it by). It is never shown as 0,
 * because "no data" and "everything wrong" are different findings.
 */

export type Cell = 'TP' | 'FP' | 'TN' | 'FN'

export interface Counts {
  tp: number
  fp: number
  tn: number
  fn: number
}

export const emptyCounts = (): Counts => ({ tp: 0, fp: 0, tn: 0, fn: 0 })

export function tally(rows: Iterable<{ result: Cell }>): Counts {
  const c = emptyCounts()
  for (const r of rows) {
    if (r.result === 'TP') c.tp++
    else if (r.result === 'FP') c.fp++
    else if (r.result === 'TN') c.tn++
    else if (r.result === 'FN') c.fn++
  }
  return c
}

export interface ConfusionMetrics {
  n: number
  /** (TP + TN) / (TP + TN + FP + FN) */
  accuracy: number | null
  /** TP / (TP + FP): of the requests granted, how many should have been */
  precision: number | null
  /** TP / (TP + FN): of the valid requests, how many were granted */
  recall: number | null
  /** 2 x precision x recall / (precision + recall) */
  f1: number | null
}

export function confusionMetrics(c: Counts): ConfusionMetrics {
  const n = c.tp + c.fp + c.tn + c.fn
  const ratio = (a: number, b: number) => (b > 0 ? a / b : null)
  // 2PR / (P + R) written with the counts, 2TP / (2TP + FP + FN): the same number wherever precision and
  // recall both exist, and 0 (not "undefined") for a system that never answers yes while yes was right
  const f1den = 2 * c.tp + c.fp + c.fn
  return {
    n,
    accuracy: ratio(c.tp + c.tn, n),
    precision: ratio(c.tp, c.tp + c.fp),
    recall: ratio(c.tp, c.tp + c.fn),
    f1: ratio(2 * c.tp, f1den),
  }
}

/** The researchers' acceptance targets for F1 (Statistical Treatment). Key return has none. */
export const F1_TARGET = { rfid: 0.9, key_return: null, cctv: 0.85 } as const

export type TargetVerdict = 'met' | 'below' | 'no_data' | 'no_target'

export function f1Verdict(f1: number | null, target: number | null): TargetVerdict {
  if (target === null) return 'no_target'
  if (f1 === null) return 'no_data'
  return f1 >= target ? 'met' : 'below'
}

/* ---------- response time ---------- */

export function mean(xs: readonly number[]): number | null {
  if (xs.length === 0) return null
  return xs.reduce((a, b) => a + b, 0) / xs.length
}

/** Sample standard deviation, dividing by n - 1 as the proposal's formula does. Needs two values. */
export function sampleSd(xs: readonly number[]): number | null {
  if (xs.length < 2) return null
  const m = mean(xs)!
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1))
}

/**
 * Percentile by linear interpolation between the closest ranks (p from 0 to 100). This is Excel's
 * PERCENTILE.INC and NumPy's default, so a spreadsheet check gives the same figure.
 */
export function percentile(xs: readonly number[], p: number): number | null {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  const pos = (Math.min(Math.max(p, 0), 100) / 100) * (s.length - 1)
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  return s[lo] + (s[hi] - s[lo]) * (pos - lo)
}

export const LATENCY_TARGET_MS = 500

export interface LatencySummary {
  n: number
  mean: number | null
  sd: number | null
  p95: number | null
  min: number | null
  max: number | null
  /** how many were at or under the target */
  within: number
  /** the 95th percentile is at or under the target */
  p95Met: boolean | null
}

export function latencySummary(values: readonly number[], targetMs = LATENCY_TARGET_MS): LatencySummary {
  const xs = values.filter((v) => Number.isFinite(v) && v >= 0)
  const p95 = percentile(xs, 95)
  return {
    n: xs.length,
    mean: mean(xs),
    sd: sampleSd(xs),
    p95,
    min: xs.length ? Math.min(...xs) : null,
    max: xs.length ? Math.max(...xs) : null,
    within: xs.filter((v) => v <= targetMs).length,
    p95Met: p95 === null ? null : p95 <= targetMs,
  }
}

/* ---------- scheduling engine ---------- */

export interface SolveRunLike {
  status: string
  runtime_ms: number | null
  hard_violations: number | null
  soft_penalty: number | null
}

export interface SolverSummary {
  runs: number
  /** runs that placed every meeting with no hard-rule violation */
  feasible: number
  feasibleShare: number | null
  runtimeMeanSec: number | null
  runtimeSdSec: number | null
  runtimeMaxSec: number | null
  /** the total over all runs; it must be 0 */
  hardViolations: number
  penaltyMean: number | null
}

export const isFeasibleRun = (r: SolveRunLike) => r.status === 'feasible' && (r.hard_violations ?? 0) === 0

export function solverSummary(runs: readonly SolveRunLike[]): SolverSummary {
  const secs = runs.filter((r) => r.runtime_ms !== null).map((r) => (r.runtime_ms as number) / 1000)
  const penalties = runs.filter((r) => r.soft_penalty !== null).map((r) => Number(r.soft_penalty))
  const feasible = runs.filter(isFeasibleRun).length
  return {
    runs: runs.length,
    feasible,
    feasibleShare: runs.length ? feasible / runs.length : null,
    runtimeMeanSec: mean(secs),
    runtimeSdSec: sampleSd(secs),
    runtimeMaxSec: secs.length ? Math.max(...secs) : null,
    hardViolations: runs.reduce((a, r) => a + (r.hard_violations ?? 0), 0),
    penaltyMean: mean(penalties),
  }
}

/* ---------- showing numbers ---------- */

export const fmtRatio = (x: number | null, digits = 3) => (x === null ? '—' : x.toFixed(digits))
export const fmtPercent = (x: number | null, digits = 1) => (x === null ? '—' : `${(x * 100).toFixed(digits)}%`)
export const fmtMs = (x: number | null) => (x === null ? '—' : `${Math.round(x)} ms`)
export const fmtSec = (x: number | null, digits = 2) => (x === null ? '—' : `${x.toFixed(digits)} s`)
