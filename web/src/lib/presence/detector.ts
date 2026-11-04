/**
 * The person detector: YOLOX-Tiny run with ONNX Runtime Web (WebAssembly) inside the browser.
 * It runs on whichever device is watching, so no frame is sent anywhere. Only a count leaves the device.
 *
 * The model file is not part of the source: `npm run setup:presence` downloads it into public/models/
 * (Apache-2.0, from the YOLOX project's releases). Until it is there the page says so.
 */
import type { WorkerRequest, WorkerResponse } from './detector.worker'
import { INPUT_SIZE, letterbox, PAD_VALUE, toTensorData, type Detection } from './yolox'

export const MODEL_URL = (import.meta.env.VITE_PRESENCE_MODEL_URL as string | undefined) ?? '/models/yolox_tiny.onnx'

export type DetectorFailure = 'missing' | 'load'

export class DetectorError extends Error {
  readonly kind: DetectorFailure
  constructor(message: string, kind: DetectorFailure) {
    super(message)
    this.name = 'DetectorError'
    this.kind = kind
  }
}

export interface PersonDetector {
  /** counts the people in a video frame (or any drawable picture) of the given size */
  detect(source: CanvasImageSource, srcW: number, srcH: number): Promise<Detection[]>
}

let cached: Promise<PersonDetector> | null = null

/** Loads the model once and shares it between every camera. */
export function loadPersonDetector(): Promise<PersonDetector> {
  if (!cached) {
    cached = create().catch((err) => {
      cached = null // let a later attempt try again, for example after the file was downloaded
      throw err
    })
  }
  return cached
}

async function create(): Promise<PersonDetector> {
  let res: Response
  try {
    res = await fetch(MODEL_URL)
  } catch {
    throw new DetectorError('The person-detection model could not be fetched.', 'missing')
  }
  const type = res.headers.get('content-type') ?? ''
  // a development server answers an unknown file with the app's own page
  if (!res.ok || type.includes('text/html')) {
    throw new DetectorError('The person-detection model is not installed. Run "npm run setup:presence" in the web folder.', 'missing')
  }
  const model = await res.arrayBuffer()
  if (model.byteLength < 1_000_000) throw new DetectorError('The person-detection model file looks incomplete.', 'missing')

  // the model runs in a background thread so the page stays smooth
  const worker = new Worker(new URL('./detector.worker.ts', import.meta.url), { type: 'module' })
  let nextId = 1
  const pending = new Map<number, { resolve: (d: Detection[]) => void; reject: (e: Error) => void }>()
  let onReady: { resolve: () => void; reject: (e: Error) => void } | null = null
  let dead: Error | null = null

  const fail = (err: Error) => {
    dead = err
    cached = null // a later attempt starts a fresh worker
    onReady?.reject(err)
    onReady = null
    for (const p of pending.values()) p.reject(err)
    pending.clear()
    worker.terminate()
  }

  worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
    const msg = event.data
    if (msg.type === 'ready') {
      onReady?.resolve()
      onReady = null
    } else if (msg.type === 'result') {
      pending.get(msg.id)?.resolve(msg.detections)
      pending.delete(msg.id)
    } else if (msg.id === undefined) {
      fail(new DetectorError(msg.message, 'load'))
    } else {
      pending.get(msg.id)?.reject(new Error(msg.message))
      pending.delete(msg.id)
    }
  }
  worker.onerror = (e) => fail(new DetectorError(e.message || 'The person-detection worker stopped.', 'load'))

  await new Promise<void>((resolve, reject) => {
    onReady = { resolve, reject }
    const init: WorkerRequest = { type: 'init', model }
    worker.postMessage(init, [model])
  })

  const canvas = document.createElement('canvas')
  canvas.width = INPUT_SIZE
  canvas.height = INPUT_SIZE
  const ctx2d = canvas.getContext('2d', { willReadFrequently: true })!

  // one picture at a time, so several cameras share the model without piling up work
  let queue: Promise<unknown> = Promise.resolve()

  const run = (source: CanvasImageSource, srcW: number, srcH: number): Promise<Detection[]> => {
    if (dead) return Promise.reject(dead)
    const lb = letterbox(srcW, srcH)
    ctx2d.fillStyle = `rgb(${PAD_VALUE},${PAD_VALUE},${PAD_VALUE})`
    ctx2d.fillRect(0, 0, INPUT_SIZE, INPUT_SIZE)
    ctx2d.drawImage(source, 0, 0, srcW, srcH, 0, 0, lb.width, lb.height)
    const input = toTensorData(ctx2d.getImageData(0, 0, INPUT_SIZE, INPUT_SIZE).data)
    const id = nextId++
    return new Promise<Detection[]>((resolve, reject) => {
      pending.set(id, { resolve, reject })
      const req: WorkerRequest = { type: 'run', id, input, srcW, srcH }
      worker.postMessage(req, [input.buffer])
    })
  }

  return {
    detect(source, srcW, srcH) {
      const next = queue.then(() => run(source, srcW, srcH))
      queue = next.catch(() => undefined)
      return next
    },
  }
}
