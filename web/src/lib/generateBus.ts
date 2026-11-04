/**
 * The Generate schedule window lives in the app's frame, not in the Schedules page, so a run keeps going (and a plan
 * waiting to be saved is kept) when the window is minimized or the person goes to another page. These two small
 * channels connect it to the page that opens it and to the page that shows the result.
 */
import type { Program } from './types'

export interface GenerateRequest {
  termId: string
  /** the programs this person may generate for */
  programs: Program[]
  /** the ones ticked when the window opens */
  initialIds: string[]
}

export interface GenerateSaved {
  inserted: number
  replaced: number
  unplaced: number
  /** the codes of the programs that were planned together */
  programs: string[]
}

type Handler<T> = (value: T) => void

const openers = new Set<Handler<GenerateRequest>>()
const savers = new Set<Handler<GenerateSaved>>()
let pendingSaved: GenerateSaved | null = null

/** Called by a page: show the Generate schedule window (or, if a run or an unsaved plan is waiting, bring it back). */
export function openGenerate(request: GenerateRequest): void {
  openers.forEach((h) => h(request))
}

/** Called by the window: wants to hear when a page asks for it. Returns the way to stop listening. */
export function onGenerateRequest(handler: Handler<GenerateRequest>): () => void {
  openers.add(handler)
  return () => void openers.delete(handler)
}

/** Called by the window after a plan was saved. If no page is listening, the news waits for the next one that asks. */
export function reportGenerateSaved(saved: GenerateSaved): void {
  if (savers.size === 0) pendingSaved = saved
  else savers.forEach((h) => h(saved))
}

/** Called by the Schedules page: wants to hear about saved plans, including one saved while it was not on screen. */
export function onGenerateSaved(handler: Handler<GenerateSaved>): () => void {
  savers.add(handler)
  if (pendingSaved) {
    const s = pendingSaved
    pendingSaved = null
    handler(s)
  }
  return () => void savers.delete(handler)
}
