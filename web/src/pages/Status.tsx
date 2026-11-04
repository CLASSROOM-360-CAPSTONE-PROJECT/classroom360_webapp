import { Link } from 'react-router-dom'
import { Loader2, Lock } from 'lucide-react'
import { useAuth } from '@/auth/AuthProvider'
import { Logo, LogoMark } from '@/components/Logo'
import { Rivet } from '@/components/surfaces'
import { Button } from '@/components/ui'

function Frame({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="drafting relative grid min-h-screen place-items-center px-4 py-10">
      <div className="relative w-full max-w-[560px] overflow-hidden rounded-xl bg-white shadow-[0_24px_40px_-26px_rgb(11_21_36/0.55)] ring-1 ring-ink-200">
        <div className="bg-ink-900 px-6 py-4 text-white">
          <Logo />
        </div>
        <span aria-hidden className="block h-1 bg-brass-500" />
        <div className="px-6 pb-6 pt-5">
          <h1 className="font-display text-[26px] font-semibold leading-tight tracking-[-0.01em]">{title}</h1>
          <div className="mt-3 space-y-3 text-ink-700">{children}</div>
        </div>
      </div>
    </div>
  )
}

export function FullPageLoading() {
  return (
    <div className="grid min-h-screen place-items-center text-ink-500" role="status">
      <span className="flex flex-col items-center gap-4">
        <LogoMark className="size-12 animate-pulse" />
        <span className="flex items-center gap-2">
          <Loader2 className="size-4 animate-spin" aria-hidden />
          Loading Classroom360
        </span>
      </span>
    </div>
  )
}

export function SetupNotice() {
  return (
    <Frame title="Connect the backend">
      <p>
        This app reads its data from your Supabase project. Add the project URL and anon key, then restart the dev
        server.
      </p>
      <ol className="list-decimal space-y-1.5 pl-5">
        <li>
          Copy <code className="rounded bg-ink-100 px-1.5 py-0.5 text-[13px]">.env.example</code> to{' '}
          <code className="rounded bg-ink-100 px-1.5 py-0.5 text-[13px]">.env.local</code>.
        </li>
        <li>
          Paste the values from Supabase, under Project Settings, then API:{' '}
          <code className="rounded bg-ink-100 px-1.5 py-0.5 text-[13px]">VITE_SUPABASE_URL</code> and{' '}
          <code className="rounded bg-ink-100 px-1.5 py-0.5 text-[13px]">VITE_SUPABASE_ANON_KEY</code>.
        </li>
        <li>
          Run the SQL in <code className="rounded bg-ink-100 px-1.5 py-0.5 text-[13px]">supabase/migrations</code>, then{' '}
          <code className="rounded bg-ink-100 px-1.5 py-0.5 text-[13px]">supabase/seed.sql</code>.
        </li>
      </ol>
      <p className="text-[13px] text-ink-500">The README walks through each step.</p>
    </Frame>
  )
}

export function NotProvisioned() {
  const { signOut, session } = useAuth()
  return (
    <Frame title="Your account is not set up yet">
      <p>
        You signed in as <strong>{session?.user.email}</strong>, but this account has no profile in the institution.
        This usually means the account was created before the institution was added.
      </p>
      <p>Ask an administrator to set up your account, then sign in again.</p>
      <Button variant="secondary" onClick={() => void signOut()}>
        Sign out
      </Button>
    </Frame>
  )
}

export function Forbidden() {
  return (
    <div className="grid place-items-center py-14">
      <div className="relative w-full max-w-[460px] rounded-lg bg-ink-900 px-8 pb-8 pt-9 text-center text-white shadow-[0_24px_40px_-24px_rgb(11_21_36/0.7)] ring-1 ring-ink-700">
        <Rivet className="left-3 top-3" />
        <Rivet className="right-3 top-3" />
        <Rivet className="bottom-3 left-3" />
        <Rivet className="bottom-3 right-3" />
        <span aria-hidden className="mx-auto grid size-14 place-items-center rounded-full bg-brass-400/15 text-brass-300 ring-2 ring-brass-400/60">
          <Lock className="size-6" />
        </span>
        <h1 className="mt-5 font-display text-[26px] font-semibold leading-tight">You do not have access to this page</h1>
        <p className="mx-auto mt-2 max-w-[40ch] text-ink-300">
          Your role does not include this part of Classroom360. If you need it, ask an administrator to change your role.
        </p>
        <Link to="/" className="mt-5 inline-block rounded-md bg-brass-400 px-4 py-2 font-medium text-ink-950 hover:bg-brass-300">
          Back to the dashboard
        </Link>
      </div>
    </div>
  )
}

export function NotFound() {
  return (
    <div className="flex flex-wrap items-center justify-center gap-x-12 gap-y-8 py-14">
      <div aria-hidden className="relative h-[190px] w-[132px] shrink-0">
        <span className="absolute left-1/2 top-0 h-9 w-px -translate-x-1/2 bg-ink-400" />
        <div className="absolute inset-x-0 bottom-0 top-8 origin-top -rotate-3 rounded-2xl bg-brass-200 shadow-[0_18px_26px_-16px_rgb(11_21_36/0.6)] ring-1 ring-brass-500/60">
          <span className="absolute left-1/2 top-3.5 size-4 -translate-x-1/2 rounded-full bg-canvas ring-1 ring-brass-600/60" />
          <span className="absolute inset-x-0 top-[3.6rem] text-center font-display text-[64px] font-semibold leading-none text-brass-800">?</span>
          <span className="absolute inset-x-5 bottom-5 h-px bg-brass-600/40" />
          <span className="absolute inset-x-8 bottom-8 h-px bg-brass-600/30" />
        </div>
      </div>
      <div className="max-w-[40ch]">
        <h1 className="font-display text-[30px] font-semibold leading-tight tracking-[-0.01em]">Page not found</h1>
        <p className="mt-2 text-ink-500">The address does not match any page in Classroom360.</p>
        <Link to="/" className="mt-4 inline-block rounded-md bg-ink-900 px-4 py-2 font-medium text-white hover:bg-ink-800">
          Back to the dashboard
        </Link>
      </div>
    </div>
  )
}
