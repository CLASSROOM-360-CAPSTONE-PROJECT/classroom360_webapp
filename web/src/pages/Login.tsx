import { useState, type FormEvent } from 'react'
import { KeyRound, Mail } from 'lucide-react'
import { Navigate, useLocation } from 'react-router-dom'
import { useAuth } from '@/auth/AuthProvider'
import { KeyRack } from '@/components/art'
import { Logo } from '@/components/Logo'
import { Button, inputCls } from '@/components/ui'
import { FullPageLoading } from './Status'

export default function Login() {
  const { status, signIn } = useAuth()
  const location = useLocation()
  const from = (location.state as { from?: string } | null)?.from ?? '/'
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  if (status === 'loading') return <FullPageLoading />
  if (status === 'ready' || status === 'noProfile') return <Navigate to={from} replace />

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const message = await signIn(email.trim(), password)
    if (message) setError(message)
    setBusy(false)
  }

  return (
    <div className="grid min-h-screen grid-cols-1 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]">
      <div className="drafting-dark relative hidden flex-col justify-between overflow-hidden bg-ink-900 p-12 text-white lg:flex">
        <Logo className="relative" />
        <div className="relative">
          <KeyRack className="mb-10" />
          <h2 className="max-w-[18ch] font-display text-[44px] font-semibold leading-[1.02] tracking-[-0.02em]">Every key follows the timetable.</h2>
          <p className="mt-4 max-w-[44ch] text-ink-300">
            Four doors, one key per room, released only to the instructor scheduled in that room and returned on record.
          </p>
        </div>
        <div className="relative text-[13px] text-ink-400">Holy Cross Colleges, Inc. School of Computing, Information Technology, and Engineering</div>
      </div>

      <div className="relative grid place-items-center overflow-hidden px-5 py-12 sm:px-6">
        <div aria-hidden className="drafting pointer-events-none absolute inset-0" />
        <form onSubmit={onSubmit} className="relative w-full max-w-[400px]">
          <Logo className="mb-7 text-ink-900 lg:hidden" />
          <div className="relative overflow-hidden rounded-xl bg-white px-6 pb-6 pt-8 shadow-[0_24px_40px_-26px_rgb(11_21_36/0.55)] ring-1 ring-ink-200 sm:px-7">
            <span aria-hidden className="absolute inset-x-0 top-0 h-1.5 bg-brass-500" />
            <span aria-hidden className="absolute left-1/2 top-3 h-1.5 w-12 -translate-x-1/2 rounded-full bg-ink-100 ring-1 ring-inset ring-ink-200" />
            <h1 className="font-display text-[32px] font-semibold leading-none tracking-[-0.015em]">Sign in</h1>
            <p className="mt-1.5 text-ink-500">Use the email and password from your administrator.</p>

            <label className="mt-6 block text-[13px] font-medium text-ink-700" htmlFor="email">
              Email
            </label>
            <div className="relative mt-1">
              <Mail aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-400" />
              <input
                id="email"
                type="email"
                autoComplete="username"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className={`${inputCls} pl-9!`}
              />
            </div>

            <label className="mt-4 block text-[13px] font-medium text-ink-700" htmlFor="password">
              Password
            </label>
            <div className="relative mt-1">
              <KeyRound aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-400" />
              <input
                id="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className={`${inputCls} pl-9!`}
              />
            </div>

            {error && (
              <p className="mt-4 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-[13px] text-rose-800" role="alert">
                {error}
              </p>
            )}

            <Button type="submit" busy={busy} className="mt-6 w-full">
              Sign in
            </Button>
          </div>
          <p className="mt-4 px-1 text-[13px] text-ink-500">Accounts are created by an administrator. There is no public sign-up.</p>
        </form>
      </div>
    </div>
  )
}
