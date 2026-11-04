import { useEffect, useRef } from 'react'
import { Pencil, RefreshCw, VideoOff } from 'lucide-react'
import { KeyBadge } from '@/components/StatusBadges'
import { Badge, Button } from '@/components/ui'
import { useCameraFeed } from '@/hooks/useCameraFeed'
import { usePresenceCheck } from '@/hooks/usePresenceCheck'
import { peopleText, presenceInfo } from '@/lib/presence/labels'
import { cn } from '@/lib/cn'
import { fmtRange, fmtRelative } from '@/lib/time'
import type { CameraRow, RoomStatus } from '@/lib/types'

/** Where a video of the given size is drawn inside a box (object-fit: contain). */
export function containedRect(boxW: number, boxH: number, vidW: number, vidH: number) {
  const scale = Math.min(boxW / vidW, boxH / vidH)
  const w = vidW * scale
  const h = vidH * scale
  return { x: (boxW - w) / 2, y: (boxH - h) / 2, w, h, scale }
}

const FEED_LABEL = { connecting: 'Connecting', live: 'Live', problem: 'No picture' } as const

export function CameraTile({
  camera,
  status,
  checking,
  showBoxes,
  canEdit,
  onEdit,
  showLabel,
  channel,
}: {
  camera: CameraRow
  status: RoomStatus | undefined
  /** this camera does the presence check for its room */
  checking: boolean
  showBoxes: boolean
  canEdit: boolean
  onEdit: () => void
  /** several cameras in one room: say which one */
  showLabel: boolean
  /** the number engraved on the monitor, in the order of the wall */
  channel?: number
}) {
  const video = useRef<HTMLVideoElement>(null)
  const overlay = useRef<HTMLCanvasElement>(null)
  const { state, stream, retry } = useCameraFeed(camera)
  const live = state.phase === 'live'
  const { result, problem } = usePresenceCheck(video, checking && live, camera.room_id)

  useEffect(() => {
    const v = video.current
    if (!v) return
    if (v.srcObject !== stream) v.srcObject = stream
    if (stream) void v.play().catch(() => undefined)
  }, [stream])

  // the boxes around what the detector counted (shapes only: nothing identifies anyone)
  useEffect(() => {
    const c = overlay.current
    if (!c) return
    const dpr = window.devicePixelRatio || 1
    const w = c.clientWidth
    const h = c.clientHeight
    c.width = Math.round(w * dpr)
    c.height = Math.round(h * dpr)
    const ctx = c.getContext('2d')!
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)
    if (!showBoxes || !result || !live) return
    const r = containedRect(w, h, result.width, result.height)
    ctx.lineWidth = 2
    ctx.strokeStyle = '#34d399'
    ctx.fillStyle = '#34d399'
    ctx.font = '600 11px system-ui, sans-serif'
    for (const b of result.boxes) {
      const x = r.x + b.x1 * r.scale
      const y = r.y + b.y1 * r.scale
      ctx.strokeRect(x, y, (b.x2 - b.x1) * r.scale, (b.y2 - b.y1) * r.scale)
      ctx.fillText(`${Math.round(b.score * 100)}%`, x + 3, Math.max(12, y - 3))
    }
  }, [result, showBoxes, live])

  const info = presenceInfo(status?.presence)
  const classNow = status && (status.schedule_entry_id || status.room_request_id) && status.start_time && status.end_time
  const roomName = `${camera.rooms?.code ?? 'Room'}${showLabel ? ` ${camera.label}` : ''}`

  // the live reading while this device is checking, else the latest one the database holds
  const cameraLine = checking && result
    ? `${peopleText(result.people, result.occupied)}, checked ${fmtRelative(new Date(result.at).toISOString())}`
    : status?.is_occupied !== null && status?.is_occupied !== undefined
      ? `${peopleText(status.person_count, status.is_occupied)}${status.occupancy_at ? `, ${fmtRelative(status.occupancy_at)}` : ''}`
      : 'not checked'

  const lampCls = live
    ? 'bg-emerald-400 shadow-[0_0_8px_2px_rgb(52_211_153/0.55)]'
    : state.phase === 'connecting'
      ? 'bg-brass-400 shadow-[0_0_8px_2px_rgb(210_154_63/0.45)]'
      : 'bg-rose-400 shadow-[0_0_8px_2px_rgb(251_113_133/0.5)]'

  return (
    <section className="rounded-xl bg-gradient-to-b from-ink-700 to-ink-800 p-2.5 shadow-[0_14px_24px_-14px_rgb(0_0_0/0.8)] ring-1 ring-ink-600" aria-label={`Camera ${roomName}`}>
      <header className="flex items-center justify-between gap-2 px-1.5 pb-2 pt-0.5">
        <div className="flex min-w-0 items-center gap-2.5">
          {channel !== undefined && (
            <span className="shrink-0 rounded-[3px] bg-ink-950 px-1.5 py-px font-mono text-[12px] leading-5 text-brass-300 ring-1 ring-ink-600" aria-hidden>
              {String(channel).padStart(2, '0')}
            </span>
          )}
          <div className="min-w-0">
            <h3 className="truncate font-display text-[18px] font-semibold leading-5 text-white">
              {camera.rooms?.code ?? 'Room'}
              {showLabel && <span className="ml-1.5 font-normal text-ink-300">{camera.label}</span>}
            </h3>
            <div className="truncate text-[12.5px] leading-4 text-ink-300">{camera.rooms?.name}</div>
          </div>
        </div>
        <span className="inline-flex shrink-0 items-center gap-2 rounded-full bg-ink-950 px-2.5 py-1 text-[12px] font-medium leading-4 text-ink-100 ring-1 ring-ink-600" role="status">
          <span className={cn('size-2 rounded-full', lampCls)} aria-hidden />
          {FEED_LABEL[state.phase]}
        </span>
      </header>

      <div className="relative aspect-video overflow-hidden rounded-md bg-ink-950 shadow-[inset_0_0_0_1px_rgb(0_0_0/0.6),inset_0_2px_14px_rgb(0_0_0/0.7)]">
        <video ref={video} muted playsInline autoPlay aria-label={`Live picture of ${roomName}`} className="absolute inset-0 size-full object-contain" />
        <canvas ref={overlay} className="pointer-events-none absolute inset-0 size-full" aria-hidden />
        {/* scan lines and the corners of the frame, drawn over the picture */}
        <div aria-hidden className="pointer-events-none absolute inset-0 bg-[repeating-linear-gradient(to_bottom,transparent_0_2px,rgb(0_0_0/0.16)_2px_3px)]" />
        <div aria-hidden className="pointer-events-none absolute inset-2.5 [background:linear-gradient(var(--c),var(--c))_0_0/14px_1.5px_no-repeat,linear-gradient(var(--c),var(--c))_0_0/1.5px_14px_no-repeat,linear-gradient(var(--c),var(--c))_100%_0/14px_1.5px_no-repeat,linear-gradient(var(--c),var(--c))_100%_0/1.5px_14px_no-repeat,linear-gradient(var(--c),var(--c))_0_100%/14px_1.5px_no-repeat,linear-gradient(var(--c),var(--c))_0_100%/1.5px_14px_no-repeat,linear-gradient(var(--c),var(--c))_100%_100%/14px_1.5px_no-repeat,linear-gradient(var(--c),var(--c))_100%_100%/1.5px_14px_no-repeat] [--c:rgb(227_185_106/0.55)]" />
        {!live && (
          <div className="absolute inset-0 grid place-items-center px-6 text-center text-ink-300">
            <div>
              <VideoOff className="mx-auto mb-2 size-6 text-ink-400" aria-hidden />
              <div className="text-[14px] text-white">{state.phase === 'connecting' ? 'Connecting to the camera' : 'No picture'}</div>
              {state.phase === 'problem' && (
                <div className="mt-1 text-[13px]" role="alert">
                  {state.message}
                  {state.retrying ? ' Trying again.' : ''}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="mt-2.5 space-y-2.5 rounded-md bg-ink-950/70 px-3 py-3 text-[14px] text-ink-100 ring-1 ring-ink-700/80">
        <div className="flex flex-wrap items-center gap-2">
          {info ? <Badge tone={info.tone}>{info.label}</Badge> : <Badge>No reading</Badge>}
          {checking && live && <span className="text-[12.5px] text-ink-300">Counting people on this device</span>}
        </div>
        {info && <p className="text-[13px] text-ink-300">{info.why}</p>}
        <dl className="grid grid-cols-[4.5rem_1fr] gap-x-3 gap-y-1.5 border-t border-ink-700 pt-2.5 text-[13px]">
          <dt className="text-ink-400">Class</dt>
          <dd>
            {classNow ? (
              <>
                {status.course_code}, {fmtRange(status.start_time!, status.end_time!)}
                {status.instructor_name ? `, ${status.instructor_name}` : ''}
              </>
            ) : (
              <span className="text-ink-400">None now</span>
            )}
          </dd>
          <dt className="text-ink-400">Key</dt>
          <dd>
            <KeyBadge status={status?.key_status ?? null} />
          </dd>
          <dt className="text-ink-400">Camera</dt>
          <dd>{cameraLine}</dd>
        </dl>
        {problem && (
          <p className="rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-[12.5px] text-amber-950" role="status">
            {problem.kind === 'model' ? problem.message : `The count could not be saved: ${problem.message}`}
          </p>
        )}
        {(state.phase === 'problem' || canEdit) && (
          <div className="flex items-center justify-between gap-2 pt-0.5">
            <div>
              {state.phase === 'problem' && (
                <Button variant="secondary" onClick={retry} aria-label={`Reconnect ${roomName}`}>
                  <RefreshCw className="size-4" aria-hidden />
                  Reconnect
                </Button>
              )}
            </div>
            {canEdit && (
              <Button variant="ghost" className="text-ink-200! hover:bg-ink-800! hover:text-white!" onClick={onEdit} aria-label={`Edit camera ${roomName}`}>
                <Pencil className="size-4" aria-hidden />
                Edit
              </Button>
            )}
          </div>
        )}
      </div>
    </section>
  )
}
