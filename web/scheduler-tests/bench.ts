// Not a test: prints how the solver behaves on bigger programs.  node scheduler-tests/bench.ts [limitSeconds]
import { firstFit } from '../src/lib/scheduler/firstFit.ts'
import { softPenalty } from '../src/lib/scheduler/score.ts'
import { solveTimetable } from '../src/lib/scheduler/solve.ts'
import { problemOf, randomCase } from './helpers.ts'

const limit = Number(process.argv[2] ?? 20)
const cases: Record<string, Parameters<typeof randomCase>[1]> = {
  demo: { rooms: 4, sections: 8, otherSections: 0 },
  medium: { rooms: 12, sections: 30, otherSections: 80 },
  prog: { rooms: 15, sections: 40, otherSections: 200 },
  prog2: { rooms: 10, sections: 45, otherSections: 150, meetings: [2, 2, 3] },
  large: { rooms: 25, sections: 80, otherSections: 220, meetings: [2, 2, 3, 1] },
}
for (const [name, c] of Object.entries(cases)) {
  const p = problemOf(randomCase(name.length * 11, c))
  const total = p.sections.reduce((n, s) => n + s.toPlace, 0)
  const quick = firstFit(p)
  let first: number | null = null
  const t0 = Date.now()
  const r = await solveTimetable(p, { timeLimitSec: limit }, { onIncumbent: (i) => { if (i.engine === 'cp-sat' && first === null) first = (Date.now() - t0) / 1000 } })
  console.log(JSON.stringify({
    name, meetings: total, quickPlaced: quick.length, quickPenalty: softPenalty(p, quick),
    placed: r.placements.length, penalty: r.softPenalty, engine: r.engine, proven: r.proven,
    firstCpSatSolutionSec: first, totalSec: +((Date.now() - t0) / 1000).toFixed(1), violations: r.violations.length, notes: r.notes,
  }))
}
