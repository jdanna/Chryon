#!/usr/bin/env node
// Runs the built app with no window and drives it over the Chrome DevTools
// Protocol. See "Electron app" in CLAUDE.md.
//
//   node scripts/headless/driver.mjs <steps.json> [--out <dir>] [--show] [--keep-profile]
//
// Or from a script: import { launch } from './driver.mjs'

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '../..')

const LAUNCH_TIMEOUT_MS = 30000
const CDP_TIMEOUT_MS = 15000
const CLICK_SETTLE_MS = 300
const DROP_SETTLE_MS = 1000
const EXIT_TIMEOUT_MS = 5000

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Polls until `get` returns something truthy, so no wait here is unbounded. */
async function poll(get, what, failed) {
  const deadline = Date.now() + LAUNCH_TIMEOUT_MS
  while (Date.now() < deadline) {
    const crash = failed()
    if (crash) throw new Error(crash)
    const value = await get()
    if (value) return value
    await sleep(100)
  }
  throw new Error(`Timed out waiting for ${what}`)
}

/**
 * Launches the app and resolves to a small driving API. Every run gets a fresh
 * profile in the temp folder, so persisted stores start at their defaults and
 * the real userData and temp folder are never touched.
 */
export async function launch({ show = false, keepProfile = false, binary = null } = {}) {
  const mainEntry = join(ROOT, 'out/main/index.js')
  if (!binary && !existsSync(mainEntry)) throw new Error('No build in out/ — run `npm run build` first.')

  const profile = mkdtempSync(join(tmpdir(), 'maxine-headless-'))

  // The VS Code extension host sets this, and Electron then runs as plain Node
  const env = { ...process.env, HEADLESS_TEMP_DIR: profile, TMPDIR: profile }
  delete env.ELECTRON_RUN_AS_NODE

  // Under plain Node the `electron` package exports the path of the real binary.
  // Spawning that, not .bin/electron (a Node wrapper), means kill() reaches the app.
  const electron = createRequire(import.meta.url)('electron')
  const args = [
    ...(show ? [] : ['-r', join(HERE, 'hide-window.cjs')]),
    '.',
    `--user-data-dir=${profile}`,
    '--remote-debugging-port=0'
  ]
  // A packaged app ignores -r, so `binary` runs with a visible window
  const app = binary
    ? spawn(binary, [`--user-data-dir=${profile}`, '--remote-debugging-port=0'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    : spawn(electron, args, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })

  let stderr = ''
  let exited = false
  let windowVisible = null
  app.stderr.on('data', (d) => (stderr = (stderr + d).slice(-2000)))
  app.stdout.on('data', (d) => {
    const m = /\[headless\] window visible: (true|false)/.exec(String(d))
    if (m) windowVisible = m[1] === 'true'
  })
  const gone = new Promise((res) => app.once('exit', res))
  app.on('exit', () => (exited = true))

  const removeProfile = () => {
    if (!keepProfile) rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
  // Whatever ends this process (a thrown step, ^C, a closed stdout pipe), the app
  // goes too. This path can't wait for it, so normal runs use close() instead.
  process.once('exit', () => {
    app.kill()
    removeProfile()
  })
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(signal, () => process.exit(1))

  const crashed = () => (exited ? `Electron exited during launch:\n${stderr}` : null)
  const port = await poll(
    () => {
      const file = join(profile, 'DevToolsActivePort')
      return existsSync(file) ? readFileSync(file, 'utf8').split('\n')[0].trim() : null
    },
    'the DevTools port',
    crashed
  )
  const target = await poll(
    async () => {
      const res = await fetch(`http://127.0.0.1:${port}/json`).catch(() => null)
      const list = res?.ok ? await res.json() : []
      return list.find((t) => t.type === 'page')
    },
    'the app page',
    crashed
  )

  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.onopen = res
    ws.onerror = () => rej(new Error('Could not connect to the app over CDP'))
  })

  let nextId = 0
  const pending = new Map()
  ws.onmessage = (m) => {
    const reply = JSON.parse(m.data)
    pending.get(reply.id)?.(reply)
    pending.delete(reply.id)
  }

  const cdp = (method, params = {}) =>
    new Promise((res, rej) => {
      const id = ++nextId
      const timer = setTimeout(() => rej(new Error(`CDP timeout: ${method}`)), CDP_TIMEOUT_MS)
      pending.set(id, (reply) => {
        clearTimeout(timer)
        if (reply.error) rej(new Error(`${method}: ${reply.error.message}`))
        else res(reply.result)
      })
      ws.send(JSON.stringify({ id, method, params }))
    })

  /** Evaluates in the page; a throwing expression rejects rather than returning undefined. */
  const evaluate = async (expression) => {
    const { result, exceptionDetails } = await cdp('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    })
    if (exceptionDetails) {
      throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text)
    }
    return result.value
  }

  // Parsing starts as soon as the page script runs, so wait for React to mount
  await poll(() => evaluate(`!!document.querySelector('header')`), 'the app to render', crashed)
  if (!show && !binary && windowVisible !== false) {
    await poll(() => windowVisible !== null, 'the window state', crashed)
    if (windowVisible) throw new Error('The window became visible — hide-window.cjs did not take effect.')
  }

  return {
    profile,
    cdp,
    evaluate,

    /** A real file drop at the middle of the window, so webUtils.getPathForFile
     *  sees an actual path. Stands in for the native open dialog. */
    async drop(path) {
      await cdp('Input.setInterceptDrags', { enabled: false })
      const data = { items: [], files: [resolve(ROOT, path)], dragOperationsMask: 1 }
      const at = { x: 600, y: 400, data }
      await cdp('Input.dispatchDragEvent', { type: 'dragEnter', ...at })
      await cdp('Input.dispatchDragEvent', { type: 'dragOver', ...at })
      await cdp('Input.dispatchDragEvent', { type: 'drop', ...at })
      await sleep(DROP_SETTLE_MS)
    },

    /** Clicks the button or label with this text (a label clicks its input). */
    async click(text) {
      const found = await evaluate(`(() => {
        const text = ${JSON.stringify(text)}
        const all = [...document.querySelectorAll('button, label')]
        const el = all.find((e) => e.textContent.trim() === text) ?? all.find((e) => e.textContent.includes(text))
        if (!el) return false
        ;(el.querySelector('input') ?? el).click()
        return true
      })()`)
      if (!found) throw new Error(`Nothing to click with the text "${text}"`)
      await sleep(CLICK_SETTLE_MS)
    },

    /** Types into the <input> inside the label with this text, through the native
     *  setter, since React ignores a plain `.value =`. */
    async fill(label, value) {
      const found = await evaluate(`(() => {
        const label = [...document.querySelectorAll('label')].find((e) => e.textContent.includes(${JSON.stringify(label)}))
        const input = label?.querySelector('input')
        if (!input) return false
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(String(value))})
        input.dispatchEvent(new Event('input', { bubbles: true }))
        return true
      })()`)
      if (!found) throw new Error(`No <input> in a label with the text "${label}"`)
      await sleep(CLICK_SETTLE_MS)
    },

    /** Picks an option in the <select> inside the label with this text. Goes through
     *  the native setter, since React ignores a plain `.value =`. */
    async select(label, value) {
      const found = await evaluate(`(() => {
        const label = [...document.querySelectorAll('label')].find((e) => e.textContent.includes(${JSON.stringify(label)}))
        const select = label?.querySelector('select')
        if (!select) return false
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, ${JSON.stringify(value)})
        select.dispatchEvent(new Event('change', { bubbles: true }))
        return true
      })()`)
      if (!found) throw new Error(`No <select> in a label with the text "${label}"`)
      await sleep(CLICK_SETTLE_MS)
    },

    async screenshot(path) {
      const { data } = await cdp('Page.captureScreenshot', { format: 'png' })
      writeFileSync(path, Buffer.from(data, 'base64'))
    },

    /** Waits for the app to go: it keeps writing to the profile as it shuts down,
     *  so deleting the folder any sooner can leave files behind. */
    async close() {
      ws.close()
      app.kill()
      await Promise.race([gone, sleep(EXIT_TIMEOUT_MS)])
      removeProfile()
    }
  }
}

