import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { csvCell, toCsv } from '../src/lib/csv.ts'
import { runStatus, solveRunArgs } from '../src/lib/evaluation/runLog.ts'
import {
  confusionMetrics,
  f1Verdict,
  latencySummary,
  mean,
  percentile,
  sampleSd,
  solverSummary,
  tally,
} from '../src/lib/evaluation/metrics.ts'
import { SUBSYSTEM, SUBSYSTEMS, cellOf, plannedTotal, trialCode } from '../src/lib/evaluation/plan.ts'
import { solverRunsCsv, summarize, summaryCsv, trialLogCsv } from '../src/lib/evaluation/export.ts'
import { addDays, dayStartIso, fmtStamp } from '../src/lib/time.ts'
import type { SolveRunRow, TestTrialRow } from '../src/lib/types.ts'

const close = (a: number | null, b: number, eps = 1e-9) => {
  assert.ok(a !== null && Math.abs(a - b) < eps, `${a} is not ${b}`)
}

describe('confusion matrix metrics (Tharwat, 2021, as written in Chapter 2)', () => {
  it('computes accuracy, precision, recall and F1 from the four cells', () => {
    // 45 valid requests granted, 3 invalid granted, 47 invalid denied, 5 valid denied
    const m = confusionMetrics({ tp: 45, fp: 3, tn: 47, fn: 5 })
    assert.equal(m.n, 100)
    close(m.accuracy, 0.92)
    close(m.precision, 45 / 48)
    close(m.recall, 0.9)
    // 2PR / (P + R) worked out from the two ratios, not from the counts
    close(m.f1, (2 * (45 / 48) * 0.9) / (45 / 48 + 0.9))
  })
  it('gives F1 = 1 for a perfect run and 0 when every yes was wrong', () => {
    close(confusionMetrics({ tp: 10, fp: 0, tn: 10, fn: 0 }).f1, 1)
    const none = confusionMetrics({ tp: 0, fp: 5, tn: 5, fn: 5 })
    close(none.f1, 0)
    close(none.precision, 0)
    close(none.recall, 0)
  })
  it('says "no data" (null), not 0, when a formula divides by zero', () => {
    const empty = confusionMetrics({ tp: 0, fp: 0, tn: 0, fn: 0 })
    assert.deepEqual([empty.accuracy, empty.precision, empty.recall, empty.f1], [null, null, null, null])
    // the system never said yes, and yes was right half the time
    const never = confusionMetrics({ tp: 0, fp: 0, tn: 5, fn: 5 })
    assert.equal(never.precision, null)
    close(never.recall, 0)
    close(never.f1, 0)
    close(never.accuracy, 0.5)
    // only negative cases, all denied: nothing to find, so recall and F1 are undefined
    const onlyNeg = confusionMetrics({ tp: 0, fp: 0, tn: 10, fn: 0 })
    assert.equal(onlyNeg.recall, null)
    assert.equal(onlyNeg.f1, null)
    close(onlyNeg.accuracy, 1)
  })
  it('counts the cells of a list of trials', () => {
    const c = tally([{ result: 'TP' }, { result: 'TP' }, { result: 'FN' }, { result: 'TN' }, { result: 'FP' }, { result: 'TN' }])
    assert.deepEqual(c, { tp: 2, fp: 1, tn: 2, fn: 1 })
  })
  it('judges F1 against the researchers\' targets (0.90 for cards, 0.85 for the camera, none for key return)', () => {
    assert.equal(SUBSYSTEM.rfid.f1Target, 0.9)
    assert.equal(SUBSYSTEM.cctv.f1Target, 0.85)
    assert.equal(SUBSYSTEM.key_return.f1Target, null)
    assert.equal(f1Verdict(0.9, 0.9), 'met')
    assert.equal(f1Verdict(0.8999, 0.9), 'below')
    assert.equal(f1Verdict(null, 0.9), 'no_data')
    assert.equal(f1Verdict(0.99, null), 'no_target')
  })
})

