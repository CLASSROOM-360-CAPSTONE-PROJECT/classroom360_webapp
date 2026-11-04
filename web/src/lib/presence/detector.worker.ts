/// <reference lib="webworker" />
/**
 * Runs the person-detection model off the page's main thread, so the page stays smooth while the
 * model thinks. The page sends a prepared picture (numbers only); this sends back person boxes.
 */
import * as ort from 'onnxruntime-web/wasm'
import wasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url'
import { decodePersons, INPUT_SIZE, type Detection } from './yolox'

export type WorkerRequest =
  | { type: 'init'; model: ArrayBuffer }
  | { type: 'run'; id: number; input: Float32Array; srcW: number; srcH: number }

export type WorkerResponse =
  | { type: 'ready' }
  | { type: 'error'; id?: number; message: string }
  | { type: 'result'; id: number; detections: Detection[] }

const ctx = self as unknown as DedicatedWorkerGlobalScope
let session: ort.InferenceSession | null = null
let inputName = ''
let outputName = ''

const reply = (msg: WorkerResponse) => ctx.postMessage(msg)

ctx.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data
  if (msg.type === 'init') {
    try {
      ort.env.wasm.wasmPaths = { wasm: wasmUrl }
      ort.env.wasm.numThreads = 1 // several threads need special page headers; one is plenty for a count every few seconds
      ort.env.wasm.proxy = false // this worker already is the background thread
      session = await ort.InferenceSession.create(new Uint8Array(msg.model), { executionProviders: ['wasm'], graphOptimizationLevel: 'all' })
      inputName = session.inputNames[0]!
      outputName = session.outputNames[0]!
      reply({ type: 'ready' })
    } catch (err) {
      reply({ type: 'error', message: err instanceof Error ? err.message : String(err) })
    }
    return
  }
  try {
    if (!session) throw new Error('the model is not loaded')
    const tensor = new ort.Tensor('float32', msg.input, [1, 3, INPUT_SIZE, INPUT_SIZE])
    const out = await session.run({ [inputName]: tensor })
    const detections = decodePersons(out[outputName]!.data as Float32Array, { srcW: msg.srcW, srcH: msg.srcH })
    reply({ type: 'result', id: msg.id, detections })
  } catch (err) {
    reply({ type: 'error', id: msg.id, message: err instanceof Error ? err.message : String(err) })
  }
}
