/**
 * What the Generate dialog writes down about a finished run (rpc record_solve_run). The Evaluation page
 * counts these for the scheduling engine's trials: how many runs, how many were feasible, how long they took.
 */
import type { SolveResult } from '../scheduler/types.ts'

export type RunStatus = 'feasible' | 'infeasible' | 'error'

/**
 * feasible: every meeting was placed and the independent rule check found nothing broken.
 * error: the rule check found a hard-rule violation (the app refuses to save such a plan).
 * infeasible: no violation, but some meetings could not be placed.
 */
export function runStatus(r: Pick<SolveResult, 'complete' | 'violations'>): RunStatus {
  if (r.violations.length > 0) return 'error'
  return r.complete ? 'feasible' : 'infeasible'
}

export function solveRunArgs(r: Pick<SolveResult, 'complete' | 'violations' | 'runtimeMs' | 'softPenalty' | 'proven' | 'notes'>, termId: string, programIds: string[], engineName: string) {
  const note = [engineName, r.proven ? 'best possible' : 'best found in the time', ...r.notes].join('. ')
  return {
    p_term_id: termId,
    p_program_ids: programIds,
    p_status: runStatus(r),
    p_runtime_ms: Math.max(0, Math.round(r.runtimeMs)),
    p_hard_violations: r.violations.length,
    p_soft_penalty: Number.isFinite(r.softPenalty) ? r.softPenalty : null,
    p_message: note.slice(0, 500),
  }
}