describe('response time statistics', () => {
  it('uses the sample standard deviation (n - 1)', () => {
    close(mean([2, 4, 4, 4, 5, 5, 7, 9]), 5)
    close(sampleSd([2, 4, 4, 4, 5, 5, 7, 9]), Math.sqrt(32 / 7))
    assert.equal(sampleSd([5]), null)
    assert.equal(sampleSd([]), null)
  })
  it('takes percentiles by linear interpolation, like Excel PERCENTILE.INC', () => {
    close(percentile([100, 200, 300, 400, 500], 95), 480)
    close(percentile([100, 200, 300, 400, 500], 50), 300)
    close(percentile([500, 100, 300, 200, 400], 0), 100) // order does not matter
    close(percentile([500, 100, 300, 200, 400], 100), 500)
    close(percentile([10, 20], 95), 19.5)
    close(percentile([42], 95), 42)
    assert.equal(percentile([], 95), null)
  })
  it('summarises against the 500 ms target', () => {
    const s = latencySummary([100, 200, 300, 600])
    assert.equal(s.n, 4)
    close(s.mean, 300)
    close(s.p95, 555)
    assert.equal(s.within, 3)
    assert.equal(s.p95Met, false)
    assert.equal(latencySummary([100, 200, 300, 400]).p95Met, true)
    assert.equal(latencySummary([500, 500]).p95Met, true) // exactly on the target is within it
    const none = latencySummary([])
    assert.deepEqual([none.n, none.mean, none.p95, none.p95Met], [0, null, null, null])
  })
  it('ignores values that are not numbers or are negative', () => {
    assert.equal(latencySummary([100, Number.NaN, -5, 200]).n, 2)
  })
})

describe('scheduling engine run statistics', () => {
  const runs = [
    { status: 'feasible', runtime_ms: 2000, hard_violations: 0, soft_penalty: 10 },
    { status: 'feasible', runtime_ms: 4000, hard_violations: 0, soft_penalty: 20 },
    { status: 'infeasible', runtime_ms: 6000, hard_violations: 0, soft_penalty: null },
    { status: 'error', runtime_ms: 100, hard_violations: 2, soft_penalty: null },
  ]
  it('counts feasible runs, run time mean and SD in seconds, violations and penalty', () => {
    const s = solverSummary(runs)
    assert.equal(s.runs, 4)
    assert.equal(s.feasible, 2)
    close(s.feasibleShare, 0.5)
    close(s.runtimeMeanSec, 3.025)
    close(s.runtimeSdSec, Math.sqrt(19.4075 / 3))
    close(s.runtimeMaxSec, 6)
    assert.equal(s.hardViolations, 2)
    close(s.penaltyMean, 15)
  })
  it('does not call a run feasible if it reports a violation', () => {
    assert.equal(solverSummary([{ status: 'feasible', runtime_ms: 1, hard_violations: 1, soft_penalty: null }]).feasible, 0)
  })
  it('has no figures for no runs', () => {
    const s = solverSummary([])
    assert.deepEqual([s.runs, s.feasibleShare, s.runtimeMeanSec, s.runtimeSdSec, s.penaltyMean], [0, null, null, null, null])
  })
})

describe('the test plan (Table 2.2 and Appendix C)', () => {
  it('plans 200 card, 100 key return and 100 camera trials, 430 with the 30 engine runs', () => {
    assert.equal(plannedTotal('rfid'), 200)
    assert.equal(plannedTotal('key_return'), 100)
    assert.equal(plannedTotal('cctv'), 100)
  })
  it('numbers trials RFID-001, KEY-012, CCTV-100', () => {
    assert.equal(trialCode('rfid', 1), 'RFID-001')
    assert.equal(trialCode('key_return', 12), 'KEY-012')
    assert.equal(trialCode('cctv', 100), 'CCTV-100')
    assert.equal(trialCode('rfid', 1000), 'RFID-1000')
  })
  it('works out the cell like the database does', () => {
    assert.equal(cellOf(true, true), 'TP')
    assert.equal(cellOf(true, false), 'FN')
    assert.equal(cellOf(false, true), 'FP')
    assert.equal(cellOf(false, false), 'TN')
  })
  it('is the same list of conditions, and the same ground truth, as the database check constraints', () => {
    const sql = readFileSync(new URL('../../supabase/migrations/20261106000011_evaluation_alerts_station_health.sql', import.meta.url), 'utf8')
    const list = (s: string) => [...s.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort()
    for (const sub of SUBSYSTEMS) {
      const m = sql.match(new RegExp(`subsystem = '${sub}'\\s+and condition in \\(([^)]*)\\)`))
      assert.ok(m, `no condition list for ${sub} in the migration`)
      assert.deepEqual(list(m[1]), SUBSYSTEM[sub].conditions.map((c) => c.value).sort(), sub)
    }
    const pos = sql.match(/expected_positive = \(condition in \(([^)]*)\)\)/)
    assert.ok(pos, 'no ground-truth rule in the migration')
    assert.deepEqual(
      list(pos[1]),
      SUBSYSTEMS.flatMap((s) => SUBSYSTEM[s].conditions.filter((c) => c.positive).map((c) => c.value)).sort(),
    )
  })
})

