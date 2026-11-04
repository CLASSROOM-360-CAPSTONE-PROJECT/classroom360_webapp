import { explainUnplaced } from './explain.ts'
import { softPenalty } from './score.ts'
import { verify } from './verify.ts'
import type { Incumbent, Placement, Problem, SolveResult, Weights } from './types.ts'

export const totalMeetings = (problem: Problem) => problem.sections.reduce((n, s) => n + s.toPlace, 0)

/** Adds the reasons, the independent rule check and the running time to a set of placements. */
export function finalize(
  problem: Problem,
  placements: Placement[],
  extra: { engine: Incumbent['engine']; proven: boolean; runtimeMs: number; notes: string[]; weights?: Partial<Weights> },
): SolveResult {
  const unplaced = explainUnplaced(problem, placements)
  return {
    placements,
    unplaced,
    softPenalty: softPenalty(problem, placements, extra.weights),
    engine: extra.engine,
    complete: unplaced.length === 0,
    proven: extra.proven,
    runtimeMs: Math.round(extra.runtimeMs),
    notes: extra.notes,
    violations: verify(problem, placements),
  }
}
