import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowRight, CreditCard, Nfc, Settings2, Video } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useAuth } from '@/auth/AuthProvider'
import { KeyTag } from '@/components/KeyTag'
import { Screw } from '@/components/Ledger'
import { Modal } from '@/components/Modal'
import { ResultNote, SearchInput, Segmented } from '@/components/controls'
import { KeyBadge, OccupancyBadge, keyTagTone } from '@/components/StatusBadges'
import { Badge, Button, EmptyState, ErrorNote, inputCls, Loading, Notice } from '@/components/ui'
import { useNow } from '@/hooks/useRealtimeSync'
import { unwrap, useRooms, useStationStatus } from '@/lib/api'
import { cn } from '@/lib/cn'
import { friendlyError } from '@/lib/errors'
import { DISCREPANCY_LABEL } from '@/lib/format'
import { supabase } from '@/lib/supabase'
import { needsAttention, peopleText, presenceInfo } from '@/lib/presence/labels'
import { matchesQuery, sortRows } from '@/lib/tableView'
import { fmtDateTime, fmtElapsed, fmtRange, fmtRelative } from '@/lib/time'
import type { LockerStatusRow, RoomStatus } from '@/lib/types'

/** The key locker is a single cabinet with four doors; each door holds the key to one room. */
const DOORS = [1, 2, 3, 4] as const

function Door({ n, locker, tz, now }: { n: number; locker: LockerStatusRow | undefined; tz: string; now: number }) {
  const status = locker?.key_status
  const out = Boolean(locker) && status !== 'available'
  return (
    <div
      className={cn(
        'relative flex min-h-[318px] flex-col rounded-lg border-2 bg-gradient-to-b from-ink-800 to-[#16273e] p-4 pl-5 shadow-[inset_0_1px_0_rgb(255_255_255/0.06),inset_0_-14px_24px_-18px_rgb(0_0_0/0.6)] transition-colors',
        !locker && 'border-dashed border-ink-600 bg-none',
        locker && status === 'available' && 'border-ink-600 hover:border-ink-500',
        status === 'issued' && 'border-brass-400',
        status === 'outstanding' && 'border-rose-400',
      )}
    >
      {/* the hinges down the left edge and the handle on the right, so each door reads as a door */}
      <span aria-hidden className="absolute -left-[4px] top-8 h-9 w-[6px] rounded-sm bg-ink-600" />
      <span aria-hidden className="absolute -left-[4px] bottom-8 h-9 w-[6px] rounded-sm bg-ink-600" />
      <span aria-hidden className="absolute -right-[4px] top-1/2 h-14 w-[6px] -translate-y-1/2 rounded-sm bg-ink-500" />
      {/* the door's lamp: dim while the key is inside, brass while it is out, red and blinking when it has not come back */}
      {locker && (
        <span
          className={cn(
            'absolute right-4 top-4 size-2.5 rounded-full',
            status === 'issued' ? 'bg-brass-400 shadow-[0_0_8px_var(--color-brass-400)]' : status === 'outstanding' ? 'bg-rose-400 shadow-[0_0_8px_var(--color-rose-400)] motion-safe:animate-pulse' : 'bg-ink-500',
          )}
          aria-hidden
        />
      )}
      <div className="text-[13px] font-medium leading-4 text-ink-300">
        Door <span className="ml-0.5 align-middle font-display text-[40px] font-semibold leading-8 text-brass-300">{n}</span>
      </div>
      <div className="mt-2 flex h-[22px] items-center">{locker && <KeyBadge status={locker.key_status} />}</div>

      {/* the recess where the key hangs: on its hook while it is in, and an empty hook while it is out */}
      <div className="relative mt-3 flex h-[122px] flex-col items-center overflow-hidden rounded-md bg-ink-950 shadow-[inset_0_2px_8px_rgb(0_0_0/0.7)] ring-1 ring-ink-700">
        <span aria-hidden className="mt-2 h-1.5 w-[84%] rounded-full bg-ink-700" />
        <span aria-hidden className={cn('-mt-px h-3.5 w-3.5 rounded-b-full border-2 border-t-0', out ? 'border-brass-400' : 'border-ink-400')} />
        {locker && !out && <span aria-hidden className="h-2 w-px bg-ink-400" />}
        <div className={cn(!out && !locker ? 'mt-1.5' : out ? 'mt-3.5' : '', locker && !out && '-rotate-1', out && 'opacity-45 outline-dashed outline-1 outline-offset-4 outline-ink-500')}>
          {locker ? (
            <KeyTag code={locker.room_code} tone={keyTagTone(locker.key_status)} size="lg" />
          ) : (
            <span className="text-[13px] text-ink-400">No room assigned</span>
          )}
        </div>
      </div>

      <div className="mt-3 min-h-[56px] text-[13px] text-ink-300">
        {locker && locker.key_status === 'available' && <span className="text-ink-400">Key is in the locker</span>}
        {locker && locker.key_status !== 'available' && (
          <>
            <div className="text-[15px] font-medium text-white">{locker.holder_name ?? 'Unknown holder'}</div>
            {locker.issued_at && <div>Taken {fmtDateTime(locker.issued_at, tz)}</div>}
            {locker.issued_at && <div className={status === 'outstanding' ? 'text-rose-300' : 'text-ink-400'}>Out for {fmtElapsed(locker.issued_at, now)}</div>}
          </>
        )}
      </div>
    </div>
  )
}

