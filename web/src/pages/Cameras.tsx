import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, KeyRound, Plus, ScanSearch, Trash2 } from 'lucide-react'
import { useAuth } from '@/auth/AuthProvider'
import { CameraTile } from '@/components/CameraTile'
import { Modal } from '@/components/Modal'
import { Segmented } from '@/components/controls'
import { Rivet } from '@/components/surfaces'
import { Badge, Button, EmptyState, ErrorNote, inputCls, Loading, Notice } from '@/components/ui'
import { unwrap, useRooms } from '@/lib/api'
import { friendlyError } from '@/lib/errors'
import { needsAttention } from '@/lib/presence/labels'
import { whepUrl } from '@/lib/presence/whep'
import { supabase } from '@/lib/supabase'
import type { CameraRow, RoomStatus } from '@/lib/types'

const GATEWAY_OK = /^https?:\/\/[^/\s?#@]+$/
const STREAM_OK = /^[A-Za-z0-9_.~-]+(\/[A-Za-z0-9_.~-]+)*$/

interface Form {
  id?: string
  room_id: string
  label: string
  gateway_url: string
  stream_path: string
  is_active: boolean
}

/** A checkbox drawn as an on/off switch. */
const SWITCH =
  "relative h-5 w-9 shrink-0 cursor-pointer appearance-none rounded-full bg-ink-300 transition-colors checked:bg-brass-400 before:absolute before:left-0.5 before:top-0.5 before:size-4 before:rounded-full before:bg-white before:transition-transform before:content-[''] checked:before:translate-x-4"

/** A setting kept on this device only (whether the people count is on). */
function useLocalFlag(key: string, initial: boolean): [boolean, (v: boolean) => void] {
  const [value, setValue] = useState(() => {
    try {
      const v = window.localStorage.getItem(key)
      return v === null ? initial : v === '1'
    } catch {
      return initial
    }
  })
  const set = (v: boolean) => {
    setValue(v)
    try {
      window.localStorage.setItem(key, v ? '1' : '0')
    } catch {
      /* private window: the choice just lasts until the page closes */
    }
  }
  return [value, set]
}

export default function Cameras() {
  const { profile } = useAuth()
  const qc = useQueryClient()
  const isAdmin = profile?.role === 'admin'
  const [presenceOn, setPresenceOn] = useLocalFlag('c360.presence', true)
  const [showBoxes, setShowBoxes] = useLocalFlag('c360.boxes', true)
  const [form, setForm] = useState<Form | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [notice, setNotice] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null)

  const cameras = useQuery({
    queryKey: ['cameras'],
    queryFn: () =>
      unwrap<CameraRow[]>(
        supabase.from('cameras').select('id, room_id, label, gateway_url, stream_path, is_active, rooms(code, name)').order('created_at'),
      ),
  })
  const status = useQuery({
    queryKey: ['room-status'],
    queryFn: () => unwrap<RoomStatus[]>(supabase.from('room_status_now').select('*').order('room_code')),
    refetchInterval: 15_000,
  })
  const rooms = useRooms()

  const sorted = useMemo(
    () =>
      [...(cameras.data ?? [])].sort(
        (a, b) => (a.rooms?.code ?? '').localeCompare(b.rooms?.code ?? '') || a.label.localeCompare(b.label),
      ),
    [cameras.data],
  )
  const active = sorted.filter((c) => c.is_active)
  const off = sorted.filter((c) => !c.is_active)
  const statusByRoom = new Map((status.data ?? []).map((r) => [r.room_id, r]))
  const [show, setShow] = useState<'all' | 'attention'>('all')
  const flaggedCount = active.filter((c) => {
    const st = statusByRoom.get(c.room_id)
    return st ? needsAttention(st) : false
  }).length
  const shownCameras = show === 'all' || active.length < 2 ? active : active.filter((c) => {
    const st = statusByRoom.get(c.room_id)
    return st ? needsAttention(st) : false
  })
  // with two cameras in a room, only the first one counts people, so the room has one reading
  const primary = new Set<string>()
  const seenRooms = new Set<string>()
  for (const c of active) {
    if (!seenRooms.has(c.room_id)) {
      seenRooms.add(c.room_id)
      primary.add(c.id)
    }
  }
  const perRoom = new Map<string, number>()
  for (const c of active) perRoom.set(c.room_id, (perRoom.get(c.room_id) ?? 0) + 1)

  useEffect(() => setConfirmDelete(false), [form?.id])

  /** changes to the form clear an old error message, so it never describes a value that is gone */
  const edit = (patch: Partial<Form>) => {
    setFormError(null)
    setForm((f) => (f ? { ...f, ...patch } : f))
  }

  function open(c?: CameraRow) {
    setFormError(null)
    setNotice(null)
    const last = sorted[sorted.length - 1]
    setForm(
      c
        ? { id: c.id, room_id: c.room_id, label: c.label, gateway_url: c.gateway_url, stream_path: c.stream_path, is_active: c.is_active }
        : { room_id: rooms.data?.[0]?.id ?? '', label: 'Camera', gateway_url: last?.gateway_url ?? '', stream_path: '', is_active: true },
    )
  }

  const save = useMutation({
    mutationFn: async (f: Form) => {
      const row = { room_id: f.room_id, label: f.label.trim(), gateway_url: f.gateway_url.trim().replace(/\/+$/, ''), stream_path: f.stream_path.trim(), is_active: f.is_active }
      if (f.id) await unwrap(supabase.from('cameras').update(row).eq('id', f.id).select('id'))
      else await unwrap(supabase.from('cameras').insert({ ...row, tenant_id: profile!.tenant_id }).select('id'))
      return f.id ? 'Camera saved.' : 'Camera added.'
    },
    onSuccess: (text) => {
      setNotice({ tone: 'good', text })
      setForm(null)
      void qc.invalidateQueries({ queryKey: ['cameras'] })
      void qc.invalidateQueries({ queryKey: ['audit'] })
    },
    onError: (err) => {
      const msg = err instanceof Error ? err.message : ''
      setFormError(msg.includes('duplicate key') ? 'That room already has a camera with this label. Give it another label.' : friendlyError(err, 'The camera was not saved.'))
    },
  })

  const remove = useMutation({
    mutationFn: async (id: string) => {
      await unwrap(supabase.from('cameras').delete().eq('id', id).select('id'))
    },
    onSuccess: () => {
      setNotice({ tone: 'good', text: 'Camera deleted.' })
      setForm(null)
      void qc.invalidateQueries({ queryKey: ['cameras'] })
      void qc.invalidateQueries({ queryKey: ['audit'] })
    },
    onError: (err) => {
      setConfirmDelete(false)
      setFormError(friendlyError(err, 'The camera was not deleted.'))
    },
  })

  function submit(e: FormEvent) {
    e.preventDefault()
    if (!form) return
    setFormError(null)
    if (!form.room_id) return setFormError('Choose the room this camera watches.')
    if (!form.label.trim() || form.label.trim().length > 60) return setFormError('Give the camera a short label, for example "Front".')
    const gw = form.gateway_url.trim().replace(/\/+$/, '')
    if (!GATEWAY_OK.test(gw)) return setFormError('The gateway address looks like http://192.168.1.50:8889: no path, no password.')
    const path = form.stream_path.trim()
    if (!STREAM_OK.test(path) || path.split('/').some((p) => p === '.' || p === '..')) {
      return setFormError('The stream name is letters, digits, dashes and dots, for example lrc-301.')
    }
    save.mutate(form)
  }

  const nothing = !cameras.isLoading && !cameras.error && sorted.length === 0

  return (
    <>
      <header className="mb-6 flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
        <div className="min-w-0 max-w-[62ch]">
          <h1 className="font-display text-[34px] font-semibold leading-none tracking-[-0.02em]">Cameras</h1>
          <p className="mt-2 text-ink-500">
            Live pictures from the classroom cameras. This device counts the people it can see and reports only the number: no face is identified and nothing is recorded.
          </p>
          {sorted.length > 0 && (
            <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-[13.5px] text-ink-600">
              <div className="flex gap-1.5">
                <dd className="font-semibold text-ink-900">{active.length}</dd>
                <dt>{active.length === 1 ? 'Camera on' : 'Cameras on'}</dt>
              </div>
              {isAdmin && off.length > 0 && (
                <div className="flex gap-1.5">
                  <dd className="font-semibold text-ink-900">{off.length}</dd>
                  <dt>Switched off</dt>
                </div>
              )}
              <div className="flex gap-1.5">
                <dd className={flaggedCount > 0 ? 'font-semibold text-rose-700' : 'font-semibold text-ink-900'}>{flaggedCount}</dd>
                <dt>Rooms to look at</dt>
              </div>
            </dl>
          )}
        </div>
        {isAdmin && (
          <Button onClick={() => open()} disabled={rooms.isLoading || (rooms.data ?? []).length === 0}>
            <Plus className="size-4" aria-hidden />
            Add camera
          </Button>
        )}
      </header>

      {notice && (
        <Notice tone={notice.tone} onDismiss={() => setNotice(null)}>
          {notice.text}
        </Notice>
      )}

      {/* the monitor wall: a dark panel screwed to the wall of the security office, one steel-framed monitor per camera */}
      <section aria-label="Monitor wall" className="relative overflow-hidden rounded-2xl bg-ink-950 p-3 shadow-[0_18px_34px_-18px_rgb(11_21_36/0.7)] ring-1 ring-ink-800 sm:p-5">
        <Rivet className="left-2.5 top-2.5" />
        <Rivet className="right-2.5 top-2.5" />
        <Rivet className="bottom-2.5 left-2.5" />
        <Rivet className="bottom-2.5 right-2.5" />

        {sorted.length > 0 && (
          <div className="mb-4 flex flex-wrap items-center gap-x-6 gap-y-3 border-b border-ink-800 pb-4 text-[14px] text-ink-100">
            {/* real checkboxes drawn as switches, so they keep their labels and keyboard behaviour */}
            <label className="flex cursor-pointer items-center gap-2.5">
              <input type="checkbox" checked={presenceOn} onChange={(e) => setPresenceOn(e.target.checked)} className={SWITCH} />
              Count people on this device
            </label>
            <label className="flex cursor-pointer items-center gap-2.5">
              <input type="checkbox" checked={showBoxes} onChange={(e) => setShowBoxes(e.target.checked)} className={SWITCH} />
              Show what was counted
            </label>
            {active.length > 1 && (
              <Segmented
                label="Show cameras"
                value={show}
                onChange={setShow}
                options={[
                  { value: 'all', label: 'All', count: active.length },
                  { value: 'attention', label: 'Needs a look', count: flaggedCount },
                ]}
              />
            )}
            <span className="text-[13px] text-ink-400">Keep this page open and visible for the count to run.</span>
          </div>
        )}

        {cameras.isLoading ? (
          <div className="rounded-md bg-ink-900 text-ink-200 [&_.skeleton]:bg-ink-800">
            <Loading rows={3} />
          </div>
        ) : cameras.error ? (
          <ErrorNote error={cameras.error} onRetry={() => void cameras.refetch()} />
        ) : nothing ? (
          <div className="rounded-md border border-dashed border-ink-600 text-ink-200 [&_.font-display]:text-white [&_div]:text-ink-300">
            <EmptyState title="No cameras yet">
              {isAdmin
                ? 'Use Add camera to connect a room’s camera. You need the address of the parent Raspberry Pi and the stream name of that room.'
                : 'An administrator connects each room’s camera here.'}
            </EmptyState>
          </div>
        ) : shownCameras.length === 0 ? (
          <div className="rounded-md border border-dashed border-ink-600 text-ink-200 [&_.font-display]:text-white [&_div]:text-ink-300">
            <EmptyState title={show === 'attention' && active.length > 1 ? 'No camera needs a look' : 'No cameras are switched on'}>
              {show === 'attention' && active.length > 1 ? 'Every room with a camera matches its timetable and key.' : 'Edit a camera under Switched off to use it again.'}
            </EmptyState>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 2xl:grid-cols-3">
            {shownCameras.map((c, i) => (
              <CameraTile
                key={c.id}
                camera={c}
                status={statusByRoom.get(c.room_id)}
                checking={presenceOn && primary.has(c.id)}
                showBoxes={showBoxes}
                canEdit={isAdmin}
                onEdit={() => open(c)}
                showLabel={(perRoom.get(c.room_id) ?? 0) > 1}
                channel={i + 1}
              />
            ))}
          </div>
        )}

        {isAdmin && off.length > 0 && (
          <div className="mt-5 border-t border-ink-800 pt-4">
            <h2 className="font-display text-[17px] font-semibold leading-6 text-white">Switched off</h2>
            <p className="text-[13px] text-ink-400">These cameras are not shown above and do not count people.</p>
            <ul className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
              {off.map((c) => (
                <li key={c.id} className="flex items-center justify-between gap-3 rounded-md bg-ink-900 px-3 py-2 text-[14px] ring-1 ring-ink-800">
                  <span className="flex items-center gap-2.5">
                    <span aria-hidden className="size-2 rounded-full bg-ink-700 ring-1 ring-ink-600" />
                    <span>
                      <span className="font-medium text-ink-100">{c.rooms?.code}</span> <span className="text-ink-400">{c.label}</span>
                    </span>
                  </span>
                  <Button variant="ghost" className="text-ink-200! hover:bg-ink-800! hover:text-white!" onClick={() => open(c)} aria-label={`Edit camera ${c.rooms?.code} ${c.label}`}>
                    Edit
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <section aria-labelledby="how-check" className="mt-10">
        <h2 id="how-check" className="font-display text-[21px] font-semibold leading-6">
          How the check works
        </h2>
        <ol className="mt-4 grid gap-4 md:grid-cols-3">
          {[
            {
              icon: KeyRound,
              head: 'The key comes first.',
              body: 'A class is on, the instructor took the key, and the camera sees people: the teacher is present. Key still in the locker after the grace period and nobody seen: the teacher is not here.',
            },
            {
              icon: ScanSearch,
              head: 'The camera is a person detector, not face recognition.',
              body: 'It counts people in the picture on the device that is showing it. The picture is not sent or kept; only the number of people is saved.',
            },
            {
              icon: Download,
              head: 'The count needs the model file.',
              body: (
                <>
                  If a camera says it is missing, run <code className="rounded bg-ink-100 px-1">npm run setup:presence</code> in the web folder once, then reload.
                </>
              ),
            },
          ].map((s, i) => (
            <li key={s.head} className="relative rounded-md bg-white p-4 ring-1 ring-ink-200">
              {i < 2 && (
                <span aria-hidden className="absolute -right-[18px] top-9 z-10 hidden h-px w-[18px] bg-ink-300 md:block after:absolute after:-right-px after:-top-[3px] after:size-1.5 after:rotate-45 after:border-r after:border-t after:border-ink-400" />
              )}
              <span className="mb-3 grid size-9 place-items-center rounded-full bg-ink-900 text-brass-300">
                <s.icon className="size-[18px]" aria-hidden />
              </span>
              <div className="font-medium text-ink-900">{s.head}</div>
              <p className="mt-1 text-[13.5px] leading-[1.55] text-ink-600">{s.body}</p>
            </li>
          ))}
        </ol>
      </section>

      <Modal
        open={form !== null}
        onClose={() => setForm(null)}
        title={form?.id ? 'Edit camera' : 'Add camera'}
        footer={
          <>
            {form?.id && (
              <Button variant="ghost" className="mr-auto text-rose-700" onClick={() => setConfirmDelete(true)} disabled={remove.isPending}>
                <Trash2 className="size-4" aria-hidden />
                Delete camera
              </Button>
            )}
            <Button variant="ghost" onClick={() => setForm(null)}>
              Cancel
            </Button>
            <Button type="submit" form="camera-form" busy={save.isPending}>
              Save
            </Button>
          </>
        }
      >
        {form && (
          <form id="camera-form" onSubmit={submit} className="space-y-3">
            {confirmDelete && form.id && (
              <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2.5 text-[14px] text-rose-950" role="alertdialog" aria-label="Confirm delete">
                <div className="font-medium">Delete this camera?</div>
                <p className="mt-0.5 text-[13px]">The room stays. Only the link to the camera is removed; you can add it again.</p>
                <div className="mt-2 flex gap-2">
                  <Button type="button" variant="danger" busy={remove.isPending} onClick={() => remove.mutate(form.id!)}>
                    Yes, delete it
                  </Button>
                  <Button type="button" variant="secondary" onClick={() => setConfirmDelete(false)}>
                    Keep it
                  </Button>
                </div>
              </div>
            )}
            <label className="block">
              <span className="mb-1 block text-[13px] font-medium text-ink-700">Room</span>
              <select value={form.room_id} onChange={(e) => edit({ room_id: e.target.value })} className={inputCls}>
                {(rooms.data ?? []).map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.code}
                    {r.name ? `, ${r.name}` : ''}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-[13px] font-medium text-ink-700">Label</span>
              <input value={form.label} onChange={(e) => edit({ label: e.target.value })} className={inputCls} maxLength={60} />
              <span className="mt-1 block text-[12.5px] text-ink-500">Only matters when a room has two cameras, for example Front and Back.</span>
            </label>
            <label className="block">
              <span className="mb-1 block text-[13px] font-medium text-ink-700">Gateway address</span>
              <input
                value={form.gateway_url}
                onChange={(e) => edit({ gateway_url: e.target.value })}
                className={inputCls}
                placeholder="http://192.168.1.50:8889"
                autoComplete="off"
                spellCheck={false}
              />
              <span className="mt-1 block text-[12.5px] text-ink-500">The parent Raspberry Pi. No password goes here; camera passwords stay on the Pi.</span>
            </label>
            <label className="block">
              <span className="mb-1 block text-[13px] font-medium text-ink-700">Stream name</span>
              <input
                value={form.stream_path}
                onChange={(e) => edit({ stream_path: e.target.value })}
                className={inputCls}
                placeholder="lrc-301"
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            {GATEWAY_OK.test(form.gateway_url.trim().replace(/\/+$/, '')) && STREAM_OK.test(form.stream_path.trim()) && (
              <p className="break-all text-[12.5px] text-ink-500">
                The picture is read from <code className="rounded bg-ink-100 px-1">{whepUrl(form.gateway_url.trim(), form.stream_path.trim())}</code>
              </p>
            )}
            <label className="flex cursor-pointer items-center gap-2 text-[14px]">
              <input type="checkbox" checked={form.is_active} onChange={(e) => edit({ is_active: e.target.checked })} className="size-4 accent-ink-900" />
              In use
              {!form.is_active && <Badge>Switched off</Badge>}
            </label>
            {formError && <Notice tone="bad">{formError}</Notice>}
          </form>
        )}
      </Modal>
    </>
  )
}
