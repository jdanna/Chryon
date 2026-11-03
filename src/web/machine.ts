import { NVRAM_SIZE } from '@shared/nvram'
import { FILES, readFile, removeFile, writeFile } from './store'

interface EmscriptenFs {
  mkdirTree(path: string): void
  writeFile(path: string, data: Uint8Array | string, options?: { canOwn: boolean }): void
  readFile(path: string): Uint8Array
  stat(path: string): { mtime: Date | number }
  unlink(path: string): void
}

interface EmscriptenModule {
  canvas: HTMLCanvasElement
  arguments: string[]
  preRun: (() => void)[]
  print(text: string): void
  printErr(text: string): void
  onAbort(reason: unknown): void
  locateFile(path: string): string
  FS: EmscriptenFs
  ENV: Record<string, string>
  cwrap(name: string, result: string | null, args: string[]): (...args: unknown[]) => unknown
}

interface Manifest {
  /** Changes with the disk image, so a copy saved from an older one is dropped. */
  image: string
  disk: string
  wasm: string
  files: string[]
}

declare global {
  interface Window {
    Module?: Partial<EmscriptenModule>
    JSMESS?: { running?: boolean }
  }
}

const ASSETS = `${import.meta.env.BASE_URL}emulator/`
const ROOT = '/emu'
const DISK = `${ROOT}/disk.chd`
const NVRAM = `${ROOT}/nvram/maxine/nvram`
const SNAP = `${ROOT}/snap/maxine`
const SAVE_INTERVAL_MS = 15000
const SPEED_INTERVAL_MS = 2000
const FIELDS_PER_SECOND = 60000 / 1001
const GZIP_MAGIC = 0x1f8b
const SAVE_NVRAM = '_ZN15running_machine21emscripten_nvram_saveEv'
const CANVAS_WIDTH = 1696 // 1.5 times the layout's view
const CANVAS_HEIGHT = 948
// What the driver prints after an export button saves a pair, as in src/main/emulator.ts
const EXPORT_LINE = /MAXINE_EXPORT (\d+(-640x480)?\.png)\s*$/
const EXPORT_KINDS = ['video', 'key']

const hooks = {
  status: (_text: string): void => {},
  state: (_running: boolean): void => {},
  speed: (_percent: number): void => {}
}

/** Messages for the page. The firmware's own output only goes to the browser's console. */
export function onStatus(listener: (text: string) => void): void {
  hooks.status = listener
}

export function onState(listener: (running: boolean) => void): void {
  hooks.state = listener
}

/** How fast the machine is running against its real speed. */
export function onSpeed(listener: (percent: number) => void): void {
  hooks.speed = listener
}

async function fetchChecked(url: string): Promise<Response> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Couldn't download ${url}: ${response.status} ${response.statusText}`)
  return response
}

/** The disk and the emulator are sent gzipped, and some servers unpack that on the way, so this looks at what arrived. */
async function download(url: string, progress: (percent: number) => void = () => {}): Promise<Uint8Array> {
  const response = await fetchChecked(url)
  const total = Number(response.headers.get('content-length') ?? 0)
  const reader = response.body!.getReader()
  const chunks: Uint8Array[] = []
  let received = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    received += value.length
    if (total) progress(Math.min(100, Math.round((received / total) * 100)))
  }
  const whole = new Uint8Array(await new Blob(chunks as BlobPart[]).arrayBuffer())
  if (((whole[0] << 8) | whole[1]) !== GZIP_MAGIC) return whole
  const unpacked = new Blob([whole]).stream().pipeThrough(new DecompressionStream('gzip'))
  return new Uint8Array(await new Response(unpacked).arrayBuffer())
}

function save(name: string, data: Blob | Uint8Array): void {
  const link = document.createElement('a')
  link.href = URL.createObjectURL(data instanceof Blob ? data : new Blob([data as BlobPart], { type: 'image/png' }))
  link.download = name
  link.click()
  setTimeout(() => URL.revokeObjectURL(link.href), 60000)
}

/** The running machine. Emscripten's runtime can't be started twice, so one lasts until the page reloads. */
class Machine {
  private module: EmscriptenModule | null = null
  private savedNvram: Uint8Array | null = null
  private savedDiskTime = 0
  private saving: Promise<void> = Promise.resolve()

  get running(): boolean {
    return this.module !== null
  }

