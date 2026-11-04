import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { candidateCount, decodePersons, INPUT_SIZE, letterbox, nms, toTensorData, VALUES_PER_BOX } from '../src/lib/presence/yolox.ts'

/** A model output with no detections: every box has objectness 0. */
function emptyOutput(size = INPUT_SIZE): Float32Array {
  return new Float32Array(candidateCount(size) * VALUES_PER_BOX)
}

/** Writes one candidate box in the model's own units: grid cell (gx, gy) of a stride. */
function put(out: Float32Array, stride: 8 | 16 | 32, gx: number, gy: number, box: { dx: number; dy: number; w: number; h: number }, obj: number, person: number, size = INPUT_SIZE) {
  let row = 0
  for (const s of [8, 16, 32]) {
    const n = size / s
    if (s === stride) {
      row += gy * n + gx
      break
    }
    row += n * n
  }
  const o = row * VALUES_PER_BOX
  out[o] = box.dx
  out[o + 1] = box.dy
  out[o + 2] = Math.log(box.w / stride)
  out[o + 3] = Math.log(box.h / stride)
  out[o + 4] = obj
  out[o + 5] = person
}

describe('letterbox', () => {
  it('shrinks a wide picture to fit the width and keeps its shape', () => {
    const lb = letterbox(1920, 1080)
    assert.equal(lb.width, 416)
    assert.equal(lb.height, 234)
    assert.ok(Math.abs(lb.scale - 416 / 1920) < 1e-12)
  })
  it('shrinks a tall picture to fit the height', () => {
    const lb = letterbox(480, 640)
    assert.equal(lb.height, 416)
    assert.equal(lb.width, 312)
  })
  it('also enlarges a small picture, and never returns a zero size', () => {
    assert.equal(letterbox(208, 208).width, 416)
    assert.equal(letterbox(10000, 1).height, 1)
  })
})

describe('candidate count', () => {
  it('is 3549 for the 416 square', () => {
    assert.equal(candidateCount(), 52 * 52 + 26 * 26 + 13 * 13)
    assert.equal(candidateCount(), 3549)
  })
})

describe('toTensorData', () => {
  it('writes planes in blue, green, red order with raw 0 to 255 values', () => {
    const size = 2
    const rgba = new Uint8ClampedArray([
      10, 20, 30, 255, //
      11, 21, 31, 255,
      12, 22, 32, 255,
      13, 23, 33, 255,
    ])
    const t = toTensorData(rgba, size)
    assert.equal(t.length, 12)
    assert.deepEqual([...t.slice(0, 4)], [30, 31, 32, 33]) // blue plane
    assert.deepEqual([...t.slice(4, 8)], [20, 21, 22, 23]) // green plane
    assert.deepEqual([...t.slice(8, 12)], [10, 11, 12, 13]) // red plane
  })
  it('refuses a picture of the wrong size', () => {
    assert.throws(() => toTensorData(new Uint8Array(100), 416), /expected/)
  })
})

describe('nms', () => {
  const box = (x1: number, y1: number, x2: number, y2: number, score: number) => ({ x1, y1, x2, y2, score })
  it('keeps the best of two heavily overlapping boxes', () => {
    const kept = nms([box(0, 0, 100, 200, 0.6), box(5, 5, 105, 205, 0.9)], 0.45)
    assert.equal(kept.length, 1)
    assert.equal(kept[0]!.score, 0.9)
  })
  it('keeps two people standing side by side', () => {
    assert.equal(nms([box(0, 0, 100, 200, 0.8), box(110, 0, 210, 200, 0.7)], 0.45).length, 2)
  })
  it('does not change its input', () => {
    const input = [box(0, 0, 10, 10, 0.1), box(0, 0, 10, 10, 0.9)]
    nms(input, 0.5)
    assert.equal(input[0]!.score, 0.1)
  })
})

describe('decodePersons', () => {
  it('finds nothing in an empty output', () => {
    assert.deepEqual(decodePersons(emptyOutput(), { srcW: 640, srcH: 480 }), [])
  })

  it('maps a box back to the source picture', () => {
    const out = emptyOutput()
    // centre (200, 150) in the 416 square, 60 wide and 120 tall; stride 8, cell (25, 18) + offset (0, 6/8)
    put(out, 8, 25, 18, { dx: 0, dy: 6 / 8, w: 60, h: 120 }, 0.9, 0.9)
    const found = decodePersons(out, { srcW: 832, srcH: 624 }) // exactly twice the model's square on the long side
    assert.equal(found.length, 1)
    const d = found[0]!
    assert.ok(Math.abs(d.x1 - (200 - 30) * 2) < 1e-3, `x1 ${d.x1}`)
    assert.ok(Math.abs(d.x2 - (200 + 30) * 2) < 1e-3, `x2 ${d.x2}`)
    assert.ok(Math.abs(d.y1 - (150 - 60) * 2) < 1e-3, `y1 ${d.y1}`)
    assert.ok(Math.abs(d.y2 - (150 + 60) * 2) < 1e-3, `y2 ${d.y2}`)
    assert.ok(Math.abs(d.score - 0.81) < 1e-6)
  })

  it('works on all three strides', () => {
    const out = emptyOutput()
    put(out, 8, 5, 5, { dx: 0.5, dy: 0.5, w: 40, h: 90 }, 0.9, 0.9)
    put(out, 16, 15, 12, { dx: 0.5, dy: 0.5, w: 80, h: 160 }, 0.9, 0.9)
    put(out, 32, 9, 7, { dx: 0.5, dy: 0.5, w: 120, h: 240 }, 0.9, 0.9)
    assert.equal(decodePersons(out, { srcW: 416, srcH: 416 }).length, 3)
  })

  it('counts a crowd of separate people, one box each', () => {
    const out = emptyOutput()
    for (let i = 0; i < 5; i++) put(out, 16, 3 + i * 4, 10, { dx: 0.5, dy: 0.5, w: 50, h: 110 }, 0.9, 0.9)
    assert.equal(decodePersons(out, { srcW: 416, srcH: 416 }).length, 5)
  })

  it('merges duplicate boxes on the same person', () => {
    const out = emptyOutput()
    put(out, 16, 10, 10, { dx: 0.5, dy: 0.5, w: 60, h: 130 }, 0.95, 0.9)
    put(out, 16, 11, 10, { dx: 0.4, dy: 0.5, w: 62, h: 128 }, 0.8, 0.8)
    assert.equal(decodePersons(out, { srcW: 416, srcH: 416 }).length, 1)
  })

  it('ignores weak and tiny detections', () => {
    const out = emptyOutput()
    put(out, 16, 10, 10, { dx: 0.5, dy: 0.5, w: 60, h: 130 }, 0.5, 0.5) // 0.25 < 0.4
    put(out, 8, 30, 30, { dx: 0.5, dy: 0.5, w: 6, h: 8 }, 0.95, 0.95) // smaller than 12 px
    assert.equal(decodePersons(out, { srcW: 416, srcH: 416 }).length, 0)
  })

  it('keeps boxes inside the picture', () => {
    const out = emptyOutput()
    put(out, 16, 0, 0, { dx: 0, dy: 0, w: 100, h: 100 }, 0.9, 0.9) // centred on the corner
    const [d] = decodePersons(out, { srcW: 416, srcH: 416 })
    assert.ok(d)
    assert.equal(d.x1, 0)
    assert.equal(d.y1, 0)
  })

  it('refuses an output of the wrong size', () => {
    assert.throws(() => decodePersons(new Float32Array(100), { srcW: 640, srcH: 480 }), /unexpected model output size/)
  })
})