/**
 * Runs a JSON step list. Within a step the actions run in this order, so one
 * step can load a file, navigate, then look at the result:
 *   drop   path of a font file to drop, absolute or relative to the repo root
 *   fill   [label text, value] for an <input> inside a label
 *   click  text of a button or label
 *   select [label text, option value] for a <select> inside a label
 *   wait   ms to pause
 *   eval   page expression; its value is printed
 *   expect value `eval` must equal, or the run fails
 *   shot   screenshot name, saved as <out>/<name>.png
 */
async function runSteps(stepsPath, { out, ...opts }) {
  const steps = JSON.parse(readFileSync(stepsPath, 'utf8'))
  mkdirSync(out, { recursive: true })
  const app = await launch(opts)
  let failures = 0
  try {
    for (const step of steps) {
      if (step.drop) await app.drop(step.drop)
      if (step.fill) await app.fill(...step.fill)
      if (step.click) await app.click(step.click)
      if (step.select) await app.select(...step.select)
      if (step.wait) await sleep(step.wait)
      if (step.eval) {
        const value = await app.evaluate(step.eval)
        if ('expect' in step && JSON.stringify(value) !== JSON.stringify(step.expect)) {
          failures++
          console.log(`FAIL ${step.eval}\n  expected ${JSON.stringify(step.expect)}\n  got      ${JSON.stringify(value)}`)
        } else {
          console.log(`${'expect' in step ? 'ok' : '=>'} ${JSON.stringify(value)}`)
        }
      }
      if (step.shot) {
        await app.screenshot(join(out, `${step.shot}.png`))
        console.log(`shot ${join(out, `${step.shot}.png`)}`)
      }
    }
  } finally {
    await app.close()
  }
  return failures
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2)
  const flag = (name) => {
    const i = argv.indexOf(name)
    return i === -1 ? false : argv.splice(i, 1).length > 0
  }
  const show = flag('--show')
  const keepProfile = flag('--keep-profile')
  const outAt = argv.indexOf('--out')
  const out = outAt === -1 ? mkdtempSync(join(tmpdir(), 'maxine-shots-')) : argv.splice(outAt, 2)[1]
  const stepsPath = argv[0] ?? join(HERE, 'smoke.json')

  // A reader closing stdout early mustn't look like success
  process.stdout.on('error', () => process.exit(1))

  runSteps(stepsPath, { out, show, keepProfile }).then(
    (failures) => process.exit(failures ? 1 : 0),
    (err) => {
      console.error(err.message)
      process.exit(1)
    }
  )
}
