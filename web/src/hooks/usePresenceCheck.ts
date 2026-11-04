import { useEffect, useState, type RefObject } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { loadPersonDetector, DetectorError } from '@/lib/presence/detector'
import { OccupancySmoother, shouldReport } from '@/lib/presence/smoothing'
import type { Detection } from '@/lib/presence/yolox'
import { supabase } from '@/lib/supabase'

export const CHECK_EVERY_MS = 3000

export interface PresenceResult {
  /** people in the latest picture */
  now: number
  /** what the last few pictures add up to */
  people: number
  occupied: boolean
  boxes: Detection[]
  /** the size of the picture the boxes belong to */
  width: number
  height: number
  at: number
}

/**
 * Looks at the camera picture every few seconds, counts the people (no faces, no identities) and
 * reports the count for the room. The picture never leaves this device.
 * It only looks while the page is visible: a hidden page can show a stale picture.
 */
export function usePresenceCheck(video: RefObject<HTMLVideoElement | null>, active: boolean, roomId: string) {
  const [result, setResult] = useState<PresenceResult | null>(null)
  const [problem, setProblem] = useState<{ kind: 'model' | 'report'; message: string } | null>(null)
  const qc = useQueryClient()

  useEffect(() => {
    if (!active) {
      setResult(null)
      return
    }
    let stopped = false
    let timer: number | undefined
    const smoother = new OccupancySmoother()
    let lastReport: { occupied: boolean; at: number } | null = null

    const tick = async () => {
      let again = true
      try {
        const v = video.current
        if (v && !document.hidden && v.readyState >= 2 && v.videoWidth > 0 && !v.paused) {
          const detector = await loadPersonDetector()
          if (stopped) return
          const boxes = await detector.detect(v, v.videoWidth, v.videoHeight)
          if (stopped) return
          const reading = smoother.push(boxes.length)
          const at = Date.now()
          setProblem((p) => (p?.kind === 'model' ? null : p))
          setResult({ now: boxes.length, people: reading.people, occupied: reading.occupied, boxes, width: v.videoWidth, height: v.videoHeight, at })
          if (shouldReport(lastReport, reading, at)) {
            const confidence = boxes.length ? boxes.reduce((s, b) => s + b.score, 0) / boxes.length : null
            const { error } = await supabase.rpc('report_occupancy', { p_room_id: roomId, p_people: reading.people, p_confidence: confidence })
            if (error) setProblem({ kind: 'report', message: error.message })
            else {
              setProblem((p) => (p?.kind === 'report' ? null : p))
              lastReport = { occupied: reading.occupied, at }
              void qc.invalidateQueries({ queryKey: ['room-status'] }) // the verdict now has this reading
            }
          }
        }
      } catch (err) {
        if (err instanceof DetectorError) {
          setProblem({ kind: 'model', message: err.message })
          if (err.kind === 'missing') again = true // checked again later, in case the file has been added
        }
      } finally {
        if (!stopped && again) timer = window.setTimeout(() => void tick(), CHECK_EVERY_MS)
      }
    }
    timer = window.setTimeout(() => void tick(), 800)
    return () => {
      stopped = true
      window.clearTimeout(timer)
    }
  }, [active, roomId, video, qc])

  return { result, problem }
}
