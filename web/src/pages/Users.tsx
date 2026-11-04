import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@/auth/AuthProvider'
import { ResultNote, SearchInput, Segmented, SortTh, useSort } from '@/components/controls'
import { Panel } from '@/components/surfaces'
import { Button, EmptyState, ErrorNote, inputCls, Loading, Notice, Table, TBody, THead, td } from '@/components/ui'
import { unwrap, useDepartments } from '@/lib/api'
import { ROLES, ROLE_LABEL, type Role } from '@/lib/roles'
import { cn } from '@/lib/cn'
import { supabase } from '@/lib/supabase'
import { matchesQuery, sortRows } from '@/lib/tableView'
import type { ProfileRow } from '@/lib/types'

/** Each role has its own colour wherever it shows: the bar in the header, the edge of a row, the initials. */
const ROLE_LOOK: Record<Role, { bar: string; chip: string; edge: string }> = {
  admin: { bar: 'bg-ink-900', chip: 'bg-ink-900 text-white', edge: 'bg-ink-900' },
  dean: { bar: 'bg-brass-500', chip: 'bg-brass-100 text-brass-800 ring-1 ring-brass-300', edge: 'bg-brass-500' },
  program_chair: { bar: 'bg-teal-600', chip: 'bg-teal-50 text-teal-800 ring-1 ring-teal-300', edge: 'bg-teal-600' },
  instructor: { bar: 'bg-ink-300', chip: 'bg-ink-100 text-ink-700 ring-1 ring-ink-300', edge: 'bg-ink-300' },
}

const initials = (name: string | null, email: string | null) => {
  const words = (name || email || '?').replace(/@.*/, '').split(/[\s._-]+/).filter(Boolean)
  return ((words[0]?.[0] ?? '?') + (words.length > 1 ? (words[words.length - 1]?.[0] ?? '') : '')).toUpperCase()
}

