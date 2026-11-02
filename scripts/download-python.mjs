#!/usr/bin/env node
/**
 * Downloads a python-build-standalone CPython interpreter for the current
 * build target (platform + arch) into resources/python/{platform}-{arch}/.
 *
 * Usage:
 *   node scripts/download-python.mjs [arch]              # host platform, explicit arch
 *   node scripts/download-python.mjs [platform] [arch]   # explicit platform + arch
 *
 * Platform: darwin | win32 | linux  (defaults to process.platform)
 * Arch:     x64 | arm64             (defaults to host arch)
 *
 * Exit codes:
 *   0  — success (or already cached)
 *   1  — error (network failure, bad hash, extraction failure, etc.)
 */

import { createWriteStream, existsSync, mkdirSync, statSync, writeFileSync, readFileSync, createReadStream } from 'fs'
import { rm } from 'fs/promises'
import { createHash } from 'crypto'
import { pipeline } from 'stream/promises'
import { exec } from 'child_process'
import { promisify } from 'util'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { get as httpsGet } from 'https'
import { PYTHON_VERSION } from './python-version.mjs'

const execAsync = promisify(exec)
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// ── Configuration ─────────────────────────────────────────────────────────────

const RELEASE_TAG = '20260414'
const BASE_URL = `https://github.com/astral-sh/python-build-standalone/releases/download/${RELEASE_TAG}`

const ARCH_TRIPLES = {
  darwin: { arm64: 'aarch64-apple-darwin' },
  win32: { x64: 'x86_64-pc-windows-msvc' },
  linux: { x64: 'x86_64-unknown-linux-gnu' },
}

// ── Resolve target ─────────────────────────────────────────────────────────────

const positionals = process.argv.slice(2)
let platform, arch
if (positionals.length >= 2) {
  // New form: node download-python.mjs <platform> <arch>
  platform = positionals[0]
  arch = positionals[1]
} else {
  // Legacy form: node download-python.mjs [arch]
  platform = process.platform
  arch = positionals[0] || (process.arch === 'arm64' ? 'arm64' : 'x64')
}

if (!ARCH_TRIPLES[platform]) {
  console.error(`[download-python] Unsupported platform: ${platform}`)
  process.exit(1)
}
if (!ARCH_TRIPLES[platform][arch]) {
  console.error(`[download-python] Unsupported arch "${arch}" on ${platform}. Supported: ${Object.keys(ARCH_TRIPLES[platform]).join(', ')}`)
  process.exit(1)
}

const triple = ARCH_TRIPLES[platform][arch]
const filename = `cpython-${PYTHON_VERSION}+${RELEASE_TAG}-${triple}-install_only.tar.gz`
const url = `${BASE_URL}/${filename}`
const sha256SumsUrl = `${BASE_URL}/SHA256SUMS`

const destDir = join(ROOT, 'resources', 'python', `${platform}-${arch}`)
const tarballPath = join(destDir, filename)
const markerPath = join(destDir, '.downloaded')
const pythonDir = join(destDir, 'python')

// ── Cache check ───────────────────────────────────────────────────────────────

if (existsSync(markerPath)) {
  const cached = readFileSync(markerPath, 'utf8').trim()
  if (cached === filename && existsSync(pythonDir)) {
    console.log(`[download-python] Already present: resources/python/${platform}-${arch}/python/`)
    process.exit(0)
  }
  console.log(`[download-python] Cached version differs or python dir missing — re-downloading`)
}

// ── Prepare ───────────────────────────────────────────────────────────────────

mkdirSync(destDir, { recursive: true })

if (existsSync(pythonDir)) {
  console.log(`[download-python] Removing stale python/ directory`)
  await rm(pythonDir, { recursive: true, force: true })
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// github.com itself intermittently answers 503 (throttling/brief degradation)
// before it ever issues the redirect to the release-asset host -- a single one
// of those used to fail the whole build, since every caller here exits 1 on the
// first error. Anything transient is retried with exponential backoff instead.
const MAX_ATTEMPTS = 4
const RETRY_BASE_DELAY_MS = 1000
const REQUEST_TIMEOUT_MS = 30000

// Socket-level failures worth another attempt. ERR_STREAM_PREMATURE_CLOSE
// covers a connection dropped mid-body (pipeline's own error for that).
const RETRYABLE_NET_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENETUNREACH',
  'ENETDOWN', 'EHOSTUNREACH', 'EPIPE', 'ERR_STREAM_PREMATURE_CLOSE',
])

function retryableError(message) {
  const err = new Error(message)
  err.retryable = true
  return err
}

function isRetryable(err) {
  if (!err) return false
  if (err.retryable === true) return true
  return RETRYABLE_NET_CODES.has(err.code)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Retries the WHOLE operation (connect + body), not just the connect -- a
// download that dies mid-stream restarts from zero, which is safe because
// createWriteStream truncates the partial file on the next attempt.
async function withRetry(label, fn) {
  let lastErr
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (!isRetryable(err) || attempt === MAX_ATTEMPTS) break
      const delay = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1)
      console.warn(
        `\n[download-python] ${label} failed: ${err.message}` +
        ` — retrying in ${delay / 1000}s (attempt ${attempt + 1}/${MAX_ATTEMPTS})`
      )
      await sleep(delay)
    }
  }
  throw lastErr
}

