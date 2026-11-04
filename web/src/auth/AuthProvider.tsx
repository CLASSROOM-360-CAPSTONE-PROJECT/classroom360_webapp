import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { isConfigured, supabase } from '@/lib/supabase'
import type { Profile } from '@/lib/types'

type Status = 'loading' | 'signedOut' | 'noProfile' | 'ready'

interface AuthValue {
  status: Status
  session: Session | null
  profile: Profile | null
  /** Returns an error message, or null on success. */
  signIn: (email: string, password: string) => Promise<string | null>
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthValue | null>(null)

async function fetchProfile(userId: string): Promise<Profile | null> {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, tenant_id, role, full_name, email, department_id, tenants(name, timezone)')
    .eq('id', userId)
    .maybeSingle()
  if (error) throw error
  return data as unknown as Profile | null
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [sessionReady, setSessionReady] = useState(!isConfigured)
  const [loaded, setLoaded] = useState<{ userId: string; profile: Profile | null } | null>(null)

  useEffect(() => {
    if (!isConfigured) return
    void supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setSessionReady(true)
    })
    // keep this callback synchronous; Supabase can deadlock if it awaits another auth call
    const { data } = supabase.auth.onAuthStateChange((_event, next) => setSession(next))
    return () => data.subscription.unsubscribe()
  }, [])

  const userId = session?.user.id ?? null

  useEffect(() => {
    if (!userId) return
    let cancelled = false
    fetchProfile(userId)
      .catch(() => null)
      .then((profile) => {
        if (!cancelled) setLoaded({ userId, profile })
      })
    return () => {
      cancelled = true
    }
  }, [userId])

  const status: Status = !sessionReady
    ? 'loading'
    : !userId
      ? 'signedOut'
      : loaded?.userId !== userId
        ? 'loading'
        : loaded.profile
          ? 'ready'
          : 'noProfile'

  const signIn = useCallback(async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    return error ? error.message : null
  }, [])

  const signOut = useCallback(async () => {
    await supabase.auth.signOut()
    setLoaded(null)
  }, [])

  const value = useMemo<AuthValue>(
    () => ({
      status,
      session,
      profile: status === 'ready' && loaded ? loaded.profile : null,
      signIn,
      signOut,
    }),
    [status, session, loaded, signIn, signOut],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>')
  return ctx
}
