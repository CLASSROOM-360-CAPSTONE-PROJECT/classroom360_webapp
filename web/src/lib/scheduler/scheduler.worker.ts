/// Runs the timetable solver off the main thread, so the page stays responsive while it works.
import { solveTimetable } from './solve.ts'
import type { Hooks, Problem, SolveOptions } from './types.ts'

export type ToWorker = { problem: Problem; options: SolveOptions }

const ctx = self as unknown as {
  postMessage(message: unknown): void
  onmessage: ((e: MessageEvent<ToWorker>) => void) | null
}

ctx.onmessage = async (e) => {
  const hooks: Hooks = {
    onProgress: (progress) => ctx.postMessage({ type: 'progress', progress }),
    onIncumbent: (incumbent) => ctx.postMessage({ type: 'incumbent', incumbent }),
  }
  try {
    const result = await solveTimetable(e.data.problem, e.data.options, hooks)
    ctx.postMessage({ type: 'result', result })
  } catch (err) {
    ctx.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) })
  }
}