describe('CSV files', () => {
  it('quotes what must be quoted', () => {
    assert.equal(csvCell('plain'), 'plain')
    assert.equal(csvCell('a,b'), '"a,b"')
    assert.equal(csvCell('say "hi"'), '"say ""hi"""')
    assert.equal(csvCell('two\nlines'), '"two\nlines"')
    assert.equal(csvCell('café Ñ 日本'), 'café Ñ 日本')
  })
  it('writes numbers, booleans and empties', () => {
    assert.equal(csvCell(-5), '-5')
    assert.equal(csvCell(0.25), '0.25')
    assert.equal(csvCell(Number.NaN), '')
    assert.equal(csvCell(Infinity), '')
    assert.equal(csvCell(null), '')
    assert.equal(csvCell(undefined), '')
    assert.equal(csvCell(true), 'Yes')
    assert.equal(csvCell(false), 'No')
  })
  it('does not let a typed text run as a spreadsheet formula', () => {
    assert.equal(csvCell('=HYPERLINK("http://x","y")'), `"'=HYPERLINK(""http://x"",""y"")"`)
    assert.equal(csvCell('+1+1'), "'+1+1")
    assert.equal(csvCell('-2+3'), "'-2+3")
    assert.equal(csvCell('@SUM(A1)'), "'@SUM(A1)")
    assert.equal(csvCell('\tcmd'), "'\tcmd")
    assert.equal(csvCell('2026-11-04 08:00:00'), '2026-11-04 08:00:00')
  })
  it('joins rows with CRLF and starts with a byte-order mark for Excel', () => {
    assert.equal(toCsv([['a', 'b'], [1, 'x,y']]), '﻿a,b\r\n1,"x,y"\r\n')
    assert.equal(toCsv([['a']], { bom: false }), 'a\r\n')
    assert.equal(toCsv([]), '﻿')
  })
})

describe('time zones', () => {
  it('writes an instant as a clock in a zone', () => {
    assert.equal(fmtStamp('2026-11-04T00:31:55Z', 'Asia/Manila'), '2026-11-04 08:31:55')
    assert.equal(fmtStamp('2026-11-04T16:00:00Z', 'Asia/Manila'), '2026-11-05 00:00:00')
  })
  it('finds where a calendar day starts, also across a clock change', () => {
    assert.equal(dayStartIso('2026-11-04', 'Asia/Manila'), '2026-11-03T16:00:00.000Z')
    assert.equal(dayStartIso('2026-11-04', 'UTC'), '2026-11-04T00:00:00.000Z')
    assert.equal(dayStartIso('2026-11-01', 'America/New_York'), '2026-11-01T04:00:00.000Z') // still summer time at midnight
    assert.equal(dayStartIso('2026-11-02', 'America/New_York'), '2026-11-02T05:00:00.000Z')
    assert.equal(dayStartIso('2026-03-08', 'America/New_York'), '2026-03-08T05:00:00.000Z')
  })
  it('adds days to a date', () => {
    assert.equal(addDays('2026-11-30', 1), '2026-12-01')
    assert.equal(addDays('2026-03-01', -1), '2026-02-28')
    assert.equal(addDays('2026-11-04', 0), '2026-11-04')
  })
})

