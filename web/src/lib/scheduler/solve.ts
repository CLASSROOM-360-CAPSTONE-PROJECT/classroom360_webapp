import { CpSolver, CpSolverStatus } from 'cpsat-js/portable'
import { finalize, totalMeetings } from './finalize.ts'
import { firstFit } from './firstFit.ts'
import { improve } from './improve.ts'
import { buildModel, decode } from './model.ts'
import type { Meeting } from './model.ts'
import { fullWeights, softPenalty } from './score.ts'
import type { Hooks, Incumbent, Placement, Problem, SolveOptions, SolveResult } from './types.ts'

export { finalize, totalMeetings }

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())

/** better = more meetings placed, then a lower preference penalty */
function better(problem: Problem, a: Placement[], b: Placement[], weights?: SolveOptions['weights']): boolean {
  if (a.length !== b.length) return a.length > b.length
  return softPenalty(problem, a, weights) < softPenalty(problem, b, weights)
}

/**
 * Builds a timetable.
 *   1. a first-fit plan in milliseconds (the safety net, and the optimiser's starting hint);
 *   2. if that plan is complete, local search polishes it (fast, and good on big programs);
 *   3. CP-SAT with every meeting required: finds a complete plan when first-fit could not, proves
 *      there is none, or improves the polished plan on small and medium programs;
 *   4. only if that proves impossible (or finds nothing), CP-SAT again allowed to leave meetings out;
 *   5. the best plan found is checked against every hard rule before it is returned.
 * Runs wherever it is called; the app calls it inside a Web Worker so the page stays responsive.
 */
export async function solveTimetable(problem: Problem, options: SolveOptions, hooks: Hooks = {}): Promise<SolveResult> {
  const t0 = now()
  const weights = fullWeights(options.weights)
  const total = totalMeetings(problem)
  const notes: string[] = []
  const elapsedMs = () => now() - t0
  const limitMs = Math.max(2, options.timeLimitSec) * 1000
  const leftMs = () => limitMs - elapsedMs()
  const tell = (phase: Parameters<NonNullable<Hooks['onProgress']>>[0]['phase'], placed: number, penalty: number | null, note?: string) =>
    hooks.onProgress?.({ phase, placed, total, softPenalty: penalty, elapsedMs: Math.round(elapsedMs()), note })

  tell('prepare', 0, null)
  if (problem.days.length === 0) throw new Error('No weekday is selected for scheduling.')

  const state: { engine: Incumbent['engine']; proven: boolean } = { engine: 'first-fit', proven: false }
  let best: Placement[] = []
  let lastEmit = -1e9
  const emit = (placements: Placement[], engine: Incumbent['engine'], phase: 'baseline' | 'optimizing', force = false) => {
    const t = now()
    if (!force && t - lastEmit < 250) return // improving answers can arrive in thousands; the screen needs a few per second
    lastEmit = t
    const pen = softPenalty(problem, placements, weights)
    hooks.onIncumbent?.({ placements, unplaced: [], softPenalty: pen, engine }) // reasons are worked out once, at the end
    tell(phase, placements.length, pen)
  }
  const adopt = (placements: Placement[], engine: Incumbent['engine'], phase: 'baseline' | 'optimizing', force = false) => {
    if (best.length > 0 && !better(problem, placements, best, weights)) return false
    best = placements
    state.engine = engine
    emit(placements, engine, phase, force)
    return true
  }

  // 1. quick plan
  tell('baseline', 0, null)
  best = firstFit(problem, weights)
  emit(best, 'first-fit', 'baseline', true)

  const modelable = problem.sections.some((s) => s.roomIds.length > 0 && s.toPlace > 0)
  if (!modelable) return finalize(problem, best, { engine: state.engine, proven: false, runtimeMs: elapsedMs(), notes, weights })

  // 2. polish a complete plan locally
  if (best.length === total) {
    tell('optimizing', best.length, softPenalty(problem, best, weights), 'Polishing the first plan')
    const polished = improve(problem, best, weights, limitMs * 0.35, (pl) => adopt(pl, 'local-search', 'optimizing'))
    adopt(polished, 'local-search', 'optimizing', true)
  }

  // 3 and 4. CP-SAT
  let solver: CpSolver | null = null
  try {
    solver = await CpSolver.create()
  } catch (err) {
    notes.push(`The optimiser could not be loaded (${err instanceof Error ? err.message : String(err)}). The quick method was used instead.`)
  }

  if (solver && leftMs() > 1500) {
    const run = (mode: 'strict' | 'relaxed', seconds: number) => {
      const { model, meetings } = buildModel(problem, mode, weights, best)
      const res = solver!.solve(model, {
        maxTimeInSeconds: seconds,
        numWorkers: 1,
        onSolution: (s) => {
          adopt(decode(problem, meetings as Meeting[], (v) => s.value(v)), 'cp-sat', 'optimizing')
        },
      })
      if (res.status === CpSolverStatus.FEASIBLE || res.status === CpSolverStatus.OPTIMAL) {
        adopt(decode(problem, meetings as Meeting[], (v) => res.value(v)), 'cp-sat', 'optimizing', true)
      }
      return res.status
    }

    tell('optimizing', best.length, softPenalty(problem, best, weights), 'Searching with the optimiser')
    const complete = best.length === total
    const strict = run('strict', Math.max(1, (leftMs() / 1000) * (complete ? 0.8 : 0.7)))
    if (strict === CpSolverStatus.OPTIMAL) state.proven = true
    else if (strict === CpSolverStatus.MODEL_INVALID) notes.push('The optimiser rejected the model. The quick method was used instead.')

    const impossible = strict === CpSolverStatus.INFEASIBLE
    if (impossible) notes.push('Not every meeting can be placed with the current rooms, instructors and other departments’ bookings.')
    if ((impossible || strict === CpSolverStatus.UNKNOWN) && best.length < total && leftMs() >= 2000) {
      tell('relaxing', best.length, softPenalty(problem, best, weights), 'Looking for the best partial schedule')
      if (run('relaxed', (leftMs() / 1000) * 0.9) === CpSolverStatus.OPTIMAL) state.proven = true
    }
  }

  // 5. use what is left to polish, then check
  if (!state.proven && best.length === total && leftMs() > 300) {
    tell('optimizing', best.length, softPenalty(problem, best, weights), 'Final polish')
    adopt(improve(problem, best, weights, leftMs(), (pl) => adopt(pl, 'local-search', 'optimizing')), 'local-search', 'optimizing', true)
  }

  tell('checking', best.length, softPenalty(problem, best, weights))
  const result = finalize(problem, best, { engine: state.engine, proven: state.proven, runtimeMs: elapsedMs(), notes, weights })
  if (result.violations.length > 0) {
    // never expected, but a plan that breaks a rule must not reach the chair: fall back to the quick plan
    const quick = firstFit(problem, weights)
    const safe = finalize(problem, quick, {
      engine: 'first-fit',
      proven: false,
      runtimeMs: elapsedMs(),
      notes: [...notes, 'The improved plan failed the safety check, so the quick method’s plan is shown instead.'],
      weights,
    })
    if (safe.violations.length === 0) return safe
  }
  return result
}
