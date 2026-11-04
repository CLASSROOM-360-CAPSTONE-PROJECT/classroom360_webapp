import { useMemo, useState, type FormEvent } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { useAuth } from '@/auth/AuthProvider'
import { Modal } from '@/components/Modal'
import { ResultNote, SearchInput, Segmented } from '@/components/controls'
import { Rivet } from '@/components/surfaces'
import { Badge, Button, EmptyState, ErrorNote, inputCls, Loading, Notice } from '@/components/ui'
import { unwrap, useDepartments, usePrograms } from '@/lib/api'
import { friendlyError } from '@/lib/errors'
import { supabase } from '@/lib/supabase'
import { matchesQuery } from '@/lib/tableView'
import type { Department } from '@/lib/types'

type DeptForm = { id?: string; code: string; name: string }

export default function Departments() {
  const { profile } = useAuth()
  const qc = useQueryClient()
  const departments = useDepartments()
  const programs = usePrograms()

  const [notice, setNotice] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null)
  const [dept, setDept] = useState<DeptForm | null>(null)
  const [addingTo, setAddingTo] = useState<Department | null>(null)
  const [progCode, setProgCode] = useState('')
  const [progName, setProgName] = useState('')
  const [archiving, setArchiving] = useState<Department | null>(null)

  const done = (text: string) => {
    setNotice({ tone: 'good', text })
    void qc.invalidateQueries({ queryKey: ['departments'] })
    void qc.invalidateQueries({ queryKey: ['programs'] })
    void qc.invalidateQueries({ queryKey: ['audit'] })
  }
  const failed = (err: unknown) => setNotice({ tone: 'bad', text: friendlyError(err) })

  const saveDept = useMutation({
    mutationFn: async (f: DeptForm) => {
      const code = f.code.trim().toUpperCase()
      const name = f.name.trim()
      if (f.id) {
        const rows = await unwrap<{ id: string }[]>(
          supabase.from('departments').update({ code, name }).eq('id', f.id).select('id'),
        )
        if (rows.length === 0) throw new Error('You cannot change this department.')
        return `Saved ${code}.`
      }
      await unwrap(supabase.from('departments').insert({ tenant_id: profile!.tenant_id, code, name }))
      return `Added ${code}. Its program chairs can now be assigned to it under Users.`
    },
    onSuccess: (text) => {
      setDept(null)
      done(text)
    },
    onError: failed,
  })

  const toggle = useMutation({
    mutationFn: async (d: Department) => {
      const rows = await unwrap<{ id: string }[]>(
        supabase.from('departments').update({ is_active: !d.is_active }).eq('id', d.id).select('id'),
      )
      if (rows.length === 0) throw new Error('You cannot change this department.')
      return d.is_active ? `Archived ${d.code}.` : `Restored ${d.code}.`
    },
    onSuccess: (text) => {
      setArchiving(null)
      done(text)
    },
    onError: failed,
  })

  const addProgram = useMutation({
    mutationFn: async () => {
      const code = progCode.trim().toUpperCase()
      await unwrap(
        supabase.from('programs').insert({
          tenant_id: profile!.tenant_id,
          department_id: addingTo!.id,
          code,
          name: progName.trim(),
        }),
      )
      return `Added ${code} to ${addingTo!.code}.`
    },
    onSuccess: (text) => {
      setAddingTo(null)
      setProgCode('')
      setProgName('')
      done(text)
    },
    onError: failed,
  })

  const all = departments.data ?? []
  const byDept = (id: string) => (programs.data ?? []).filter((p) => p.department_id === id)
  const [search, setSearch] = useState('')
  const [show, setShow] = useState<'all' | 'active' | 'archived'>('all')
  const filtering = Boolean(search.trim()) || show !== 'all'
  const archivedCount = all.filter((d) => !d.is_active).length
  const list = useMemo(
    () =>
      all.filter(
        (d) =>
          (show === 'all' || d.is_active === (show === 'active')) &&
          matchesQuery(`${d.code} ${d.name} ${(programs.data ?? []).filter((p) => p.department_id === d.id).map((p) => `${p.code} ${p.name}`).join(' ')}`, search),
      ),
    [all, show, search, programs.data],
  )

  function submitDept(e: FormEvent) {
    e.preventDefault()
    if (dept) saveDept.mutate(dept)
  }
  function submitProgram(e: FormEvent) {
    e.preventDefault()
    addProgram.mutate()
  }

  return (
    <>
      <header className="mb-7 flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
        <div className="min-w-0 max-w-[62ch]">
          <h1 className="font-display text-[34px] font-semibold leading-none tracking-[-0.02em]">Departments</h1>
          <p className="mt-2 text-ink-500">
            Every department schedules into the same rooms. A room booked by one department is unavailable to the others, so two departments can never hold it at the same time.
          </p>
          {all.length > 0 && (
            <dl className="mt-4 flex flex-wrap gap-x-7 gap-y-2">
              {[
                { label: all.length - archivedCount === 1 ? 'Department' : 'Departments', value: all.length - archivedCount },
                { label: (programs.data ?? []).length === 1 ? 'Program' : 'Programs', value: (programs.data ?? []).length },
                ...(archivedCount > 0 ? [{ label: 'Archived', value: archivedCount }] : []),
              ].map((f) => (
                <div key={f.label} className="flex flex-col-reverse">
                  <dt className="text-[12.5px] leading-4 text-ink-500">{f.label}</dt>
                  <dd className="font-display text-[26px] font-semibold leading-8">{f.value}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
        <Button
          onClick={() => {
            setNotice(null)
            setDept({ code: '', name: '' })
          }}
        >
          <Plus className="size-4" aria-hidden />
          Add department
        </Button>
      </header>

      {notice && (
        <Notice tone={notice.tone} onDismiss={() => setNotice(null)}>
          {notice.text}
        </Notice>
      )}

      {all.length > 1 && (
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <SearchInput value={search} onChange={setSearch} label="Search departments" placeholder="Search code, name or program" className="w-full sm:w-80" shortcut />
          {archivedCount > 0 && (
            <Segmented
              label="Show departments"
              value={show}
              onChange={setShow}
              options={[
                { value: 'all', label: 'All', count: all.length },
                { value: 'active', label: 'Active', count: all.length - archivedCount },
                { value: 'archived', label: 'Archived', count: archivedCount },
              ]}
            />
          )}
          {filtering && <ResultNote shown={list.length} total={all.length} noun={['department', 'departments']} />}
        </div>
      )}

      {departments.isLoading ? (
        <Loading rows={3} />
      ) : departments.error ? (
        <ErrorNote error={departments.error} onRetry={() => void departments.refetch()} />
      ) : all.length === 0 ? (
        <div className="rounded-lg border-2 border-dashed border-ink-300 bg-white/50">
          <EmptyState title="No departments yet">Add the first department to start building schedules.</EmptyState>
        </div>
      ) : list.length === 0 ? (
        <div className="rounded-lg border-2 border-dashed border-ink-300 bg-white/50">
          <EmptyState
            title="No department matches"
            action={
              <Button
                variant="secondary"
                onClick={() => {
                  setSearch('')
                  setShow('all')
                }}
              >
                Clear search and filters
              </Button>
            }
          >
            Try another code, name or program.
          </EmptyState>
        </div>
      ) : (
        <ul className="grid gap-6 xl:grid-cols-2">
          {list.map((d) => (
            <li key={d.id} className={`flex overflow-hidden rounded-lg bg-white shadow-[0_12px_22px_-18px_rgb(11_21_36/0.55)] ring-1 ring-ink-200 ${d.is_active ? '' : 'opacity-80'}`}>
              {/* the school's sign: its short code on a dark plate, as it would hang over the door */}
              <div
                className={`relative flex w-[132px] shrink-0 flex-col items-center justify-center px-2 py-6 text-center ${d.is_active ? 'bg-ink-900' : 'bg-ink-600'}`}
                aria-hidden
              >
                <Rivet className="left-2 top-2" />
                <Rivet className="right-2 top-2" />
                <Rivet className="bottom-2 left-2" />
                <Rivet className="bottom-2 right-2" />
                <span className={`break-all font-display text-[34px] font-semibold leading-[1.02] tracking-[-0.01em] ${d.is_active ? 'text-brass-300' : 'text-ink-200'}`}>{d.code}</span>
              </div>
              <div className="min-w-0 flex-1 p-5">
                <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className={`font-display text-[20px] font-semibold leading-6 ${d.is_active ? '' : 'text-ink-500'}`}>{d.name}</h2>
                    </div>
                    <div className="mt-1.5 flex items-center gap-2 text-[13px] text-ink-500">
                      {d.is_active ? <Badge tone="good">Active</Badge> : <Badge>Archived</Badge>}
                      <span>{d.code}</span>
                    </div>
                  </div>
                  <div className="-mr-2 flex">
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setNotice(null)
                        setDept({ id: d.id, code: d.code, name: d.name })
                      }}
                    >
                      Edit
                    </Button>
                    {d.is_active ? (
                      <Button variant="ghost" onClick={() => setArchiving(d)}>
                        Archive
                      </Button>
                    ) : (
                      <Button variant="ghost" busy={toggle.isPending} onClick={() => toggle.mutate(d)}>
                        Restore
                      </Button>
                    )}
                  </div>
                </div>

                <ul className="mt-4 divide-y divide-ink-100 border-y border-ink-100" aria-label={`Programs of ${d.code}`}>
                  {byDept(d.id).map((p) => (
                    <li key={p.id} className="flex items-center gap-3 py-2">
                      <span className="rounded-[4px] bg-ink-100 px-1.5 py-0.5 font-mono text-[12.5px] font-medium text-ink-700 ring-1 ring-inset ring-ink-200">{p.code}</span>
                      <span className="min-w-0 truncate text-[14px] text-ink-700" title={p.name}>
                        {p.name}
                      </span>
                    </li>
                  ))}
                  {byDept(d.id).length === 0 && <li className="py-2.5 text-[13px] text-ink-400">No programs yet</li>}
                </ul>
                <Button variant="secondary" className="mt-3 border-dashed" onClick={() => setAddingTo(d)}>
                  <Plus className="size-4" aria-hidden />
                  Add program
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <p className="mt-6 max-w-[64ch] text-[13px] text-ink-500">
        Departments are archived, never deleted, so their schedules and history stay intact. A program chair works
        only on the department assigned to them under Users.
      </p>

      <Modal
        open={dept !== null}
        onClose={() => setDept(null)}
        title={dept?.id ? 'Edit department' : 'Add department'}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDept(null)}>
              Cancel
            </Button>
            <Button type="submit" form="dept-form" busy={saveDept.isPending}>
              Save
            </Button>
          </>
        }
      >
        <form id="dept-form" onSubmit={submitDept} className="space-y-3">
          <label className="block">
            <span className="mb-1 block text-[13px] font-medium text-ink-700">Short code</span>
            <input
              required
              maxLength={12}
              value={dept?.code ?? ''}
              onChange={(e) => setDept((d) => d && { ...d, code: e.target.value })}
              className={inputCls}
              placeholder="SCITE"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[13px] font-medium text-ink-700">Full name</span>
            <input
              required
              value={dept?.name ?? ''}
              onChange={(e) => setDept((d) => d && { ...d, name: e.target.value })}
              className={inputCls}
              placeholder="School of Computing, Information Technology and Engineering"
            />
          </label>
        </form>
      </Modal>

      <Modal
        open={addingTo !== null}
        onClose={() => setAddingTo(null)}
        title={`Add a program to ${addingTo?.code ?? ''}`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setAddingTo(null)}>
              Cancel
            </Button>
            <Button type="submit" form="program-form" busy={addProgram.isPending}>
              Add program
            </Button>
          </>
        }
      >
        <form id="program-form" onSubmit={submitProgram} className="space-y-3">
          <label className="block">
            <span className="mb-1 block text-[13px] font-medium text-ink-700">Program code</span>
            <input
              required
              maxLength={12}
              value={progCode}
              onChange={(e) => setProgCode(e.target.value)}
              className={inputCls}
              placeholder="BSCPE"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[13px] font-medium text-ink-700">Program name</span>
            <input
              required
              value={progName}
              onChange={(e) => setProgName(e.target.value)}
              className={inputCls}
              placeholder="BS Computer Engineering"
            />
          </label>
        </form>
      </Modal>

      <Modal
        open={archiving !== null}
        onClose={() => setArchiving(null)}
        title={`Archive ${archiving?.code ?? ''}?`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setArchiving(null)}>
              Cancel
            </Button>
            <Button variant="danger" busy={toggle.isPending} onClick={() => archiving && toggle.mutate(archiving)}>
              Archive
            </Button>
          </>
        }
      >
        <p className="text-ink-600">
          The department is hidden from the lists used to assign people. Its programs, schedules and history are kept,
          and its bookings still block rooms for everyone else. You can restore it at any time.
        </p>
      </Modal>
    </>
  )
}
