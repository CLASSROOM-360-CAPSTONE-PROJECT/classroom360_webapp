import { useCallback, useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { connectWhep, whepUrl, WhepError, type WhepFailure, type WhepSession } from '@/lib/presence/whep'
import type { CameraRow } from '@/lib/types'

export type FeedState =
  | { phase: 'connecting' }
  | { phase: 'live' }
  | { phase: 'problem'; kind: WhepFailure; message: string; retrying: boolean }

/**
 * Keeps one camera's live picture connected. It reconnects by itself after a drop, waiting a little
 * longer each time (2 s, 4 s, ... 30 s), and gives up only when the gateway refuses the sign-in.
 */
export function useCameraFeed(camera: Pick<CameraRow, 'id' | 'gateway_url' | 'stream_path'>, active = true) {
  const [state, setState] = useState<FeedState>({ phase: 'connecting' })
  const [stream, setStream] = useState<MediaStream | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!active) {
      setStream(null)
      return
    }
    let cancelled = false
    let session: WhepSession | null = null
    let timer: number | undefined
    let failures = 0

    const later = () => {
      failures += 1
      const wait = Math.min(30_000, 2000 * 2 ** Math.min(failures - 1, 4))
      timer = window.setTimeout(() => void connect(), wait)
    }

    const lost = (reason: string) => {
      if (cancelled) return
      session?.close()
      session = null
      setStream(null)
      setState({ phase: 'problem', kind: 'network', message: `The picture stopped (${reason}).`, retrying: true })
      later()
    }

    async function connect() {
      if (cancelled) return
      setState((s) => (s.phase === 'live' ? s : { phase: 'connecting' }))
      try {
        const { data } = await supabase.auth.getSession()
        const token = data.session?.access_token
        if (!token) throw new WhepError('You are signed out. Sign in again.', 'denied')
        const next = await connectWhep(whepUrl(camera.gateway_url, camera.stream_path), token, { onLost: lost })
        if (cancelled) {
          next.close()
          return
        }
        session = next
        failures = 0
        setStream(next.stream)
        setState({ phase: 'live' })
      } catch (err) {
        if (cancelled) return
        const e = err instanceof WhepError ? err : new WhepError(err instanceof Error ? err.message : 'The video could not be started.', 'media')
        setStream(null)
        const retrying = e.kind !== 'denied'
        setState({ phase: 'problem', kind: e.kind, message: e.message, retrying })
        if (retrying) later()
      }
    }

    void connect()
    return () => {
      cancelled = true
      window.clearTimeout(timer)
      session?.close()
      setStream(null)
    }
  }, [camera.id, camera.gateway_url, camera.stream_path, active, attempt])

  const retry = useCallback(() => setAttempt((n) => n + 1), [])
  return { state, stream, retry }
}