describe('the files for the paper', () => {
  const trial = (o: Partial<TestTrialRow> & Pick<TestTrialRow, 'subsystem' | 'seq' | 'condition' | 'expected_positive' | 'actual_positive'>): TestTrialRow => ({
    id: `id${o.subsystem}${o.seq}`,
    input_presented: '',
    result: cellOf(o.expected_positive, o.actual_positive),
    latency_ms: null,
    access_log_id: null,
    observer: '',
    notes: '',
    occurred_at: '2026-11-04T00:00:00Z',
    ...o,
  })
  const trials: TestTrialRow[] = [
    trial({ subsystem: 'rfid', seq: 2, condition: 'invalid_credential', expected_positive: false, actual_positive: false, latency_ms: 300, occurred_at: '2026-11-04T00:10:00Z', input_presented: '=cmd', notes: 'said "no"' }),
    trial({ subsystem: 'rfid', seq: 1, condition: 'authorized_in_time', expected_positive: true, actual_positive: true, latency_ms: 200, occurred_at: '2026-11-04T00:05:00Z', input_presented: '04A1B2C301', observer: 'Kim' }),
    trial({ subsystem: 'cctv', seq: 1, condition: 'class_in_session', expected_positive: true, actual_positive: false }),
  ]
  it('writes the trial log in the columns of Appendix C, oldest first, in the school\'s local time', () => {
    const lines = trialLogCsv(trials, 'Asia/Manila').replace('﻿', '').split('\r\n')
    assert.equal(lines[0], 'Trial ID,Subsystem,Timestamp,Input presented,Expected outcome,Actual outcome,Latency (ms),Result (TP / FP / TN / FN),Test condition,Observer,Notes')
    assert.equal(lines[2], 'RFID-001,Card checker (RFID authentication and schedule validation),2026-11-04 08:05:00,04A1B2C301,Grant,Granted,200,TP,Authorized instructor within scheduled time,Kim,')
    assert.equal(lines[3], `RFID-002,Card checker (RFID authentication and schedule validation),2026-11-04 08:10:00,'=cmd,Deny,Denied,300,TN,Unregistered or invalid credential,,"said ""no"""`)
    assert.equal(lines[1], 'CCTV-001,Camera check (AI occupancy verification),2026-11-04 08:00:00,,Occupied,Vacant,,FN,Class in session during scheduled period,,')
  })
  it('keeps a typed note from running as a formula', () => {
    const csv = trialLogCsv(trials, 'Asia/Manila')
    assert.ok(csv.includes("'=cmd"), 'the card number that starts with = is defused')
    assert.ok(csv.includes('"said ""no"""'), 'quotes in a note are doubled')
  })
  it('summarises per subsystem and writes the summary', () => {
    const runs: SolveRunRow[] = [
      { id: 'a', status: 'feasible', runtime_ms: 1500, hard_violations: 0, soft_penalty: 4, message: null, created_at: '2026-11-04T01:00:00Z', program_id: null },
      { id: 'b', status: 'infeasible', runtime_ms: 2500, hard_violations: 0, soft_penalty: null, message: '2 not placed', created_at: '2026-11-04T01:05:00Z', program_id: null },
    ]
    const s = summarize(trials, runs)
    assert.deepEqual(s.perSubsystem.rfid.counts, { tp: 1, fp: 0, tn: 1, fn: 0 })
    assert.deepEqual(s.perSubsystem.cctv.counts, { tp: 0, fp: 0, tn: 0, fn: 1 })
    assert.equal(s.perSubsystem.rfid.latency.n, 2)
    assert.equal(s.solver.runs, 2)
    const csv = summaryCsv(s).replace('﻿', '')
    assert.ok(csv.includes('Card checker (RFID authentication and schedule validation),2,1,0,1,0,1,1,1,1,0.9,Met'), csv)
    assert.ok(csv.includes('Camera check (AI occupancy verification),1,0,0,0,1,0,,0,0,0.85,Not met'), csv)
    assert.ok(csv.includes('Key return detection (micro-switch),0,0,0,0,0,,,,,,No target set'), csv)
    assert.ok(csv.includes('AI scheduling engine,2,1,0.5,2,'), csv)
    const runCsv = solverRunsCsv(runs, 'Asia/Manila').replace('﻿', '').split('\r\n')
    assert.equal(runCsv[0], 'Run No.,Date and time,Hard constraint violations,Solver runtime (s),Soft constraint penalty,Feasible (Yes / No),Outcome,Note')
    assert.equal(runCsv[1], '1,2026-11-04 09:00:00,0,1.5,4,Yes,feasible,')
    assert.equal(runCsv[2], '2,2026-11-04 09:05:00,0,2.5,,No,infeasible,2 not placed')
  })
})

describe('scheduling run log', () => {
  const base = { complete: true, violations: [] as unknown[], runtimeMs: 1234.6, softPenalty: 42, proven: false, notes: ['Stopped early.'] }

  it('calls a complete plan with no violation feasible', () => {
    const a = solveRunArgs(base as never, 'term-1', ['p1', 'p2'], 'CP-SAT')
    assert.equal(a.p_status, 'feasible')
    assert.equal(a.p_runtime_ms, 1235)
    assert.equal(a.p_hard_violations, 0)
    assert.equal(a.p_soft_penalty, 42)
    assert.deepEqual(a.p_program_ids, ['p1', 'p2'])
    assert.equal(a.p_message, 'CP-SAT. best found in the time. Stopped early.')
  })

  it('calls a plan with meetings left out infeasible, and one that breaks a rule an error', () => {
    assert.equal(runStatus({ complete: false, violations: [] }), 'infeasible')
    assert.equal(runStatus({ complete: true, violations: [{}, {}] as never }), 'error')
    assert.equal(solveRunArgs({ ...base, complete: false, violations: [{}] } as never, 't', [], 'x').p_hard_violations, 1)
  })

  it('keeps the numbers inside what the database accepts', () => {
    const a = solveRunArgs({ ...base, runtimeMs: -5, softPenalty: Number.NaN, notes: ['x'.repeat(900)] } as never, 't', [], 'x')
    assert.equal(a.p_runtime_ms, 0)
    assert.equal(a.p_soft_penalty, null)
    assert.equal(a.p_message.length, 500)
  })
})
