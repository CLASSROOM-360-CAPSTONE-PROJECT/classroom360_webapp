/**
 * One picture can miss a person or see one that is not there, so the verdict looks at the last few
 * checks. A room counts as occupied when at least `need` of the last `windowSize` checks saw someone.
 * The first checks are judged on what is available, so the first reading is not delayed.
 */
export interface Reading {
  /** people counted in the recent checks (0 when the room counts as empty) */
  people: number
  occupied: boolean
}

export class OccupancySmoother {
  private readonly recent: number[] = []
  private readonly windowSize: number
  private readonly need: number

  constructor(windowSize = 4, need = 2) {
    if (windowSize < 1 || need < 1 || need > windowSize) throw new Error('need must be between 1 and the window size')
    this.windowSize = windowSize
    this.need = need
  }

  push(people: number): Reading {
    this.recent.push(Math.max(0, Math.round(people)))
    if (this.recent.length > this.windowSize) this.recent.shift()
    const seen = this.recent.filter((n) => n > 0)
    const occupied = seen.length >= Math.min(this.need, this.recent.length)
    if (!occupied) return { people: 0, occupied: false }
    // the middle value of the checks that saw people, so one wild count does not move it
    const sorted = [...seen].sort((a, b) => a - b)
    return { people: sorted[Math.floor((sorted.length - 1) / 2)]!, occupied: true }
  }

  reset(): void {
    this.recent.length = 0
  }
}

/** Report on a change of state, and otherwise now and then so the room status stays fresh. */
export function shouldReport(prev: { occupied: boolean; at: number } | null, next: Reading, now: number, heartbeatMs = 30_000): boolean {
  if (!prev) return true
  if (prev.occupied !== next.occupied) return true
  return now - prev.at >= heartbeatMs
}
