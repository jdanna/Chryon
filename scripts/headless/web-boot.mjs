#!/usr/bin/env node
// Boots dist-web in headless Chrome and checks what a visitor depends on: the machine keeps real time, a key
// reaches the firmware, a picture reaches the video input, the disk it writes lands in the browser, and a second
// visit runs from that copy without downloading the image again. Build first with `npm run build:web`. CHROME_PATH picks the browser.

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { serve } from './web-server.mjs'

const PORT = 8138
const DEBUG_PORT = 9334
const BROWSERS = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']
const BOOT_MS = 24000
const COMPOSE_MS = 30000
const SAVE_POLLS = 40 // half-second tries, because saves come 15 seconds apart and the write takes a moment
const MIN_SPEED = 90
const KEY_HOLD_MS = 130
const PICTURE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs', 'emulator.png')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const browser = process.env.CHROME_PATH ?? BROWSERS.find(existsSync)
if (!browser) throw new Error('No Chrome found. Set CHROME_PATH.')

const requests = []
const server = await serve(PORT, (path) => requests.push(path))
const profile = mkdtempSync(join(tmpdir(), 'maxine-web-'))
// These flags keep the page visible. Without them a synthetic key can mark it hidden, and that stops its frames.
const chrome = spawn(
  browser,
  [
    '--headless=new', `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profile}`, '--no-first-run',
    '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--window-size=1600,1000',
    '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling', 'about:blank'
  ],
  { stdio: 'ignore' }
)

let failed = false
function check(ok, what) {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${what}`)
  if (!ok) failed = true
}

try {
  let targets = []
  for (let i = 0; i < 100 && targets.length === 0; i++) {
    await sleep(100)
    targets = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`).then((r) => r.json(), () => [])
  }
  const socket = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl)
  await new Promise((resolve) => (socket.onopen = resolve))

  let nextId = 0
  const pending = new Map()
  const consoleLines = []
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data)
    if (message.method === 'Runtime.consoleAPICalled') consoleLines.push(message.params.args.map((a) => a.value).join(' '))
    pending.get(message.id)?.(message)
    pending.delete(message.id)
  }
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      pending.set(++nextId, resolve)
      socket.send(JSON.stringify({ id: nextId, method, params }))
    })
  const evaluate = async (expression) =>
    (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.result?.value
  const press = async (key, code, vk) => {
    const event = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...event })
    await sleep(KEY_HOLD_MS)
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...event })
    await sleep(KEY_HOLD_MS)
  }
  const button = (name) => `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '${name}')`
  const start = async (startLabel) => {
    await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
    await sleep(1500)
    await evaluate(`${button(startLabel)}.click()`)
    for (let i = 0; i < 200 && (await evaluate(`!!document.querySelector('nav')`)); i++) await sleep(250)
  }
  const speed = async () => {
    const fields = () => evaluate('Module._maxine_fields()')
    const before = await fields()
    await sleep(4000)
    return Math.round((((await fields()) - before) / (4 * (60000 / 1001))) * 100)
  }
  const stored = (key) =>
    evaluate(`new Promise((resolve) => {
      const open = indexedDB.open('maxine-studio-emulator', 1)
      open.onsuccess = () => {
        const get = open.result.transaction('files').objectStore('files').get('${key}')
        get.onsuccess = () => { open.result.close(); resolve(get.result?.length ?? 0) }
      }
    })`)

  await send('Page.enable')
  await send('Runtime.enable')
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })

  await start('Start emulator')
  check(requests.includes('/emulator/disk.chd.gz'), 'the first visit downloads the disk')
  await sleep(BOOT_MS)
  const booted = await speed()
  check(booted >= MIN_SPEED, `the machine runs at ${booted}% of real time`)

  await evaluate(`document.getElementById('canvas').focus()`)
  await press('Enter', 'Enter', 13)
  await sleep(COMPOSE_MS)
  await press('a', 'KeyA', 65)

  const input = await send('Runtime.evaluate', { expression: `document.querySelector('input[type=file]')` })
  await send('DOM.enable')
  await send('DOM.setFileInputFiles', { files: [PICTURE], objectId: input.result.result.objectId })
  for (let i = 0; i < 20 && !consoleLines.some((line) => line.includes('Video input:')); i++) await sleep(250)
  const loaded = consoleLines.find((line) => line.includes('Video input:')) ?? 'nothing'
  check(/\d+x\d+ picture/.test(loaded), `Video in hands the driver a picture: ${loaded.replace(/^\[:\] /, '')}`)

  await press('-', 'NumpadSubtract', 109) // RCD records the page, which is what writes to the disk
  let saved = 0
  for (let i = 0; i < SAVE_POLLS && !saved; i++) {
    await sleep(500)
    saved = await stored('disk')
  }
  check(saved > 0, `the page saved the disk (${saved} bytes) and NVRAM (${await stored('nvram')} bytes)`)

  requests.length = 0
  await evaluate(`${button('Stop')}.click()`)
  await sleep(4000)
  check((await evaluate(`!!${button('Continue')}`)) === true, 'Stop returns to the startup page, offering Continue')

  requests.length = 0
  await start('Continue')
  check(requests.includes('/emulator/maxine.js') && !requests.includes('/emulator/disk.chd.gz'), 'a second visit runs from the saved disk')
  await sleep(BOOT_MS)
  const again = await speed()
  check(again >= MIN_SPEED, `it runs at ${again}% of real time`)
} finally {
  chrome.kill()
  server.close()
  await sleep(500)
  rmSync(profile, { recursive: true, force: true })
}
process.exit(failed ? 1 : 0)
