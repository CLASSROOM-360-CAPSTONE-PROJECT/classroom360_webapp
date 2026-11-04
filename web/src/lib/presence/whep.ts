/**
 * A small WHEP client (the standard way to play a WebRTC stream from a server) for the camera
 * gateway on the parent Raspberry Pi. The signed-in user's access token goes in the Authorization
 * header, and the gateway asks Supabase whether that person may watch before it sends any video.
 */

export type WhepFailure = 'denied' | 'offline' | 'network' | 'timeout' | 'media'

export class WhepError extends Error {
  readonly kind: WhepFailure
  constructor(message: string, kind: WhepFailure) {
    super(message)
    this.name = 'WhepError'
    this.kind = kind
  }
}

export interface WhepSession {
  stream: MediaStream
  pc: RTCPeerConnection
  /** ends the session; the gateway is told so it can free the connection */
  close(): void
}

export interface WhepOptions {
  /** how long to wait for the gateway and the first picture (default 12 s) */
  timeoutMs?: number
  iceServers?: RTCIceServer[]
  /** called when the connection drops after it was up, so the page can reconnect */
  onLost?: (reason: string) => void
}

/** The WHEP address of a stream on a gateway: http://192.168.1.50:8889 + lrc-301 */
export function whepUrl(gatewayUrl: string, streamPath: string): string {
  return `${gatewayUrl.replace(/\/+$/, '')}/${streamPath.replace(/^\/+|\/+$/g, '')}/whep`
}

function waitForIce(pc: RTCPeerConnection, ms: number): Promise<void> {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve()
    const done = () => {
      pc.removeEventListener('icegatheringstatechange', check)
      clearTimeout(timer)
      resolve()
    }
    const check = () => pc.iceGatheringState === 'complete' && done()
    const timer = setTimeout(done, ms)
    pc.addEventListener('icegatheringstatechange', check)
  })
}

/** A page served over https cannot talk to an http gateway (except one on this same computer). */
export function blockedByHttps(url: string, pageProtocol: string = globalThis.location?.protocol ?? 'http:'): boolean {
  try {
    const u = new URL(url)
    const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]'
    return pageProtocol === 'https:' && u.protocol === 'http:' && !local
  } catch {
    return false
  }
}

export async function connectWhep(url: string, token: string, opts: WhepOptions = {}): Promise<WhepSession> {
  const timeoutMs = opts.timeoutMs ?? 12_000
  const pc = new RTCPeerConnection({ iceServers: opts.iceServers ?? [] })
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), timeoutMs)
  let resource: string | null = null
  const fail = (e: WhepError): never => {
    clearTimeout(timer)
    pc.close()
    throw e
  }

  try {
    pc.addTransceiver('video', { direction: 'recvonly' })
    const stream = new MediaStream()
    const firstTrack = new Promise<void>((resolve) => {
      pc.ontrack = (e) => {
        stream.addTrack(e.track)
        resolve()
      }
    })

    await pc.setLocalDescription(await pc.createOffer())
    await waitForIce(pc, 2500)

    if (blockedByHttps(url)) {
      return fail(new WhepError('This page is on https, so the browser will not talk to an http gateway. Open the app over http on the school network, or put the gateway behind https.', 'network'))
    }

    let res: Response
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/sdp', Authorization: `Bearer ${token}` },
        body: pc.localDescription!.sdp,
        signal: abort.signal,
      })
    } catch (err) {
      if (abort.signal.aborted) return fail(new WhepError('The camera gateway did not answer in time.', 'timeout'))
      return fail(new WhepError('The camera gateway could not be reached. Check its address and that the Raspberry Pi is switched on.', 'network'))
    }
    if (res.status === 401 || res.status === 403) return fail(new WhepError('The camera gateway did not accept your sign-in.', 'denied'))
    if (res.status === 404) return fail(new WhepError('This camera is not sending video right now.', 'offline'))
    if (res.status === 400) {
      // MediaMTX answers this for a stream name that is not in its settings file, before it asks who is watching
      const text = await res.text().catch(() => '')
      if (text.includes('not configured')) {
        return fail(new WhepError('The camera gateway has no stream with this name. Ask an administrator to check the stream name for this camera.', 'offline'))
      }
    }
    if (!res.ok) return fail(new WhepError(`The camera gateway answered ${res.status}.`, 'network'))

    const location = res.headers.get('location')
    if (location) resource = new URL(location, url).toString()
    await pc.setRemoteDescription({ type: 'answer', sdp: await res.text() })

    await Promise.race([
      firstTrack,
      new Promise<never>((_, reject) => abort.signal.addEventListener('abort', () => reject(new WhepError('No picture arrived.', 'timeout')))),
    ])
    clearTimeout(timer)

    pc.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected' || pc.connectionState === 'closed') {
        opts.onLost?.(pc.connectionState)
      }
    })

    let closed = false
    return {
      stream,
      pc,
      close() {
        if (closed) return
        closed = true
        if (resource) void fetch(resource, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }).catch(() => undefined)
        pc.close()
      },
    }
  } catch (err) {
    if (err instanceof WhepError) throw err
    return fail(new WhepError(err instanceof Error ? err.message : 'The video could not be started.', 'media'))
  }
}
