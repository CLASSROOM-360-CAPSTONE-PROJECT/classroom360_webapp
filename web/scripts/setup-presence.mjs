// Downloads the person-detection model used by the camera page (YOLOX-Tiny, Apache-2.0, from the
// YOLOX project's releases) into public/models/. The file is checked against a known SHA-256, so a
// damaged or swapped download is refused.
//
//   npm run setup:presence            download it (does nothing if it is already there and correct)
//   node scripts/setup-presence.mjs --soft   same, but never fails the command it is part of
//
// "predev" and "prebuild" run it with --soft, so a missing internet connection only prints a note.
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const MODEL = {
  file: 'yolox_tiny.onnx',
  url: 'https://github.com/Megvii-BaseDetection/YOLOX/releases/download/0.1.1rc0/yolox_tiny.onnx',
  sha256: '427cc366d34e27ff7a03e2899b5e3671425c262ea2291f88bb942bc1cc70b0f7',
  bytes: 20219662,
}

const soft = process.argv.includes('--soft')
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dir = join(root, 'public', 'models')
const target = join(dir, MODEL.file)

const sha = (buf) => createHash('sha256').update(buf).digest('hex')

async function main() {
  if (process.env.SKIP_PRESENCE_SETUP) return
  if (existsSync(target)) {
    if (sha(await readFile(target)) === MODEL.sha256) {
      console.log(`[presence] ${MODEL.file} is already installed.`)
      return
    }
    console.log(`[presence] ${MODEL.file} is damaged or different from the expected file. Downloading it again.`)
  }
  console.log(`[presence] Downloading ${MODEL.file} (${(MODEL.bytes / 1e6).toFixed(0)} MB)...`)
  const res = await fetch(MODEL.url, { redirect: 'follow', signal: AbortSignal.timeout(180_000) })
  if (!res.ok) throw new Error(`the download answered ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (sha(buf) !== MODEL.sha256) throw new Error('the downloaded file did not match its checksum, so it was not installed')
  await mkdir(dir, { recursive: true })
  const tmp = `${target}.part`
  await writeFile(tmp, buf)
  await rm(target, { force: true })
  await rename(tmp, target)
  console.log(`[presence] Installed ${target}`)
}

main().catch((err) => {
  const msg = `[presence] The person-detection model was not installed: ${err instanceof Error ? err.message : err}.`
  if (soft) {
    console.warn(`${msg}\n[presence] The app still works; only the camera people count is off. Try "npm run setup:presence" when you are online.`)
  } else {
    console.error(msg)
    process.exitCode = 1
  }
})