interface LockerRow {
  id: string
  room_id: string
  station_label: string
  compartment_no: number
  is_active: boolean
}

/** Which room's key is in each door (administrators). Two keys can trade doors in one save. */
function DoorSetup({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: (text: string) => void }) {
  const qc = useQueryClient()
  const rooms = useRooms()
  const config = useQuery({
    queryKey: ['lockers-config'],
    enabled: open,
    queryFn: () => unwrap<LockerRow[]>(supabase.from('lockers').select('id, room_id, station_label, compartment_no, is_active').order('compartment_no')),
  })
  const [station, setStation] = useState('')
  const [doors, setDoors] = useState<Record<number, { room_id: string; is_active: boolean }>>({})
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open || !config.data) return
    const first = config.data[0]
    setStation(first?.station_label ?? 'LRC 3rd floor key locker')
    const next: Record<number, { room_id: string; is_active: boolean }> = {}
    for (const n of DOORS) {
      const row = config.data.find((l) => l.compartment_no === n && l.station_label === (first?.station_label ?? ''))
      next[n] = { room_id: row?.room_id ?? '', is_active: row?.is_active ?? true }
    }
    setDoors(next)
    setError(null)
  }, [open, config.data])

  const save = useMutation({
    mutationFn: async () => {
      const list = DOORS.filter((n) => doors[n]?.room_id).map((n) => ({ door: n, room_id: doors[n]!.room_id, is_active: doors[n]!.is_active }))
      return unwrap<{ changed: number }>(supabase.rpc('set_locker_doors', { p_station: station.trim(), p_doors: list }))
    },
    onSuccess: (r) => {
      onSaved(r.changed === 0 ? 'The doors were already set that way.' : `Saved the locker doors (${r.changed} changed).`)
      for (const k of ['lockers-config', 'locker-status', 'room-status', 'audit']) void qc.invalidateQueries({ queryKey: [k] })
      onClose()
    },
    onError: (err) => setError(friendlyError(err, 'The doors were not saved.')),
  })

  function submit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    const picked = DOORS.map((n) => doors[n]?.room_id).filter(Boolean)
    if (picked.length === 0) return setError('Choose a room for at least one door.')
    if (new Set(picked).size !== picked.length) return setError('A room’s key can be in one door only. Two doors have the same room.')
    if (!station.trim()) return setError('Give the locker a name.')
    for (const l of config.data ?? []) {
      if (l.station_label === station.trim() && !doors[l.compartment_no]?.room_id) return setError(`Door ${l.compartment_no} already has a room. Choose another room for it (a door with a history cannot be emptied).`)
    }
    save.mutate()
  }

  const roomList = rooms.data ?? []
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Set up the key locker"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="door-form" busy={save.isPending} disabled={config.isLoading}>
            Save
          </Button>
        </>
      }
    >
      {config.isLoading ? (
        <Loading />
      ) : config.error ? (
        <ErrorNote error={config.error} />
      ) : (
        <form id="door-form" onSubmit={submit} className="space-y-3">
          <label className="block">
            <span className="mb-1 block text-[13px] font-medium text-ink-700">Locker name</span>
            <input
              value={station}
              onChange={(e) => setStation(e.target.value)}
              disabled={(config.data ?? []).length > 0}
              className={inputCls}
              aria-describedby="station-help"
            />
            {(config.data ?? []).length > 0 && (
              <span id="station-help" className="mt-1 block text-[12.5px] text-ink-500">
                The locker station knows itself by this name, so it is not changed here.
              </span>
            )}
          </label>
          <p className="text-[13px] text-ink-600">
            Choose which room’s key is in each door. To swap two keys, give each door the other’s room and save once. A door that has been used
            is kept (with its history); switch it off instead of emptying it.
          </p>
          <div className="space-y-2">
            {DOORS.map((n) => {
              const existing = (config.data ?? []).some((l) => l.compartment_no === n)
              return (
                <div key={n} className="grid items-center gap-2 sm:grid-cols-[5rem_1fr_auto]">
                  <span className="text-[14px] font-medium">Door {n}</span>
                  <select
                    aria-label={`Room for door ${n}`}
                    value={doors[n]?.room_id ?? ''}
                    onChange={(e) => setDoors({ ...doors, [n]: { room_id: e.target.value, is_active: doors[n]?.is_active ?? true } })}
                    className={inputCls}
                  >
                    <option value="" disabled={existing}>
                      Not used
                    </option>
                    {roomList.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.code}
                        {r.name ? `, ${r.name}` : ''}
                      </option>
                    ))}
                  </select>
                  <label className="flex items-center gap-2 text-[14px]">
                    <input
                      type="checkbox"
                      checked={doors[n]?.is_active ?? true}
                      disabled={!doors[n]?.room_id}
                      onChange={(e) => setDoors({ ...doors, [n]: { room_id: doors[n]?.room_id ?? '', is_active: e.target.checked } })}
                      className="size-4 accent-ink-900"
                    />
                    In use
                  </label>
                </div>
              )
            })}
          </div>
          {error && <Notice tone="bad">{error}</Notice>}
        </form>
      )}
    </Modal>
  )
}

