import { useMemo, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { isMissingMigration, useTrialCandidates } from '@/lib/api'
import { cn } from '@/lib/cn'
import { friendlyError } from '@/lib/errors'
import {
  candidateDetail,
  candidateKey,
  candidateSaid,
  candidateWhat,
  conditionChoices,
  countBySubsystem,
  previewCell,
  SUBSYSTEM_SHORT,
} from '@/lib/evaluation/capture'
import type { Cell } from '@/lib/evaluation/metrics'
import { SUBSYSTEMS, type Subsystem } from '@/lib/evaluation/plan'
import { readObserver, saveObserver } from '@/lib/observer'
import { supabase } from '@/lib/supabase'
import { fmtDateTime, fmtRelative } from '@/lib/time'
import type { TrialCandidate } from '@/lib/types'
import { Badge, Button, ErrorNote, inputCls, Loading, Notice } from './ui'
import { Panel } from './surfaces'

const TONE: Record<Cell, 'good' | 'bad' | 'warn'> = { TP: 'good', TN: 'good', FP: 'bad', FN: 'warn' }
const WINDOWS = [
  { hours: 6, label: 'Last 6 hours' },
  { hours: 24, label: 'Last 24 hours' },
  { hours: 72, label: 'Last 3 days' },
]

/**
 * The things the system just did (a card tap, a door closing, a camera report), ready to be turned into trials.
 * The system's answer and its response time are copied from the log. A person adds only what was really true, and that is
 * never filled in for them: a trial whose truth was guessed would measure nothing.
 */
export function CaptureQueue({ tz }: { tz: string }) {
  const qc = useQueryClient()
  const [hours, setHours] = useState(6)
  const [filter, setFilter] = useState<Subsystem | 'all'>('all')
  const [choice, setChoice] = useState<Record<string, string>>({})
  const [observer, setObserver] = useState(readObserver)
  const [notice, setNotice] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null)
  const [askAll, setAskAll] = useState(false)

  const q = useTrialCandidates(hours)
  const missing = isMissingMigration(q.error)
  const all = useMemo(() => q.data ?? [], [q.data])
  const counts = countBySubsystem(all)
  const list = filter === 'all' ? all : all.filter((c) => c.subsystem === filter)

  function refresh() {
    void qc.invalidateQueries({ queryKey: ['test-trials'] })
    void qc.invalidateQueries({ queryKey: ['trial-candidates'] })
    void qc.invalidateQueries({ queryKey: ['tap-link'] })
  }

  const capture = useMutation({
    mutationFn: async ({ c, condition }: { c: TrialCandidate; condition: string }) => {
      const r = await supabase.rpc('capture_trial', {
        p_subsystem: c.subsystem,
        p_source_id: c.source_id,
        p_condition: condition,
        p_observer: observer.trim(),
        p_notes: '',
      })
      if (r.error) throw new Error(r.error.message)
      return r.data as { code: string; result: Cell }
    },
    onSuccess: (r, { c }) => {
      setNotice({ tone: 'good', text: `Recorded ${r.code}: ${r.result}.` })
      saveObserver(observer)
      setChoice((x) => {
        const { [candidateKey(c)]: _gone, ...rest } = x
        return rest
      })
      refresh()
    },
    onError: (e) => {
      setNotice({ tone: 'bad', text: friendlyError(e, 'The trial was not recorded.') })
      refresh()
    },
  })

  const dismiss = useMutation({
    mutationFn: async (items: TrialCandidate[]) => {
      for (const s of SUBSYSTEMS) {
        const ids = items.filter((c) => c.subsystem === s).map((c) => c.source_id)
        if (ids.length === 0) continue
        const r = await supabase.rpc('dismiss_trial_candidates', { p_subsystem: s, p_source_ids: ids })
        if (r.error) throw new Error(r.error.message)
      }
      return items.length
    },
    onSuccess: (n) => {
      setAskAll(false)
      setNotice({ tone: 'good', text: n === 1 ? 'Left out. It will not be offered again.' : `${n} left out. They will not be offered again.` })
      refresh()
    },
    onError: (e) => setNotice({ tone: 'bad', text: friendlyError(e, 'Nothing was changed.') }),
  })

  return (
    <Panel
      title="Capture from the log"
      description="What the card checker, the key switches and the camera just did. Their answer and time are copied from the log; you say what was really true."
      action={
        <select className={inputCls.replace('w-full ', 'w-44 ')} aria-label="How far back" value={hours} onChange={(e) => setHours(Number(e.target.value))}>
          {WINDOWS.map((w) => (
            <option key={w.hours} value={w.hours}>
              {w.label}
            </option>
          ))}
        </select>
      }
    >
      {missing ? (
        <Notice tone="warn">
          Capturing from the log needs database update 12. Run <code className="rounded bg-amber-100 px-1">supabase/migrations/20261107000012_notifications_and_trial_capture.sql</code> in the Supabase SQL editor, then reload. You can still
          record trials by hand below.
        </Notice>
      ) : q.isLoading ? (
        <Loading />
      ) : q.error ? (
        <ErrorNote error={q.error} />
      ) : (
        <>
          {notice && <Notice tone={notice.tone}>{notice.text}</Notice>}

          <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
            <div className="inline-flex overflow-hidden rounded-md border border-ink-200" role="radiogroup" aria-label="Show">
              {(['all', ...SUBSYSTEMS] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  role="radio"
                  aria-checked={filter === s}
                  onClick={() => {
                    setFilter(s)
                    setAskAll(false)
                  }}
                  className={cn('h-9 px-3 text-[14px] font-medium', filter === s ? 'bg-ink-900 text-white' : 'bg-white text-ink-700 hover:bg-ink-50')}
                >
                  {s === 'all' ? `All (${all.length})` : `${SUBSYSTEM_SHORT[s]} (${counts[s]})`}
                </button>
              ))}
            </div>
            <label className="block w-full sm:w-56">
              <span className="mb-1 block text-[13px] font-medium text-ink-500">Observer</span>
              <input className={inputCls} value={observer} onChange={(e) => setObserver(e.target.value)} maxLength={100} placeholder="Your name" />
            </label>
          </div>

          {list.length === 0 ? (
            <p className="rounded-md border border-dashed border-ink-200 px-4 py-6 text-center text-[14px] text-ink-500">
              Nothing waiting. A tap, a door closing or a camera report appears here a moment after it happens. Ones you have recorded or left out are not shown again.
            </p>
          ) : (
            <ul className="divide-y divide-ink-100 rounded-md border border-ink-200" aria-label="Things the system did">
              {list.map((c) => {
                const key = candidateKey(c)
                const picked = choice[key] ?? ''
                const cell = picked ? previewCell(c, picked) : null
                const busy = (capture.isPending && capture.variables && candidateKey(capture.variables.c) === key) || false
                const detail = candidateDetail(c)
                return (
                  <li key={key} className="flex flex-col gap-3 px-3 py-3 lg:flex-row lg:items-center lg:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge>{SUBSYSTEM_SHORT[c.subsystem]}</Badge>
                        <span className="font-medium">{candidateWhat(c)}</span>
                      </div>
                      <div className="mt-0.5 text-[14px] text-ink-700">
                        The system said: <strong>{candidateSaid(c)}</strong>
                        {detail ? <span className="text-ink-500"> ({detail})</span> : null}
                      </div>
                      <div className="text-[12px] text-ink-500">
                        {fmtDateTime(c.occurred_at, tz)} · {fmtRelative(c.occurred_at)}
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <select
                        className={`${inputCls} w-full sm:w-72`}
                        value={picked}
                        aria-label={`What was really true: ${candidateWhat(c)}, ${fmtDateTime(c.occurred_at, tz)}`}
                        onChange={(e) => setChoice((x) => ({ ...x, [key]: e.target.value }))}
                      >
                        <option value="">What was really true?</option>
                        {conditionChoices(c.subsystem).map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                      {cell && (
                        <span title="How this trial will count">
                          <Badge tone={TONE[cell]}>{cell}</Badge>
                        </span>
                      )}
                      <Button disabled={!picked || busy} busy={busy} onClick={() => capture.mutate({ c, condition: picked })}>
                        Record
                      </Button>
                      <Button variant="ghost" disabled={dismiss.isPending} onClick={() => dismiss.mutate([c])}>
                        Not a test
                      </Button>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}

          {list.length > 1 && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {askAll ? (
                <>
                  <span className="text-[14px] text-ink-700">Leave out all {list.length} shown? They will not be offered again.</span>
                  <Button variant="danger" busy={dismiss.isPending} onClick={() => dismiss.mutate(list)}>
                    Yes, leave them out
                  </Button>
                  <Button variant="ghost" onClick={() => setAskAll(false)}>
                    Keep them
                  </Button>
                </>
              ) : (
                <Button variant="secondary" onClick={() => setAskAll(true)}>
                  Not tests: leave out all {list.length} shown
                </Button>
              )}
            </div>
          )}

          <p className="mt-3 text-[12px] text-ink-500">
            Each tap, door closing or camera report can become one trial only. For the camera, the newest report of each room is offered. A denied tap shows no room, because the
            locker does not release a key for it. “Not a test” hides things that were not part of the evaluation, such as lessons held for real.
          </p>
        </>
      )}
    </Panel>
  )
}