function httpsGetFollow(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    // The `timeout` option only arms the socket timer; without this listener
    // Node emits 'timeout' and then does nothing, so a stalled connection
    // hangs forever instead of failing (and being retried).
    const req = httpsGet(url, { timeout: REQUEST_TIMEOUT_MS }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        if (redirects >= 5) return reject(new Error(`Too many redirects for ${url}`))
        res.resume()
        httpsGetFollow(res.headers.location, redirects + 1).then(resolve, reject)
        return
      }
      if (res.statusCode !== 200) {
        res.resume()
        const err = new Error(`HTTP ${res.statusCode} for ${url}`)
        // 5xx = server-side blip, 429 = rate limited, 408 = request timeout.
        // A 404/403 is a real config error and must fail immediately.
        err.retryable = res.statusCode >= 500 || res.statusCode === 429 || res.statusCode === 408
        return reject(err)
      }
      resolve(res)
    })
    req.on('timeout', () => {
      req.destroy(retryableError(`Timed out after ${REQUEST_TIMEOUT_MS / 1000}s for ${url}`))
    })
    req.on('error', reject)
  })
}

async function fetchText(url) {
  const res = await httpsGetFollow(url)
  return new Promise((resolve, reject) => {
    let data = ''
    res.setEncoding('utf8')
    res.on('data', (chunk) => { data += chunk })
    res.on('end', () => resolve(data.trim()))
    res.on('error', reject)
  })
}

async function downloadFile(url, destPath) {
  const res = await httpsGetFollow(url)
  const total = parseInt(res.headers['content-length'] || '0', 10)
  let received = 0
  let lastPct = -1

  const out = createWriteStream(destPath)
  res.on('data', (chunk) => {
    received += chunk.length
    if (total > 0) {
      const pct = Math.floor((received / total) * 100)
      if (pct !== lastPct && pct % 10 === 0) {
        process.stdout.write(`\r  ${pct}%`)
        lastPct = pct
      }
    }
  })
  await pipeline(res, out)
  if (total > 0) process.stdout.write('\r  100%\n')
}

async function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(filePath)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

// ── Download ──────────────────────────────────────────────────────────────────

console.log(`[download-python] Target: ${platform}-${arch} (${triple})`)
console.log(`[download-python] Downloading ${filename}`)

try {
  await withRetry('Download', () => downloadFile(url, tarballPath))
} catch (err) {
  console.error(`\n[download-python] DOWNLOAD FAILED: ${err.message}`)
  process.exit(1)
}

const sizeMB = (statSync(tarballPath).size / 1024 / 1024).toFixed(1)
console.log(`[download-python] Downloaded ${sizeMB} MB`)

// ── SHA-256 verify ────────────────────────────────────────────────────────────

console.log(`[download-python] Fetching checksum...`)
let expectedHash
try {
  const sums = await withRetry('Checksum fetch', () => fetchText(sha256SumsUrl))
  const line = sums.split('\n').find((l) => l.endsWith(filename))
  if (!line) throw new Error(`${filename} not found in SHA256SUMS`)
  expectedHash = line.split(/\s+/)[0].toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(expectedHash)) {
    throw new Error(`Unexpected hash format: ${expectedHash}`)
  }
} catch (err) {
  console.error(`[download-python] CHECKSUM FETCH FAILED: ${err.message}`)
  await rm(tarballPath, { force: true })
  process.exit(1)
}

const actualHash = await sha256File(tarballPath)
if (actualHash !== expectedHash) {
  console.error(`[download-python] SHA-256 MISMATCH`)
  console.error(`  expected: ${expectedHash}`)
  console.error(`  actual:   ${actualHash}`)
  await rm(tarballPath, { force: true })
  process.exit(1)
}
console.log(`[download-python] Checksum OK`)

// ── Extract ───────────────────────────────────────────────────────────────────

console.log(`[download-python] Extracting...`)
try {
  const { stderr } = await execAsync(`tar -xzf "${tarballPath}" -C "${destDir}"`)
  if (stderr) {
    const lines = stderr.trim().split('\n').filter((l) => !l.includes('Ignoring unknown extended header'))
    if (lines.length > 0) console.warn(`[download-python] tar warnings: ${lines.join(' | ')}`)
  }
} catch (err) {
  console.error(`[download-python] EXTRACTION FAILED: ${err.message}`)
  process.exit(1)
}

if (!existsSync(pythonDir)) {
  console.error(`[download-python] EXTRACTION FAILED: expected ${pythonDir} to exist`)
  process.exit(1)
}

// ── Cleanup + marker ──────────────────────────────────────────────────────────

await rm(tarballPath, { force: true })
writeFileSync(markerPath, filename)
console.log(`[download-python] Done. Python at: resources/python/${platform}-${arch}/python/`)
