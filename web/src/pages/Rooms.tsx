import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Building2, DoorClosed, FileUp, LayoutGrid, Pencil, Plus, Rows3, Trash2, X } from 'lucide-react'
import { useAuth } from '@/auth/AuthProvider'
import { ImportRoomsDialog } from '@/components/ImportRoomsDialog'
import { KeyTag } from '@/components/KeyTag'
import { Modal } from '@/components/Modal'
import { RoomPlan } from '@/components/RoomPlan'
import { ResultNote, SearchInput, Segmented, SortTh, useSort } from '@/components/controls'
import { Rivet } from '@/components/surfaces'
import { Badge, Button, Card, EmptyState, ErrorNote, filterSelectCls, inputCls, Loading, Notice, Table, TBody, td, th, THead } from '@/components/ui'
import { cn } from '@/lib/cn'
import { useStoredState } from '@/hooks/useStoredState'
import { unwrap } from '@/lib/api'
import { friendlyError } from '@/lib/errors'
import { facilityTitle, normFacilities, normFacility, ROOM_TYPE_PRESETS } from '@/lib/facilities'
import { facilityLabel } from '@/lib/format'
import { supabase } from '@/lib/supabase'
import { matchesQuery, sortRows } from '@/lib/tableView'
import type { Building, Room } from '@/lib/types'

interface Form {
  id?: string
  code: string
  name: string
  building_id: string
  floor: string
  capacity: string
  facilities: string[]
  is_active: boolean
}

interface BuildingForm {
  code: string
  name: string
  campus_id: string
}

const NO_BUILDINGS: Building[] = []

function blankForm(building_id: string): Form {
  return { code: '', name: '', building_id, floor: '1', capacity: '40', facilities: [], is_active: true }
}

/** One door's plate: the code in brass on dark enamel, how many it seats as a gauge, and what the room has. */
function RoomPlate({ r, maxSeats, canEdit, onEdit }: { r: Room; maxSeats: number; canEdit: boolean; onEdit: () => void }) {
  const on = r.is_active
  return (
    <li
      className={cn(
        'relative flex flex-col overflow-hidden rounded-md px-4 pb-3 pt-5 ring-1',
        on ? 'bg-ink-900 text-white shadow-[0_12px_20px_-14px_rgb(11_21_36/0.8)] ring-ink-700' : 'bg-ink-800/80 text-ink-200 ring-ink-700 [background-image:repeating-linear-gradient(135deg,rgb(255_255_255/0.035)_0_6px,transparent_6px_12px)]',
      )}
    >
      <Rivet className="left-2 top-2" />
      <Rivet className="right-2 top-2" />
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className={cn('whitespace-nowrap font-display text-[30px] font-semibold leading-8 tracking-[-0.01em]', on ? 'text-brass-300' : 'text-ink-400')}>{r.code}</div>
          <div className="mt-0.5 truncate text-[14px] text-ink-100">{r.name}</div>
        </div>
      </div>

      <div className="mt-4">
        <div className="flex items-baseline justify-between text-[13px]">
          <span className="text-ink-300">Seats</span>
          <span className="font-medium text-white">{r.capacity}</span>
        </div>
        <div className="mt-1 h-1.5 rounded-full bg-ink-950/70 ring-1 ring-inset ring-ink-700" aria-hidden>
          <div className={cn('h-full rounded-full', on ? 'bg-brass-400' : 'bg-ink-500')} style={{ width: `${Math.max(6, Math.round((r.capacity / maxSeats) * 100))}%` }} />
        </div>
      </div>

      <div className="mt-3 flex min-h-[26px] flex-wrap gap-1.5">
        {r.facilities.length === 0 ? (
          <span className="text-[12.5px] text-ink-400">Standard classroom</span>
        ) : (
          r.facilities.map((f) => (
            <span key={f} className="rounded-full bg-ink-800 px-2 py-0.5 text-[12px] font-medium text-ink-100 ring-1 ring-inset ring-ink-600">
              {facilityLabel(f)}
            </span>
          ))
        )}
      </div>

      <div className="mt-3 flex items-center justify-between border-t border-ink-700 pt-2.5">
        <span className="inline-flex items-center gap-2 text-[13px] font-medium">
          <span
            aria-hidden
            className={cn('size-2 rounded-full', on ? 'bg-emerald-400 shadow-[0_0_7px_2px_rgb(52_211_153/0.5)]' : 'bg-ink-600 ring-1 ring-ink-500')}
          />
          {on ? 'In service' : 'Out of service'}
        </span>
        {canEdit && (
          <Button variant="ghost" className="-mr-2 h-8 text-ink-200! hover:bg-ink-800! hover:text-white!" onClick={onEdit} aria-label={`Edit room ${r.code}`}>
            <Pencil className="size-4" aria-hidden />
            Edit
          </Button>
        )}
      </div>
    </li>
  )
}