interface CardRow {
  id: string
  instructor_id: string
  card_uid: string
  is_active: boolean
  issued_at: string
}

/** The RFID card each instructor uses at the locker (administrators). */
function KeyCards({ tz, onNotice }: { tz: string; onNotice: (n: { tone: 'good' | 'bad'; text: string }) => void }) {
  const qc = useQueryClient()
  const people = useQuery({
    queryKey: ['card-instructors'],
    queryFn: () => unwrap<{ id: string; full_name: string; employee_no: string | null }[]>(supabase.from('instructors').select('id, full_name, employee_no').eq('is_active', true).order('full_name')),
  })
  const cards = useQuery({
    queryKey: ['cards'],
    queryFn: () => unwrap<CardRow[]>(supabase.from('rfid_cards').select('id, instructor_id, card_uid, is_active, issued_at').eq('is_active', true)),
  })
  const [target, setTarget] = useState<{ id: string; name: string; has: boolean } | null>(null)
  const [search, setSearch] = useState('')
  const [cardShow, setCardShow] = useState<'all' | 'none'>('all')
  const [order, setOrder] = useState<'name' | 'given'>('name')
  const [uid, setUid] = useState('')
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    setUid('')
    setError(null)
  }, [target?.id])

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['cards'] })
    void qc.invalidateQueries({ queryKey: ['audit'] })
    void qc.invalidateQueries({ queryKey: ['instructors'] })
  }
  const assign = useMutation({
    mutationFn: async () => unwrap<{ card_uid: string; instructor: string; replaced: number }>(supabase.rpc('assign_card', { p_instructor_id: target!.id, p_card_uid: uid })),
    onSuccess: (r) => {
      onNotice({ tone: 'good', text: `Card ${r.card_uid} is now ${r.instructor}’s${r.replaced > 0 ? '. The old card no longer opens the locker' : ''}.` })
      setTarget(null)
      refresh()
    },
    onError: (err) => setError(friendlyError(err, 'The card was not saved.')),
  })
  const remove = useMutation({
    mutationFn: async (c: { id: string; name: string }) => {
      await unwrap(supabase.from('rfid_cards').update({ is_active: false }).eq('id', c.id))
      return c.name
    },
    onSuccess: (name) => {
      onNotice({ tone: 'good', text: `${name}’s card was switched off. It no longer opens the locker.` })
      refresh()
    },
    onError: (err) => onNotice({ tone: 'bad', text: friendlyError(err, 'The card was not changed.') }),
  })

  const byPerson = useMemo(() => new Map((cards.data ?? []).map((c) => [c.instructor_id, c])), [cards.data])
  const everyone = people.data ?? []
  const without = everyone.filter((p) => !byPerson.has(p.id)).length
  const filtering = Boolean(search.trim()) || cardShow !== 'all'
  const list = useMemo(() => {
    const kept = everyone.filter((p) => (cardShow === 'all' || !byPerson.has(p.id)) && matchesQuery(`${p.full_name} ${p.employee_no ?? ''}`, search))
    const get = order === 'given' ? (p: (typeof everyone)[number]) => byPerson.get(p.id)?.issued_at : (p: (typeof everyone)[number]) => p.full_name
    return sortRows(kept, get, order === 'given' ? 'desc' : 'asc')
  }, [everyone, byPerson, cardShow, search, order])
  return (
    <>
      <section className="mt-12" aria-labelledby="cards-title">
        <div className="mb-5 flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
          <div className="max-w-[60ch]">
            <h2 id="cards-title" className="font-display text-[24px] font-semibold leading-7">
              Key cards
            </h2>
            <p className="text-[13.5px] text-ink-500">One RFID card per instructor. A card opens a door only while its holder is scheduled in that room.</p>
          </div>
          {everyone.length > 0 && (
            <div className="flex flex-wrap items-center gap-3">
              <SearchInput value={search} onChange={setSearch} label="Search key cards" placeholder="Search name or number" className="w-full sm:w-64" />
              <Segmented
                label="Show instructors"
                value={cardShow}
                onChange={setCardShow}
                options={[
                  { value: 'all', label: 'All', count: everyone.length },
                  { value: 'none', label: 'No card', count: without },
                ]}
              />
              <Segmented
                label="Order the cards"
                value={order}
                onChange={setOrder}
                options={[
                  { value: 'name', label: 'By name' },
                  { value: 'given', label: 'Newest first' },
                ]}
              />
              {filtering && <ResultNote shown={list.length} total={everyone.length} noun={['instructor', 'instructors']} />}
            </div>
          )}
        </div>
        {people.isLoading || cards.isLoading ? (
          <Loading rows={4} />
        ) : people.error || cards.error ? (
          <ErrorNote error={people.error ?? cards.error} />
        ) : everyone.length === 0 ? (
          <div className="rounded-md border border-dashed border-ink-300 bg-white/50">
            <EmptyState title="No instructors yet">Add instructors first, then give each a card.</EmptyState>
          </div>
        ) : list.length === 0 ? (
          <div className="rounded-md border border-dashed border-ink-300 bg-white/50">
            <EmptyState
              title="No instructor matches"
              action={
                <Button
                  variant="secondary"
                  onClick={() => {
                    setSearch('')
                    setCardShow('all')
                  }}
                >
                  Clear search and filters
                </Button>
              }
            >
              {cardShow === 'none' && !search.trim() ? 'Every instructor has a card.' : 'Try another name or number.'}
            </EmptyState>
          </div>
        ) : (
          <ul className="grid gap-x-5 gap-y-6 sm:grid-cols-2 xl:grid-cols-3">
            {list.map((p) => {
              const c = byPerson.get(p.id)
              return (
                <li key={p.id}>
                  <div
                    className={cn(
                      'relative flex h-[148px] flex-col justify-between overflow-hidden rounded-xl p-4',
                      c
                        ? 'bg-gradient-to-br from-ink-800 via-ink-900 to-ink-950 text-white shadow-[0_14px_22px_-16px_rgb(11_21_36/0.9)] ring-1 ring-ink-700'
                        : 'border-2 border-dashed border-ink-300 bg-white/50 text-ink-700',
                    )}
                  >
                    {c && <span aria-hidden className="absolute -right-10 -top-12 size-40 rounded-full bg-brass-400/10 ring-1 ring-brass-300/15" />}
                    <div className="relative flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate font-display text-[20px] font-semibold leading-6">{p.full_name}</div>
                        {p.employee_no && <div className={cn('text-[13px]', c ? 'text-ink-300' : 'text-ink-500')}>{p.employee_no}</div>}
                      </div>
                      {c ? <Nfc className="size-5 shrink-0 text-brass-300" aria-hidden /> : <Badge tone="warn">No card</Badge>}
                    </div>
                    {c ? (
                      <div className="relative flex items-end justify-between gap-3">
                        <span aria-hidden className="h-6 w-8 rounded-[5px] bg-gradient-to-br from-brass-200 to-brass-500 ring-1 ring-brass-600/40" />
                        <code className="font-mono text-[15px] tracking-[0.08em] text-brass-100">{c.card_uid}</code>
                      </div>
                    ) : (
                      <div className="text-[13px] text-ink-500">Nothing opens the locker for this person yet.</div>
                    )}
                  </div>
                  <div className="mt-1.5 flex items-center justify-between gap-2 px-1">
                    <span className="text-[12.5px] text-ink-500">{c ? `Given ${fmtDateTime(c.issued_at, tz)}` : ''}</span>
                    <div className="flex gap-1">
                      <Button variant="ghost" className="h-8" onClick={() => setTarget({ id: p.id, name: p.full_name, has: Boolean(c) })} aria-label={`${c ? 'Replace' : 'Assign'} card for ${p.full_name}`}>
                        <CreditCard className="size-4" aria-hidden />
                        {c ? 'Replace' : 'Assign'}
                      </Button>
                      {c && (
                        <Button variant="ghost" className="h-8 text-rose-700" busy={remove.isPending && remove.variables?.id === c.id} onClick={() => remove.mutate({ id: c.id, name: p.full_name })} aria-label={`Switch off the card of ${p.full_name}`}>
                          Switch off
                        </Button>
                      )}
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      <Modal
        open={target !== null}
        onClose={() => setTarget(null)}
        title={target ? `${target.has ? 'Replace' : 'Assign'} card for ${target.name}` : ''}
        footer={
          <>
            <Button variant="ghost" onClick={() => setTarget(null)}>
              Cancel
            </Button>
            <Button type="submit" form="card-form" busy={assign.isPending}>
              Save card
            </Button>
          </>
        }
      >
        <form
          id="card-form"
          onSubmit={(e) => {
            e.preventDefault()
            setError(null)
            if (uid.replace(/[^0-9A-Za-z]/g, '').length < 4) return setError('A card number has at least 4 letters or digits.')
            assign.mutate()
          }}
          className="space-y-3"
        >
          <label className="block">
            <span className="mb-1 block text-[13px] font-medium text-ink-700">Card number</span>
            <input autoFocus value={uid} onChange={(e) => setUid(e.target.value)} className={inputCls} placeholder="04:A1:B2:C3" autoComplete="off" spellCheck={false} />
            <span className="mt-1 block text-[12.5px] text-ink-500">
              Tap the card on a USB card reader while this box is selected, or type the number. Spaces and colons are ignored and letters are saved in capitals, the way the locker station reads them.
            </span>
          </label>
          {target?.has && <p className="text-[13px] text-ink-600">The current card stops working as soon as this one is saved.</p>}
          {error && <Notice tone="bad">{error}</Notice>}
        </form>
      </Modal>
    </>
  )
}

export default function Lockers() {
  const { profile } = useAuth()
  const tz = profile?.tenants?.timezone ?? 'Asia/Manila'
  const isAdmin = profile?.role === 'admin'
  const [setupOpen, setSetupOpen] = useState(false)
  const [notice, setNotice] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null)
  const now = useNow(30_000)

  const lockers = useQuery({
    queryKey: ['locker-status'],
    queryFn: () => unwrap<LockerStatusRow[]>(supabase.from('locker_status').select('*').order('compartment_no')),
  })
  const mismatches = useQuery({
    queryKey: ['room-status', 'mismatches'],
    queryFn: () =>
      unwrap<RoomStatus[]>(supabase.from('room_status_now').select('*').order('room_code')),
    select: (rows) => rows.filter(needsAttention),
  })

  const stations = useStationStatus()
  const rows = lockers.data ?? []
  const station = rows[0]?.station_label
  const stationNow = (stations.data ?? []).find((x) => x.station_label === station)
  const strays = rows.filter((l) => l.compartment_no < 1 || l.compartment_no > DOORS.length)

  const issuedCount = rows.filter((l) => l.key_status === 'issued').length
  const lateCount = rows.filter((l) => l.key_status === 'outstanding').length
  const flagged = mismatches.data ?? []

  return (
    <>
      <header className="mb-6 max-w-[64ch]">
        <h1 className="font-display text-[34px] font-semibold leading-none tracking-[-0.02em]">Lockers and keys</h1>
        <p className="mt-2 text-ink-500">One four-door locker holds the key to each room. A key is released only to the instructor scheduled in that room.</p>
      </header>

      {notice && (
        <Notice tone={notice.tone} onDismiss={() => setNotice(null)}>
          {notice.text}
        </Notice>
      )}
      {strays.length > 0 && (
        <Notice tone="bad">
          {strays.length} locker{strays.length === 1 ? ' has' : 's have'} a door number outside 1 to 4 and cannot be shown. This
          usually means old nine-door demo data: run supabase/seed.sql again.
        </Notice>
      )}

      {/* the cabinet: the whole width of the page, because it is the thing this page is about */}
      <section aria-label="Key locker" className="relative rounded-2xl bg-ink-950 p-4 shadow-[0_20px_36px_-20px_rgb(11_21_36/0.8)] ring-1 ring-ink-800 sm:p-6">
        <Screw className="left-3 top-3" />
        <Screw className="right-3 top-3" />
        <Screw className="bottom-3 left-3" />
        <Screw className="bottom-3 right-3" />
        <div className="mb-5 flex flex-wrap items-start justify-between gap-x-6 gap-y-3 px-1">
          <div>
            <h2 className="font-display text-[22px] font-semibold leading-6 text-white">Key locker</h2>
            <p className="text-[13px] text-ink-300">{station ?? 'Four doors'}</p>
          </div>
          {rows.length > 0 && (
            <dl className="flex flex-wrap gap-x-7 gap-y-2" aria-label="The doors at a glance">
              {[
                { label: rows.length === 1 ? 'Door in use' : 'Doors in use', value: rows.length, bad: false },
                { label: 'Keys in the locker', value: rows.filter((l) => l.key_status === 'available').length, bad: false },
                { label: 'Keys out', value: issuedCount, bad: false },
                { label: 'Not returned', value: lateCount, bad: lateCount > 0 },
              ].map((f) => (
                <div key={f.label} className="flex flex-col-reverse">
                  <dt className="text-[12.5px] leading-4 text-ink-300">{f.label}</dt>
                  <dd className={cn('font-mono text-[24px] font-medium leading-7', f.bad ? 'text-rose-300' : 'text-brass-300')}>{String(f.value).padStart(2, '0')}</dd>
                </div>
              ))}
            </dl>
          )}
          <div className="flex flex-wrap items-center gap-2">
            {stationNow && (
              <span title={stationNow.last_seen_at ? `Last heard from ${fmtDateTime(stationNow.last_seen_at, tz)}` : 'The station has never reported'}>
                <Badge tone={stationNow.online ? 'good' : stationNow.last_seen_at ? 'bad' : 'warn'}>
                  {stationNow.online ? 'Station online' : stationNow.last_seen_at ? `Station silent since ${fmtRelative(stationNow.last_seen_at)}` : 'Station not connected yet'}
                </Badge>
              </span>
            )}
            {isAdmin && (
              <Button variant="secondary" onClick={() => setSetupOpen(true)}>
                <Settings2 className="size-4" aria-hidden />
                Set up doors
              </Button>
            )}
          </div>
        </div>
        {lockers.isLoading ? (
          <div className="rounded-md bg-ink-900 text-ink-200">
            <Loading rows={3} />
          </div>
        ) : lockers.error ? (
          <ErrorNote error={lockers.error} onRetry={() => void lockers.refetch()} />
        ) : rows.length === 0 ? (
          <div className="rounded-md border border-dashed border-ink-600 [&_.font-display]:text-white [&_div]:text-ink-300">
            <EmptyState title="No lockers configured">
              {isAdmin ? 'Use Set up doors to put each room’s key in a door.' : 'Assign each of the four doors to a room to track its key.'}
            </EmptyState>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            {DOORS.map((n) => (
              <Door key={n} n={n} locker={rows.find((l) => l.compartment_no === n)} tz={tz} now={now.getTime()} />
            ))}
          </div>
        )}
      </section>

      {isAdmin && <KeyCards tz={tz} onNotice={setNotice} />}
      {isAdmin && (
        <DoorSetup
          open={setupOpen}
          onClose={() => setSetupOpen(false)}
          onSaved={(text) => setNotice({ tone: 'good', text })}
        />
      )}

      <section className="mt-12" aria-labelledby="look-title">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-x-8 gap-y-3">
          <div className="max-w-[64ch]">
            <h2 id="look-title" className="font-display text-[24px] font-semibold leading-7">
              Rooms to look at
            </h2>
            <p className="text-[13.5px] text-ink-500">
              The teacher is not here, the key is with someone else, people are in a room without the key, or a room is occupied with no class.
            </p>
          </div>
          <div className="flex max-w-[62ch] items-center gap-3 rounded-md bg-white px-3.5 py-2.5 ring-1 ring-ink-200">
            <p className="text-[13px] leading-[1.45] text-ink-600">The key says who has the room; the camera says whether anyone is in it. Together they show whether the teacher is present.</p>
            <Link
              to="/cameras"
              className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-ink-900 px-3 py-1.5 text-[13.5px] font-medium text-white hover:bg-ink-700"
            >
              <Video className="size-4" aria-hidden />
              Open the cameras
              <ArrowRight className="size-4" aria-hidden />
            </Link>
          </div>
        </div>

        {mismatches.isLoading ? (
          <Loading />
        ) : mismatches.error ? (
          <ErrorNote error={mismatches.error} />
        ) : flagged.length === 0 ? (
          <div className="rounded-md border-2 border-dashed border-emerald-300/70 bg-emerald-50/40">
            <EmptyState title="Every room matches its schedule">Rooms that need a look appear here as soon as the key or the camera shows a problem.</EmptyState>
          </div>
        ) : (
          <ul className="space-y-3">
            {flagged.map((r) => {
              const info = presenceInfo(r.presence)
              const tone = info?.tone ?? 'bad'
              const classNow = (r.schedule_entry_id || r.room_request_id) && r.start_time && r.end_time
              return (
                <li key={r.room_id} className="relative flex flex-wrap items-stretch overflow-hidden rounded-md bg-white ring-1 ring-ink-200">
                  <span
                    aria-hidden
                    className={cn(
                      'w-2.5 shrink-0',
                      tone === 'bad' ? '[background:repeating-linear-gradient(135deg,var(--color-rose-500)_0_6px,var(--color-ink-900)_6px_12px)]' : '[background:repeating-linear-gradient(135deg,var(--color-amber-400)_0_6px,var(--color-ink-900)_6px_12px)]',
                    )}
                  />
                  <div className="grid min-w-0 flex-1 gap-x-6 gap-y-2 px-4 py-3.5 md:grid-cols-[150px_minmax(0,1fr)_minmax(0,1.25fr)]">
                    <div className="flex items-start">
                      <KeyTag code={r.room_code} size="lg" tone={tone === 'bad' ? 'alert' : 'brass'} />
                    </div>
                    <div className="min-w-0">
                      <div className="text-[12.5px] text-ink-500">Scheduled</div>
                      {classNow ? (
                        <>
                          <div className="font-medium">{r.course_code}</div>
                          <div className="text-[13px] text-ink-500">
                            {r.instructor_name}, {fmtRange(r.start_time!, r.end_time!)}
                          </div>
                        </>
                      ) : (
                        <span className="text-ink-400">No class</span>
                      )}
                      <div className="mt-2 text-[12.5px] text-ink-500">Camera</div>
                      <div className="flex flex-wrap items-center gap-x-2">
                        <OccupancyBadge occupied={r.is_occupied} />
                        {r.is_occupied !== null && <span className="text-[13px] text-ink-500">{peopleText(r.person_count, r.is_occupied)}</span>}
                      </div>
                    </div>
                    <div className="min-w-0">
                      <div className="text-[12.5px] text-ink-500">Issue</div>
                      {info ? (
                        <div title={info.why}>
                          <Badge tone={info.tone}>{info.label}</Badge>
                          <div className="mt-1 max-w-[46ch] text-[13px] text-ink-600">{info.why}</div>
                        </div>
                      ) : (
                        r.discrepancy && <Badge tone="bad">{DISCREPANCY_LABEL[r.discrepancy]}</Badge>
                      )}
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </>
  )
}
