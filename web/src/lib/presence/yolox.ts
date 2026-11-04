/**
 * Person detection with YOLOX (Apache-2.0), the pre- and post-processing around the ONNX model.
 * Pure functions, so they are tested without a model or a browser.
 *
 * The model takes a 416 x 416 picture (BGR, 0 to 255, the picture shrunk to fit and placed at the
 * top-left corner on grey) and returns 3549 candidate boxes of 85 numbers each:
 * centre x, centre y, width, height (in grid units), objectness, and 80 class scores. Class 0 is "person".
 * Only the person scores are used; nothing here looks at faces or tries to tell people apart.
 */

export const INPUT_SIZE = 416
export const STRIDES = [8, 16, 32] as const
export const VALUES_PER_BOX = 85
export const PAD_VALUE = 114

export interface Detection {
  x1: number
  y1: number
  x2: number
  y2: number
  score: number
}

export interface Letterbox {
  /** source pixel -> model pixel */
  scale: number
  /** the size the picture takes inside the 416 x 416 square */
  width: number
  height: number
}

/** How a picture of the given size is shrunk to fit the square (top-left, aspect ratio kept). */
export function letterbox(srcW: number, srcH: number, size = INPUT_SIZE): Letterbox {
  const scale = Math.min(size / srcW, size / srcH)
  return { scale, width: Math.max(1, Math.round(srcW * scale)), height: Math.max(1, Math.round(srcH * scale)) }
}

/** Number of candidate boxes for an input size: 52² + 26² + 13² = 3549 for 416. */
export function candidateCount(size = INPUT_SIZE): number {
  return STRIDES.reduce((n, s) => n + (size / s) ** 2, 0)
}

/** RGBA pixels of the square -> float32 [1, 3, size, size], channels in BGR order, values 0 to 255. */
export function toTensorData(rgba: ArrayLike<number>, size = INPUT_SIZE): Float32Array {
  const plane = size * size
  if (rgba.length < plane * 4) throw new Error(`expected ${plane * 4} pixel values, got ${rgba.length}`)
  const out = new Float32Array(3 * plane)
  for (let i = 0, p = 0; i < plane; i++, p += 4) {
    out[i] = rgba[p + 2]!
    out[plane + i] = rgba[p + 1]!
    out[2 * plane + i] = rgba[p]!
  }
  return out
}

function iou(a: Detection, b: Detection): number {
  const w = Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1)
  const h = Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1)
  if (w <= 0 || h <= 0) return 0
  const inter = w * h
  const union = (a.x2 - a.x1) * (a.y2 - a.y1) + (b.x2 - b.x1) * (b.y2 - b.y1) - inter
  return union <= 0 ? 0 : inter / union
}

/** Greedy non-maximum suppression: keep the best box, drop boxes that overlap it too much. */
export function nms(boxes: Detection[], iouThreshold: number): Detection[] {
  const sorted = [...boxes].sort((a, b) => b.score - a.score)
  const kept: Detection[] = []
  for (const box of sorted) {
    if (kept.every((k) => iou(k, box) <= iouThreshold)) kept.push(box)
  }
  return kept
}

export interface DecodeOptions {
  srcW: number
  srcH: number
  /** objectness x person score must be at least this (default 0.4) */
  scoreThreshold?: number
  nmsThreshold?: number
  /** ignore boxes narrower or shorter than this many source pixels */
  minSide?: number
  size?: number
}

/**
 * Turns the model output into person boxes in source-picture pixels.
 * `output` is the flattened [1, 3549, 85] tensor.
 */
export function decodePersons(output: ArrayLike<number>, opts: DecodeOptions): Detection[] {
  const size = opts.size ?? INPUT_SIZE
  const threshold = opts.scoreThreshold ?? 0.4
  const minSide = opts.minSide ?? 12
  const lb = letterbox(opts.srcW, opts.srcH, size)
  const total = candidateCount(size)
  if (output.length < total * VALUES_PER_BOX) throw new Error(`unexpected model output size ${output.length}`)

  const found: Detection[] = []
  let row = 0
  for (const stride of STRIDES) {
    const n = size / stride
    for (let gy = 0; gy < n; gy++) {
      for (let gx = 0; gx < n; gx++, row++) {
        const o = row * VALUES_PER_BOX
        const score = output[o + 4]! * output[o + 5]!
        if (score < threshold) continue
        const cx = (output[o]! + gx) * stride
        const cy = (output[o + 1]! + gy) * stride
        const w = Math.exp(output[o + 2]!) * stride
        const h = Math.exp(output[o + 3]!) * stride
        // back to the source picture, inside its edges
        const x1 = Math.max(0, (cx - w / 2) / lb.scale)
        const y1 = Math.max(0, (cy - h / 2) / lb.scale)
        const x2 = Math.min(opts.srcW, (cx + w / 2) / lb.scale)
        const y2 = Math.min(opts.srcH, (cy + h / 2) / lb.scale)
        if (x2 - x1 < minSide || y2 - y1 < minSide) continue
        found.push({ x1, y1, x2, y2, score })
      }
    }
  }
  return nms(found, opts.nmsThreshold ?? 0.45)
}