/** Who holds which level of access, drawn as one bar: a glance says whether the keys are in too many hands. */
function AccessBar({ people }: { people: ProfileRow[] }) {
  const parts = ROLES.map((r) => ({ role: r, n: people.filter((u) => u.role === r).length })).filter((x) => x.n > 0)
  return (
    <div className="mt-5 max-w-[560px]">
      <div aria-hidden className="flex h-3 gap-[3px] overflow-hidden rounded-full bg-ink-100 p-[2px] ring-1 ring-ink-200">
        {parts.map((x) => (
          <span key={x.role} className={cn('rounded-full', ROLE_LOOK[x.role].bar)} style={{ flexGrow: x.n, flexBasis: 0 }} title={`${ROLE_LABEL[x.role]}: ${x.n}`} />
        ))}
      </div>
      <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-2">
        {parts.map((x) => (
          <div key={x.role} className="flex items-center gap-2">
            <span aria-hidden className={cn('size-2.5 rounded-full', ROLE_LOOK[x.role].bar)} />
            <dt className="text-[13px] text-ink-600">{ROLE_LABEL[x.role]}</dt>
            <dd className="font-display text-[20px] font-semibold leading-5">{x.n}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

export default function Users() {
  const { profile } = useAuth()
  const qc = useQueryClient()
  const departments = useDepartments()
  const [notice, setNotice] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null)
  const [search, setSearch] = useState('')
  const [roleFilter, setRoleFilter] = useState<Role | 'all'>('all')
  const sort = useSort<'person' | 'role' | 'dept'>(null)

  const users = useQuery({
    queryKey: ['users'],
    queryFn: () =>
      unwrap<ProfileRow[]>(
        supabase.from('profiles').select('id, full_name, email, role, department_id, created_at').order('created_at'),
      ),
  })

  const update = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: { role?: Role; department_id?: string | null } }) =>
      unwrap<{ id: string }[]>(supabase.from('profiles').update(patch).eq('id', id).select('id')),
    onSuccess: () => {
      setNotice({ tone: 'good', text: 'Saved.' })
      void qc.invalidateQueries({ queryKey: ['users'] })
      void qc.invalidateQueries({ queryKey: ['audit'] })
    },
    onError: (err) => setNotice({ tone: 'bad', text: err instanceof Error ? err.message : 'The change was not saved.' }),
  })

  const everyone = users.data ?? []
  const filtering = Boolean(search.trim()) || roleFilter !== 'all'
  const deptCode = (id: string | null) => (departments.data ?? []).find((d) => d.id === id)?.code
  const list = useMemo(() => {
    const kept = everyone.filter((u) => (roleFilter === 'all' || u.role === roleFilter) && matchesQuery(`${u.full_name ?? ''} ${u.email ?? ''} ${ROLE_LABEL[u.role]}`, search))
    if (!sort.key) return kept
    const get = {
      person: (u: ProfileRow) => u.full_name || u.email,
      role: (u: ProfileRow) => ROLE_LABEL[u.role],
      dept: (u: ProfileRow) => deptCode(u.department_id),
    }[sort.key]
    return sortRows(kept, get, sort.dir)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [everyone, roleFilter, search, sort.key, sort.dir, departments.data])

  return (
    <>
      <header className="mb-7">
        <div className="flex flex-wrap items-end gap-x-10 gap-y-3">
          <div>
            <h1 className="font-display text-[34px] font-semibold leading-none tracking-[-0.02em]">Users</h1>
            <p className="mt-2 max-w-[60ch] text-ink-500">Everyone who can sign in. New accounts start as instructors; set the role and, for program chairs, the department.</p>
          </div>
          {everyone.length > 0 && (
            <p className="flex items-baseline gap-2">
              <span className="font-display text-[44px] font-semibold leading-none">{everyone.length}</span>
              <span className="text-[13px] text-ink-500">{everyone.length === 1 ? 'account' : 'accounts'}</span>
            </p>
          )}
        </div>
        {everyone.length > 0 && <AccessBar people={everyone} />}
      </header>
      {notice && (
        <Notice tone={notice.tone} onDismiss={() => setNotice(null)}>
          {notice.text}
        </Notice>
      )}
      {everyone.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <SearchInput value={search} onChange={setSearch} label="Search users" placeholder="Search name, email or role" className="w-full sm:w-80" shortcut />
          <Segmented
            label="Show users"
            value={roleFilter}
            onChange={setRoleFilter}
            options={[
              { value: 'all', label: 'Everyone', count: everyone.length },
              ...ROLES.map((r) => ({ value: r, label: ROLE_LABEL[r], count: everyone.filter((u) => u.role === r).length })).filter((o) => o.count > 0),
            ]}
          />
          {filtering && <ResultNote shown={list.length} total={everyone.length} noun={['user', 'users']} />}
        </div>
      )}
      <Panel title="Who can sign in" description="A change to a role or department is saved at once and written to the audit log." flush>
        {users.isLoading ? (
          <Loading rows={5} />
        ) : users.error ? (
          <div className="p-4">
            <ErrorNote error={users.error} onRetry={() => void users.refetch()} />
          </div>
        ) : everyone.length === 0 ? (
          <EmptyState title="No users yet">Accounts created in Supabase Authentication appear here.</EmptyState>
        ) : list.length === 0 ? (
          <EmptyState
            title="No user matches"
            action={
              <Button
                variant="secondary"
                onClick={() => {
                  setSearch('')
                  setRoleFilter('all')
                }}
              >
                Clear search and filters
              </Button>
            }
          >
            Try another name or email.
          </EmptyState>
        ) : (
          <Table>
            <THead>
              <tr>
                <SortTh label="Person" k="person" sort={sort} />
                <SortTh label="Role" k="role" sort={sort} />
                <SortTh label="Department" k="dept" sort={sort} />
              </tr>
            </THead>
            <TBody>
              {list.map((u) => {
                const self = u.id === profile?.id
                return (
                  <tr key={u.id} className={cn(self && 'bg-brass-50/60')}>
                    <td className={`${td} relative pl-5`}>
                      <span aria-hidden className={cn('absolute inset-y-0 left-0 w-1', ROLE_LOOK[u.role].edge)} />
                      <div className="flex items-center gap-3">
                        <span aria-hidden className={cn('grid size-9 shrink-0 place-items-center rounded-full font-display text-[14px] font-semibold tracking-wide', ROLE_LOOK[u.role].chip)}>
                          {initials(u.full_name, u.email)}
                        </span>
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 font-medium">
                            <span className="truncate">{u.full_name || u.email}</span>
                            {self && <span className="rounded-sm bg-brass-100 px-1.5 text-[11.5px] font-semibold leading-5 text-brass-800 ring-1 ring-brass-300">You</span>}
                          </div>
                          <div className="truncate text-[13px] text-ink-500">{u.full_name ? u.email : ''}</div>
                        </div>
                      </div>
                    </td>
                    <td className={td}>
                      <select
                        aria-label={`Role for ${u.full_name || u.email}`}
                        value={u.role}
                        disabled={self || update.isPending}
                        title={self ? 'You cannot change your own role' : undefined}
                        onChange={(e) => {
                          setNotice(null)
                          update.mutate({ id: u.id, patch: { role: e.target.value as Role } })
                        }}
                        className={`${inputCls} w-44 min-w-[11rem]`}
                      >
                        {ROLES.map((r) => (
                          <option key={r} value={r}>
                            {ROLE_LABEL[r]}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className={td}>
                      <select
                        aria-label={`Department for ${u.full_name || u.email}`}
                        value={u.department_id ?? ''}
                        disabled={update.isPending}
                        onChange={(e) => {
                          setNotice(null)
                          update.mutate({ id: u.id, patch: { department_id: e.target.value || null } })
                        }}
                        className={`${inputCls} w-56 min-w-[12rem]`}
                      >
                        <option value="">None</option>
                        {(departments.data ?? []).filter((d) => d.is_active || d.id === u.department_id).map((d) => (
                          <option key={d.id} value={d.id}>
                            {d.is_active ? d.code : `${d.code} (archived)`}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                )
              })}
            </TBody>
          </Table>
        )}
      </Panel>
    </>
  )
}