  async start(canvas: HTMLCanvasElement): Promise<void> {
    hooks.status('Downloading the emulator…')
    const manifest = (await (await fetchChecked(`${ASSETS}manifest.json`)).json()) as Manifest

    // The machine writes to its disk, so a browser that has saved one carries on from that copy
    const savedImage = await readFile<string>(FILES.image)
    let disk = savedImage === manifest.image ? await readFile(FILES.disk) : undefined
    if (savedImage && savedImage !== manifest.image) {
      hooks.status('The disk image has changed, so your saved copy of the old one was dropped.')
      await removeFile(FILES.disk)
    }
    if (!disk) {
      let lastPercent = -1
      disk = await download(`${ASSETS}${manifest.disk}`, (percent) => {
        if (percent >= lastPercent + 10) hooks.status(`Downloading the disk image: ${(lastPercent = percent)}%`)
      })
    }
    const startingDisk = disk
    const wasm = URL.createObjectURL(new Blob([(await download(`${ASSETS}${manifest.wasm}`)) as BlobPart], { type: 'application/wasm' }))
    const assets = await Promise.all(
      manifest.files.map(async (path) => ({ path, data: new Uint8Array(await (await fetchChecked(`${ASSETS}${path}`)).arrayBuffer()) }))
    )

    const nvram = await readFile(FILES.nvram)
    await writeFile(FILES.image, manifest.image)
    this.savedNvram = nvram ?? null

    await new Promise<void>((resolve, reject) => {
      const script = document.createElement('script')
      const module: Partial<EmscriptenModule> = {
        canvas,
        arguments: [
          'maxine',
          '-rompath', `${ROOT}/roms`,
          '-hard', DISK,
          '-nvram_directory', `${ROOT}/nvram`,
          '-cfg_directory', `${ROOT}/cfg`,
          '-snapshot_directory', `${ROOT}/snap`,
          '-artpath', `${ROOT}/artwork`,
          '-plugin', 'layout',
          '-pluginspath', `${ROOT}/plugins`,
          '-homepath', ROOT,
          '-window', '-skip_gameinfo', '-nomouse', '-sound', 'none',
          // This page's clock paces the machine, and MAME's own throttle would spin on the only thread
          '-nothrottle',
          '-video', 'accel',
          '-resolution', `${CANVAS_WIDTH}x${CANVAS_HEIGHT}`
        ],
        print: (line) => this.receive(line),
        printErr: (line) => this.receive(line),
        onAbort: (reason) => {
          hooks.status(`The emulator stopped: ${String(reason)}`)
          reject(new Error(`The emulator stopped: ${String(reason)}`))
        },
        locateFile: (path) => (path.endsWith('.wasm') ? wasm : `${ASSETS}${path}`),
        preRun: [
          () => {
            const { FS, ENV } = window.Module as EmscriptenModule
            for (const path of [`${ROOT}/roms`, `${ROOT}/nvram/maxine`, `${ROOT}/cfg`, SNAP]) FS.mkdirTree(path)
            for (const { path, data } of assets) {
              FS.mkdirTree(`${ROOT}/${path.slice(0, path.lastIndexOf('/'))}`)
              FS.writeFile(`${ROOT}/${path}`, data, { canOwn: true })
            }
            FS.writeFile(DISK, startingDisk, { canOwn: true })
            if (nvram) FS.writeFile(NVRAM, nvram)
            ENV['MAXINE_LOG_STDOUT'] = '1'
            ENV['SDL_EMSCRIPTEN_KEYBOARD_ELEMENT'] = '#canvas'
          }
        ]
      }
      window.Module = module
      script.src = `${ASSETS}maxine.js`
      script.onerror = () => reject(new Error('Could not load the emulator.'))
      document.body.append(script)

      const waitForMachine = (): void => {
        if (!window.JSMESS?.running) {
          setTimeout(waitForMachine, 100)
          return
        }
        this.module = window.Module as EmscriptenModule
        this.savedDiskTime = Number(this.module.FS.stat(DISK).mtime)
        resolve()
      }
      waitForMachine()
    })

    setInterval(() => this.queueSave(), SAVE_INTERVAL_MS)
    this.watchSpeed()
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.queueSave()
    })
    addEventListener('pagehide', () => this.queueSave())
    hooks.state(true)
  }

  private watchSpeed(): void {
    const fields = this.module!.cwrap('maxine_fields', 'number', []) as () => number
    let lastFields = fields()
    let lastTime = performance.now()
    setInterval(() => {
      const nowFields = fields()
      const now = performance.now()
      // A hidden tab stops the browser's frames, and with them the machine
      if (document.visibilityState === 'visible') hooks.speed(Math.round((((nowFields - lastFields) / FIELDS_PER_SECOND) * 100000) / (now - lastTime)))
      lastFields = nowFields
      lastTime = now
    }, SPEED_INTERVAL_MS)
  }

  private receive(line: string): void {
    const exported = EXPORT_LINE.exec(line)
    if (!exported) {
      if (line.trim()) console.log(line.trimEnd())
      return
    }
    const fs = this.module?.FS
    if (!fs) return
    const [, name] = exported
    for (const kind of EXPORT_KINDS) {
      const path = `${SNAP}/${kind}-${name}`
      save(`${kind}-${name}`, fs.readFile(path))
      fs.unlink(path)
    }
    hooks.status(`Saved video-${name} and key-${name} to your downloads`)
  }

  private queueSave(): Promise<void> {
    this.saving = this.saving.then(() => this.saveChanges()).catch((err: Error) => hooks.status(`Couldn't save your changes: ${err.message}`))
    return this.saving
  }

  /** MAME only writes NVRAM on exit, and the disk only exists in memory, so both are copied out here. */
  private async saveChanges(): Promise<void> {
    const module = this.module
    if (!module) return
    module.cwrap(SAVE_NVRAM, null, [])()
    const nvram = module.FS.readFile(NVRAM)
    if (nvram.length === NVRAM_SIZE && !(this.savedNvram && nvram.every((byte, i) => byte === this.savedNvram![i]))) {
      await writeFile(FILES.nvram, nvram)
      this.savedNvram = nvram
    }
    const changed = Number(module.FS.stat(DISK).mtime)
    if (changed !== this.savedDiskTime) {
      await writeFile(FILES.disk, module.FS.readFile(DISK))
      this.savedDiskTime = changed
    }
  }

  async stop(): Promise<void> {
    await this.queueSave()
    location.reload()
  }

  /** Goes back to the disk as it was downloaded. Dropping the module first stops a save on the way out. */
  async reset(): Promise<void> {
    this.module = null
    await this.saving
    await Promise.all([removeFile(FILES.disk), removeFile(FILES.nvram)])
    location.reload()
  }

  paste(text: string): void {
    this.module?.cwrap('maxine_paste', null, ['string'])(text)
  }
}

export const machine = new Machine()
