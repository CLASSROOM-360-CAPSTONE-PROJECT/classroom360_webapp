import { firstFit } from './firstFit.ts'
import { finalize } from './finalize.ts'
import { fullWeights } from './score.ts'
import type { Incumbent, Problem, Progress, SolveOptions, SolveResult } from './types.ts'

export interface RunListeners {
  onProgress?: (p: Progress) => void
  onIncumbent?: (i: Incumbent) => void
}

export interface RunHandle {
  result: Promise<SolveResult>
  /** Ends the search now and resolves with the best plan found so far. */
  stop: () => void
}

type FromWorker =
  | { type: 'progress'; progress: Progress }
  | { type: 'incumbent'; incumbent: Incumbent }
  | { type: 'result'; result: SolveResult }
  | { type: 'error'; message: string }

/**
 * Starts the solver in a Web Worker. The answer always arrives as a SolveResult that has been
 * through the independent rule check, even when the chair stops early or the worker cannot start.
 */
export function runScheduler(problem: Problem, options: SolveOptions, listeners: RunListeners = {}): RunHandle {
  const started = performance.now()
  let latest: Incumbent | null = null
  let settle: (r: SolveResult) => void = () => {}
  let worker: Worker | null = null
  let done = false

  const result = new Promise<SolveResult>((resolve) => {
    settle = (r) => {
      if (done) return
      done = true
      worker?.terminate()
      resolve(r)
    }
  })

  /** best plan so far (or, if nothing arrived yet, the quick plan computed here) */
  const bestSoFar = (note: string): SolveResult => {
    const placements = latest?.placements ?? firstFit(problem, fullWeights(options.weights))
    return finalize(problem, placements, {
      engine: latest?.engine ?? 'first-fit',
      proven: false,
      runtimeMs: performance.now() - started,
      notes: [note],
      weights: options.weights,
    })
  }

  try {
    worker = new Worker(new URL('./scheduler.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (e: MessageEvent<FromWorker>) => {
      const m = e.data
      if (m.type === 'progress') listeners.onProgress?.(m.progress)
      else if (m.type === 'incumbent') {
        latest = m.incumbent
        listeners.onIncumbent?.(m.incumbent)
      } else if (m.type === 'result') settle(m.result)
      else settle(bestSoFar(`The optimiser stopped with an error (${m.message}). The best plan found before that is shown.`))
    }
    worker.onerror = (e) => {
      settle(bestSoFar(`The optimiser could not run in this browser (${e.message || 'worker error'}). The quick method was used instead.`))
    }
    worker.postMessage({ problem, options })
  } catch (err) {
    settle(bestSoFar(`The optimiser could not start (${err instanceof Error ? err.message : String(err)}). The quick method was used instead.`))
  }

  return {
    result,
    stop: () => settle(bestSoFar('Stopped early: this is the best plan found so far.')),
  }
}