/** The rooms hung up like the signs of a building: one group for each floor, its number large in the margin. */
function RoomPlates({ rooms, canEdit, onEdit }: { rooms: Room[]; canEdit: boolean; onEdit: (r: Room) => void }) {
  const maxSeats = Math.max(1, ...rooms.map((r) => r.capacity))
  const groups = useMemo(() => {
    const map = new Map<string, { building: string; floor: number; rooms: Room[] }>()
    for (const r of rooms) {
      const key = `${r.buildings?.name ?? ''}|${r.floor}`
      const g = map.get(key) ?? { building: r.buildings?.name ?? '', floor: r.floor, rooms: [] }
      g.rooms.push(r)
      map.set(key, g)
    }
    return [...map.values()].sort((a, b) => a.building.localeCompare(b.building) || a.floor - b.floor)
  }, [rooms])
  return (
    <div className="space-y-9">
      {groups.map((g) => (
        <section key={`${g.building}|${g.floor}`} className="grid gap-x-8 gap-y-4 lg:grid-cols-[148px_minmax(0,1fr)]">
          <div className="lg:sticky lg:top-6 lg:self-start">
            <div aria-hidden className="font-display text-[76px] font-semibold leading-[0.9] tracking-[-0.03em] text-ink-200">
              {g.floor}
            </div>
            <h2 className="mt-1.5 font-display text-[18px] font-semibold leading-5">Floor {g.floor}</h2>
            <p className="mt-0.5 text-[13px] leading-[1.35] text-ink-500">{g.building}</p>
            <p className="mt-1 text-[13px] text-ink-500">
              {g.rooms.length} {g.rooms.length === 1 ? 'room' : 'rooms'}, {g.rooms.reduce((n, r) => n + r.capacity, 0)} seats
            </p>
          </div>
          <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {g.rooms.map((r) => (
              <RoomPlate key={r.id} r={r} maxSeats={maxSeats} canEdit={canEdit} onEdit={() => onEdit(r)} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

export default function Rooms() {
  const { profile } = useAuth()
  const qc = useQueryClient()
  const canEdit = profile?.role === 'admin'
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<'all' | 'active' | 'inactive'>('all')
  const [buildingFilter, setBuildingFilter] = useState('')
  const sort = useSort<'code' | 'building' | 'floor' | 'seats' | 'status'>('code')
  // the plan of the buildings or the list; the choice is remembered
  const [layout, setLayout] = useStoredState('c360.rooms.layout', 'plates', ['plates', 'list', 'plan'] as const)
  const [form, setForm] = useState<Form | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [custom, setCustom] = useState('')
  const [notice, setNotice] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [bform, setBform] = useState<BuildingForm | null>(null)
  const [bError, setBError] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)

  useEffect(() => {
    setFormError(null)
    setConfirmDelete(false)
  }, [form])
  useEffect(() => setBError(null), [bform])

  const rooms = useQuery({
    queryKey: ['rooms'],
    queryFn: () =>
      unwrap<Room[]>(
        supabase.from('rooms').select('id, code, name, floor, capacity, facilities, is_active, building_id, buildings(name)').order('code'),
      ),
  })
  const buildings = useQuery({
    queryKey: ['buildings'],
    enabled: canEdit,
    queryFn: () => unwrap<Building[]>(supabase.from('buildings').select('id, code, name').order('code')),
  })

  const campuses = useQuery({
    queryKey: ['campuses'],
    enabled: canEdit,
    queryFn: () => unwrap<{ id: string; name: string }[]>(supabase.from('campuses').select('id, name').order('name')),
  })

  const buildingList = buildings.data ?? NO_BUILDINGS
  const existingCodes = useMemo(() => (rooms.data ?? []).map((r) => r.code), [rooms.data])

  const allRooms = rooms.data ?? []
  const filtering = Boolean(search.trim()) || status !== 'all' || buildingFilter !== ''
  const buildingsInUse = useMemo(() => {
    const seen = new Map<string, string>()
    for (const r of allRooms) if (r.buildings?.name) seen.set(r.building_id, r.buildings.name)
    return [...seen].sort((a, b) => a[1].localeCompare(b[1]))
  }, [allRooms])
  const rows = useMemo(() => {
    const kept = allRooms.filter(
      (r) =>
        (status === 'all' || r.is_active === (status === 'active')) &&
        (!buildingFilter || r.building_id === buildingFilter) &&
        matchesQuery(`${r.code} ${r.name} ${r.buildings?.name ?? ''} ${r.facilities.map(facilityLabel).join(' ')}`, search),
    )
    if (!sort.key) return kept
    const get = {
      code: (r: Room) => r.code,
      building: (r: Room) => r.buildings?.name,
      floor: (r: Room) => r.floor,
      seats: (r: Room) => r.capacity,
      status: (r: Room) => (r.is_active ? 0 : 1),
    }[sort.key]
    return sortRows(kept, get, sort.dir)
  }, [allRooms, status, buildingFilter, search, sort.key, sort.dir])
  const clearFilters = () => {
    setSearch('')
    setStatus('all')
    setBuildingFilter('')
  }

  // every type any room has, plus the usual ones, so a new room can pick without typing
  const known = normFacilities([...ROOM_TYPE_PRESETS, ...(rooms.data ?? []).flatMap((r) => r.facilities)])

  const save = useMutation({
    mutationFn: async (f: Form) => {
      const row = {
        code: f.code.trim(),
        name: f.name.trim(),
        building_id: f.building_id,
        floor: Number(f.floor),
        capacity: Number(f.capacity),
        facilities: normFacilities(f.facilities),
        is_active: f.is_active,
      }
      if (f.id) await unwrap(supabase.from('rooms').update(row).eq('id', f.id))
      else await unwrap(supabase.from('rooms').insert({ ...row, tenant_id: profile!.tenant_id }))
      return f.id ? `Saved room ${row.code}.` : `Added room ${row.code}.`
    },
    onSuccess: (text) => {
      setForm(null)
      setNotice({ tone: 'good', text })
      void qc.invalidateQueries({ queryKey: ['rooms'] })
      void qc.invalidateQueries({ queryKey: ['rooms-options'] })
      void qc.invalidateQueries({ queryKey: ['audit'] })
    },
    onError: (err) => setFormError(friendlyError(err, 'The room was not saved.')),
  })

  const saveBuilding = useMutation({
    mutationFn: async (f: BuildingForm) => {
      await unwrap(supabase.from('buildings').insert({ code: f.code.trim(), name: f.name.trim(), campus_id: f.campus_id, tenant_id: profile!.tenant_id }))
      return `Added building ${f.name.trim()}.`
    },
    onSuccess: (text) => {
      setBform(null)
      setNotice({ tone: 'good', text })
      void qc.invalidateQueries({ queryKey: ['buildings'] })
      void qc.invalidateQueries({ queryKey: ['audit'] })
    },
    onError: (err) => setBError(friendlyError(err, 'The building was not saved.')),
  })

  function submitBuilding(e: FormEvent) {
    e.preventDefault()
    if (!bform) return
    if (!bform.code.trim() || !bform.name.trim()) return setBError('Give the building a code and a name.')
    if (!bform.campus_id) return setBError('Choose a campus.')
    saveBuilding.mutate(bform)
  }

  const remove = useMutation({
    mutationFn: async (id: string) => {
      await unwrap(supabase.rpc('delete_room', { p_room_id: id }))
    },
    onSuccess: () => {
      const code = form?.code
      setForm(null)
      setNotice({ tone: 'good', text: `Deleted room ${code ?? ''}.`.replace(' .', '.') })
      void qc.invalidateQueries({ queryKey: ['rooms'] })
      void qc.invalidateQueries({ queryKey: ['rooms-options'] })
      void qc.invalidateQueries({ queryKey: ['audit'] })
    },
    onError: (err) => {
      setConfirmDelete(false)
      setFormError(friendlyError(err, 'The room was not deleted.'))
    },
  })

  function submit(e: FormEvent) {
    e.preventDefault()
    if (!form) return
    setFormError(null)
    if (!form.code.trim() || !form.name.trim()) return setFormError('Give the room a code and a name.')
    if (!form.building_id) return setFormError('Choose a building.')
    const seats = Number(form.capacity)
    if (!Number.isInteger(seats) || seats < 1 || seats > 2000) return setFormError('Seats must be a whole number from 1 to 2000.')
    const floor = Number(form.floor)
    if (!Number.isInteger(floor) || floor < -5 || floor > 100) return setFormError('The floor must be a whole number.')
    save.mutate(form)
  }

  const addCustom = () => {
    const t = normFacility(custom)
    if (!t || !form) return
    setForm({ ...form, facilities: normFacilities([...form.facilities, t]) })
    setCustom('')
  }
  const toggleType = (t: string, on: boolean) => {
    if (!form) return
    setForm({ ...form, facilities: on ? normFacilities([...form.facilities, t]) : form.facilities.filter((x) => x !== t) })
  }

  const open = (r?: Room) => {
    setFormError(null)
    setCustom('')
    setNotice(null)
    setForm(
      r
        ? { id: r.id, code: r.code, name: r.name, building_id: r.building_id, floor: String(r.floor), capacity: String(r.capacity), facilities: r.facilities, is_active: r.is_active }
        : blankForm(buildings.data?.[0]?.id ?? ''),
    )
  }

  return (
    <>
      <header className="mb-7 flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
        <div className="min-w-0 max-w-[62ch]">
          <h1 className="font-display text-[34px] font-semibold leading-none tracking-[-0.02em]">Rooms</h1>
          <p className="mt-2 text-ink-500">
            The room inventory the scheduling engine assigns classes to. Seats and room types are hard rules: a class goes only in a room that seats it and has the type its course needs.
          </p>
          {allRooms.length > 0 && (
            <dl className="mt-4 flex flex-wrap gap-x-7 gap-y-2">
              {[
                { label: allRooms.length === 1 ? 'Room' : 'Rooms', value: allRooms.length },
                { label: 'Seats in all', value: allRooms.reduce((n, r) => n + r.capacity, 0) },
                { label: 'In service', value: allRooms.filter((r) => r.is_active).length },
                { label: buildingsInUse.length === 1 ? 'Building' : 'Buildings', value: buildingsInUse.length },
              ].map((f) => (
                <div key={f.label} className="flex flex-col-reverse">
                  <dt className="text-[12.5px] leading-4 text-ink-500">{f.label}</dt>
                  <dd className="font-display text-[26px] font-semibold leading-8">{f.value}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canEdit && (
            <>
              <Button
                variant="secondary"
                onClick={() => {
                  setNotice(null)
                  setBform({ code: '', name: '', campus_id: campuses.data?.[0]?.id ?? '' })
                }}
                disabled={campuses.isLoading || (campuses.data ?? []).length === 0}
              >
                <Building2 className="size-4" aria-hidden />
                Add building
              </Button>
              <Button
                variant="secondary"
                onClick={() => {
                  setNotice(null)
                  setImporting(true)
                }}
                disabled={buildings.isLoading || rooms.isLoading || buildingList.length === 0}
              >
                <FileUp className="size-4" aria-hidden />
                Import CSV
              </Button>
              <Button onClick={() => open()} disabled={buildings.isLoading || (buildings.data ?? []).length === 0}>
                <Plus className="size-4" aria-hidden />
                Add room
              </Button>
            </>
          )}
        </div>
      </header>
      {notice && (
        <Notice tone={notice.tone} onDismiss={() => setNotice(null)}>
          {notice.text}
        </Notice>
      )}
      {canEdit && !buildings.isLoading && (buildings.data ?? []).length === 0 && (
        <Notice tone="bad">There is no building yet, so a room cannot be added. Use Add building first.</Notice>
      )}
      {allRooms.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <SearchInput value={search} onChange={setSearch} label="Search rooms" placeholder="Search code, name or building" className="w-full sm:w-80" shortcut />
          <Segmented
            label="Show rooms"
            value={status}
            onChange={setStatus}
            options={[
              { value: 'all', label: 'All', count: allRooms.length },
              { value: 'active', label: 'In service', count: allRooms.filter((r) => r.is_active).length },
              { value: 'inactive', label: 'Out of service', count: allRooms.filter((r) => !r.is_active).length },
            ]}
          />
          {buildingsInUse.length > 1 && (
            <select value={buildingFilter} onChange={(e) => setBuildingFilter(e.target.value)} aria-label="Building" className={filterSelectCls}>
              <option value="">All buildings</option>
              {buildingsInUse.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
          )}
          {filtering && <ResultNote shown={rows.length} total={allRooms.length} noun={['room', 'rooms']} />}
          <Segmented
            label="Rooms layout"
            value={layout}
            onChange={setLayout}
            className="ml-auto"
            options={[
              {
                value: 'plates',
                label: (
                  <>
                    <DoorClosed className="size-4" aria-hidden />
                    Plates
                  </>
                ),
              },
              {
                value: 'list',
                label: (
                  <>
                    <Rows3 className="size-4" aria-hidden />
                    List
                  </>
                ),
              },
              {
                value: 'plan',
                label: (
                  <>
                    <LayoutGrid className="size-4" aria-hidden />
                    Plan
                  </>
                ),
              },
            ]}
          />
        </div>
      )}
      {layout === 'plates' && !rooms.isLoading && !rooms.error && rows.length > 0 ? (
        <RoomPlates rooms={rows} canEdit={canEdit} onEdit={open} />
      ) : (
      <Card flush>
        {rooms.isLoading ? (
          <Loading rows={5} />
        ) : rooms.error ? (
          <div className="p-4">
            <ErrorNote error={rooms.error} onRetry={() => void rooms.refetch()} />
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            title={filtering ? 'No rooms match' : 'No rooms yet'}
            action={filtering ? <Button variant="secondary" onClick={clearFilters}>Clear search and filters</Button> : undefined}
          >
            {filtering ? 'Try a different room code, name or building.' : canEdit ? 'Use Add room to create the first one, or Import CSV to add many at once.' : 'Rooms added to the institution will be listed here.'}
          </EmptyState>
        ) : layout === 'plan' ? (
          <RoomPlan rooms={rows} onPick={canEdit ? (r) => open(r) : undefined} />
        ) : (
          <Table>
            <THead>
              <tr>
                <SortTh label="Room" k="code" sort={sort} />
                <SortTh label="Building" k="building" sort={sort} />
                <SortTh label="Floor" k="floor" sort={sort} />
                <SortTh label="Seats" k="seats" sort={sort} />
                <th className={th}>Room types</th>
                <SortTh label="Status" k="status" sort={sort} />
                {canEdit && (
                  <th className={th}>
                    <span className="sr-only">Actions</span>
                  </th>
                )}
              </tr>
            </THead>
            <TBody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className={td}>
                    <div className="flex items-center gap-3">
                      <KeyTag code={r.code} />
                      <span className="text-ink-600">{r.name}</span>
                    </div>
                  </td>
                  <td className={td}>{r.buildings?.name}</td>
                  <td className={td}>{r.floor}</td>
                  <td className={td}>{r.capacity}</td>
                  <td className={td}>
                    {r.facilities.length === 0 ? (
                      <span className="text-ink-400">Standard</span>
                    ) : (
                      <div className="flex flex-wrap gap-1.5">
                        {r.facilities.map((f) => (
                          <Badge key={f}>{facilityLabel(f)}</Badge>
                        ))}
                      </div>
                    )}
                  </td>
                  <td className={td}>{r.is_active ? <Badge tone="good">In service</Badge> : <Badge>Out of service</Badge>}</td>
                  {canEdit && (
                    <td className={`${td} text-right`}>
                      <Button variant="ghost" onClick={() => open(r)} aria-label={`Edit room ${r.code}`}>
                        <Pencil className="size-4" aria-hidden />
                        Edit
                      </Button>
                    </td>
                  )}
                </tr>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
      )}
      {!canEdit && <p className="mt-6 max-w-[64ch] text-[13px] text-ink-500">Rooms are managed by an administrator.</p>}

      <Modal
        open={form !== null}
        onClose={() => setForm(null)}
        title={form?.id ? `Edit room ${form.code}` : 'Add room'}
        footer={
          <>
            {form?.id && (
              <Button variant="ghost" className="mr-auto text-rose-700" onClick={() => setConfirmDelete(true)} disabled={remove.isPending}>
                <Trash2 className="size-4" aria-hidden />
                Delete room
              </Button>
            )}
            <Button variant="ghost" onClick={() => setForm(null)}>
              Cancel
            </Button>
            <Button type="submit" form="room-form" busy={save.isPending}>
              Save
            </Button>
          </>
        }
      >
        {form && (
          <form id="room-form" onSubmit={submit} className="space-y-3">
            {confirmDelete && form.id && (
              <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2.5 text-[14px] text-rose-950" role="alertdialog" aria-label="Confirm delete">
                <div className="font-medium">Delete room {form.code} for good?</div>
                <p className="mt-0.5 text-[13px]">
                  This cannot be undone. A room that has class meetings, room requests or a locker door cannot be deleted: take it out of
                  service instead.
                </p>
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
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="mb-1 block text-[13px] font-medium text-ink-700">Room code</span>
                <input required value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} className={inputCls} placeholder="LRC-305" />
              </label>
              <label className="block">
                <span className="mb-1 block text-[13px] font-medium text-ink-700">Name</span>
                <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={inputCls} placeholder="Chemistry Laboratory 1" />
              </label>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="block">
                <span className="mb-1 block text-[13px] font-medium text-ink-700">Building</span>
                <select value={form.building_id} onChange={(e) => setForm({ ...form, building_id: e.target.value })} className={inputCls}>
                  {(buildings.data ?? []).map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-[13px] font-medium text-ink-700">Floor</span>
                <input type="number" value={form.floor} onChange={(e) => setForm({ ...form, floor: e.target.value })} className={inputCls} />
              </label>
              <label className="block">
                <span className="mb-1 block text-[13px] font-medium text-ink-700">Seats</span>
                <input type="number" min={1} value={form.capacity} onChange={(e) => setForm({ ...form, capacity: e.target.value })} className={inputCls} />
              </label>
            </div>

            <fieldset>
              <legend className="mb-1 text-[13px] font-medium text-ink-700">Room types</legend>
              <p className="mb-2 text-[13px] text-ink-500">What this room has. A course that needs a type is placed only in a room that has it. Leave all unticked for an ordinary classroom.</p>
              <div className="grid gap-x-4 gap-y-1.5 sm:grid-cols-2">
                {known.map((t) => (
                  <label key={t} className="flex items-center gap-2 text-[14px]">
                    <input type="checkbox" checked={form.facilities.includes(t)} onChange={(e) => toggleType(t, e.target.checked)} className="size-4 accent-ink-900" />
                    {facilityTitle(t)}
                  </label>
                ))}
              </div>
              {form.facilities.filter((t) => !known.includes(t)).length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {form.facilities
                    .filter((t) => !known.includes(t))
                    .map((t) => (
                      <span key={t} className="inline-flex items-center gap-1 rounded-full bg-ink-100 py-0.5 pl-2.5 pr-1 text-[13px]">
                        {facilityTitle(t)}
                        <button type="button" onClick={() => toggleType(t, false)} aria-label={`Remove ${facilityTitle(t)}`} className="grid size-5 place-items-center rounded-full hover:bg-ink-200">
                          <X className="size-3" aria-hidden />
                        </button>
                      </span>
                    ))}
                </div>
              )}
              <div className="mt-2 flex gap-2">
                <input
                  value={custom}
                  onChange={(e) => setCustom(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      addCustom()
                    }
                  }}
                  className={inputCls}
                  placeholder="Another type, for example Pharmacy Laboratory"
                  aria-label="Another room type"
                />
                <Button type="button" variant="secondary" className="shrink-0 whitespace-nowrap" onClick={addCustom} disabled={!normFacility(custom)}>
                  Add type
                </Button>
              </div>
            </fieldset>

            <label className="flex items-start gap-2 text-[14px]">
              <input type="checkbox" checked={form.is_active} onChange={(e) => setForm({ ...form, is_active: e.target.checked })} className="mt-0.5 size-4 accent-ink-900" />
              <span>
                In service
                <span className="block text-[13px] text-ink-500">Untick to take the room out of use. New timetables will not use it; classes already placed in it stay where they are.</span>
              </span>
            </label>

            {formError && <Notice tone="bad">{formError}</Notice>}
          </form>
        )}
      </Modal>

      {canEdit && (
        <ImportRoomsDialog
          open={importing}
          onClose={() => setImporting(false)}
          buildings={buildingList}
          existingCodes={existingCodes}
          onImported={(text) => {
            setNotice({ tone: 'good', text })
            void qc.invalidateQueries({ queryKey: ['rooms'] })
            void qc.invalidateQueries({ queryKey: ['rooms-options'] })
            void qc.invalidateQueries({ queryKey: ['room-types'] })
            void qc.invalidateQueries({ queryKey: ['audit'] })
          }}
        />
      )}

      <Modal
        open={bform !== null}
        onClose={() => setBform(null)}
        title="Add building"
        footer={
          <>
            <Button variant="ghost" onClick={() => setBform(null)}>
              Cancel
            </Button>
            <Button type="submit" form="building-form" busy={saveBuilding.isPending}>
              Save
            </Button>
          </>
        }
      >
        {bform && (
          <form id="building-form" onSubmit={submitBuilding} className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-[8rem_1fr]">
              <label className="block">
                <span className="mb-1 block text-[13px] font-medium text-ink-700">Code</span>
                <input required value={bform.code} onChange={(e) => setBform({ ...bform, code: e.target.value })} className={inputCls} placeholder="SCI" />
              </label>
              <label className="block">
                <span className="mb-1 block text-[13px] font-medium text-ink-700">Name</span>
                <input required value={bform.name} onChange={(e) => setBform({ ...bform, name: e.target.value })} className={inputCls} placeholder="Science Building" />
              </label>
            </div>
            {(campuses.data ?? []).length > 1 && (
              <label className="block">
                <span className="mb-1 block text-[13px] font-medium text-ink-700">Campus</span>
                <select value={bform.campus_id} onChange={(e) => setBform({ ...bform, campus_id: e.target.value })} className={inputCls}>
                  {(campuses.data ?? []).map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {bError && <Notice tone="bad">{bError}</Notice>}
          </form>
        )}
      </Modal>
    </>
  )
}
