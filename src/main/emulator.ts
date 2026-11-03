import { app, BrowserWindow, dialog, ipcMain, nativeImage, shell } from 'electron'
import { ChildProcess, execFile, spawn } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { chmod, copyFile, mkdir, open, readFile, rename, rm, stat, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { basename, isAbsolute, join } from 'path'
import { promisify } from 'util'
import type { DecklinkSource, DecklinkState, EmulatorConfig, EmulatorStatus, NvramFile } from '@shared/types'
import { NVRAM_SIZE } from '@shared/nvram'
import { Capture } from './capture'

const run = promisify(execFile)

const STOP_TIMEOUT_MS = 8000
const LOG_FLUSH_MS = 100
const LOG_BATCH_LINES = 500
const CHD_MAGIC = 'MComprHD'
const DEFAULT_IMAGE = 'maxine-default.chd'
const CANCELLED = new Set([126, 127, 1223]) // pkexec: dialog dismissed, or not authorised. Windows: UAC declined
const WINDOWS = process.platform === 'win32'
const BINARY = WINDOWS ? 'maxine.exe' : 'maxine'
const FFMPEG = WINDOWS ? 'ffmpeg.exe' : 'ffmpeg'
const WINDOWS_ADAPTER = 'MAXINE Emulator'
// What the driver prints after an export button saves a pair to its snapshot folder. Only these digits
// and this suffix, so a line from the emulated machine can't name a file elsewhere.
const EXPORT_LINE = /MAXINE_EXPORT (\d+(-640x480)?\.png)\s*$/
const EXPORT_KINDS = ['video', 'key']
// What the driver prints about the DeckLink, and which output SECOND SCREEN shows. logerror puts a tag
// in front, so these aren't anchored at the start.
const DECKLINK_LINE = /MAXINE_DECKLINK_(DEVICES|DEVICE|NODRIVER|ON|OFF|ERROR)(?: (.*))?$/
const SECOND_SCREEN_LINE = /MAXINE_SECOND_SCREEN (color-edit|video|key)\s*$/
const SOURCE_NAMES: Record<DecklinkSource, string> = { 'color-edit': 'Color Edit', video: 'Video', key: 'Key' }
const decklinkIdle = (): DecklinkState => ({ driver: null, devices: [], active: null, source: 'color-edit', error: null })
const DECKLINK_LIST_TIMEOUT_MS = 10000
const VIDEO_INPUT_FILE = 'video-input.png'
const PICTURE_EXTENSIONS = ['png', 'jpg', 'jpeg']
const TAP_DOWNLOAD = 'https://build.openvpn.net/downloads/releases/tap-windows-9.24.7-I601-Win10.exe'

interface Layout {
  binary: string
  ffmpeg: string
  plugins: string
  artwork: string
  roms: string
  scripts: string
  /** Private shared libraries, in a package. */
  lib: string | null
}

/** A package holds everything flat in resources/emulator. A checkout has the build in emulator/mame. */
function layout(): Layout {
  if (app.isPackaged) {
    const root = join(process.resourcesPath, 'emulator')
    return {
      binary: join(root, BINARY),
      ffmpeg: join(root, FFMPEG),
      plugins: join(root, 'plugins'),
      artwork: join(root, 'artwork'),
      roms: join(root, 'roms'),
      scripts: root,
      lib: join(root, 'lib')
    }
  }
  const root = join(app.getAppPath(), 'emulator')
  return {
    binary: join(root, 'mame', BINARY),
    ffmpeg: join(root, 'ffmpeg', FFMPEG),
    plugins: join(root, 'mame', 'plugins'),
    artwork: join(root, 'artwork'),
    roms: join(root, 'roms'),
    scripts: root,
    lib: null
  }
}

const imagePath = (cfg: EmulatorConfig): string => cfg.image || join(layout().roms, DEFAULT_IMAGE)
const folderPath = (cfg: EmulatorConfig): string => cfg.folder || join(app.getPath('userData'), 'emulator')
const captureFolderPath = (cfg: EmulatorConfig): string => cfg.captureFolder || join(folderPath(cfg), 'capture')
const diskPath = (cfg: EmulatorConfig): string => join(folderPath(cfg), 'disk.chd')
const nvramPath = (cfg: EmulatorConfig): string => join(folderPath(cfg), 'nvram', 'maxine', 'nvram')

function readPicture(path: string): Electron.NativeImage {
  const picture = nativeImage.createFromPath(path)
  if (picture.isEmpty()) throw new Error(`${basename(path)} isn't a picture this app can read. Use a PNG or JPEG.`)
  return picture
}

async function assertChd(path: string): Promise<void> {
  const file = await open(path, 'r')
  try {
    const { buffer } = await file.read(Buffer.alloc(CHD_MAGIC.length), 0, CHD_MAGIC.length, 0)
    if (buffer.toString('latin1') !== CHD_MAGIC) throw new Error(`${basename(path)} isn't a CHD disk image.`)
  } finally {
    await file.close()
  }
}

/** The script text goes to the shell, not its path: root can't read inside an AppImage's FUSE mount. */
async function elevate(script: string): Promise<void> {
  if (process.platform === 'darwin') {
    const encoded = Buffer.from(script).toString('base64')
    const command = `echo ${encoded} | /usr/bin/base64 -D | /bin/sh`
    await run('/usr/bin/osascript', ['-e', `do shell script "${command}" with administrator privileges`])
  } else {
    await run('pkexec', ['/bin/sh', '-c', script, 'maxine-net'])
  }
}

/**
 * UAC can't pass output back, so the script leaves its error in a file. The script runs from its real
 * path, because a Windows package has no FUSE mount to get in the way.
 */
async function elevateWindows(script: string): Promise<void> {
  const errorFile = join(tmpdir(), 'maxine-network-error.txt')
  await rm(errorFile, { force: true })
  const quoted = (text: string): string => `'"${text.replaceAll("'", "''")}"'`
  const args = ["'-NoProfile'", "'-ExecutionPolicy'", "'Bypass'", "'-File'", quoted(script), quoted(errorFile)].join(',')
  const command = `try { $p = Start-Process powershell.exe -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ErrorAction Stop -ArgumentList ${args}; exit $p.ExitCode } catch { exit 1223 }`
  try {
    await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true })
  } catch (err) {
    const message = await readFile(errorFile, 'utf8').catch(() => null)
    throw message ? Object.assign(new Error(message.trim()), { code: 1 }) : err
  }
}

function tapInstalled(): boolean {
  return existsSync(join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'TAP-Windows', 'bin', 'tapinstall.exe'))
}

async function networkUp(): Promise<boolean> {
  try {
    if (WINDOWS) {
      // A TAP adapter with no client is disconnected, so Node doesn't list it and it has no active address.
      // net-up.ps1 makes the adapter and net-down.ps1 removes it, so being listed here means the link is set up.
      const { stdout } = await run('netsh', ['interface', 'show', 'interface'], { windowsHide: true })
      return stdout.includes(WINDOWS_ADAPTER)
    }
    if (process.platform === 'linux') {
      const flags = readFileSync(`/sys/class/net/tap-mess-${process.getuid!()}-0/flags`, 'utf8')
      return (parseInt(flags, 16) & 1) !== 0 // IFF_UP
    }
    const { stdout } = await run('/sbin/ifconfig', ['feth1'])
    return stdout.includes('10.37.0.1')
  } catch {
    return false
  }
}

/**
 * MAME opens the adapter index saved in its cfg before the driver can choose, and on Windows that
 * index may now be a VPN's TAP adapter, which only one program can hold.
 */
async function forgetNetworkInterface(folder: string): Promise<void> {
  const path = join(folder, 'cfg', 'maxine.cfg')
  const cfg = await readFile(path, 'utf8').catch(() => null)
  if (cfg === null) return
  const cleaned = cfg.replace(/[ \t]*<network>[\s\S]*?<\/network>\s*/g, '')
  if (cleaned !== cfg) await writeFile(path, cleaned)
}

/** Owns the MAME process. Only one runs at a time, because it takes the only network interface. */
export class Emulator {
  private child: ChildProcess | null = null
  private exited: Promise<void> | null = null
  private pending: string[] = []
  private partial = ''
  private lastLine = ''
  private repeats = 0
  private flushTimer: NodeJS.Timeout | null = null
  private snapFolder = ''
  private exportFolder: string | undefined
  private exports: Promise<void> = Promise.resolve()
  private capture: Capture | null = null
  private decklink = decklinkIdle()
  private listing: string[] = []

  constructor(private win: BrowserWindow) {}

  get running(): boolean {
    return this.child !== null
  }

  private send(channel: string, value: unknown): void {
    if (!this.win.isDestroyed()) this.win.webContents.send(channel, value)
  }

  private flush(): void {
    this.flushTimer = null
    if (this.pending.length === 0) return
    let lines = this.pending
    if (lines.length > LOG_BATCH_LINES) {
      const dropped = lines.length - LOG_BATCH_LINES
      lines = [`… ${dropped} lines skipped`, ...lines.slice(-LOG_BATCH_LINES)]
    }
    this.pending = []
    this.send('emulator:log', lines)
  }

  private endRepeats(): void {
    if (this.repeats > 0) this.pending.push(`  repeated ${this.repeats} more time${this.repeats === 1 ? '' : 's'}`)
    this.repeats = 0
  }

  /** The firmware repeats some lines thousands of times, so a run of the same one becomes a count. */
  private addLine(line: string): void {
    if (line === this.lastLine) {
      this.repeats++
    } else {
      this.endRepeats()
      this.lastLine = line
      this.pending.push(line)
    }
    this.flushTimer ??= setTimeout(() => this.flush(), LOG_FLUSH_MS)
  }

  private receive(chunk: string): void {
    const lines = (this.partial + chunk).split('\n')
    this.partial = lines.pop() ?? ''
    for (const line of lines) {
      const exported = EXPORT_LINE.exec(line)
      const decklink = DECKLINK_LINE.exec(line.trimEnd())
      const screen = SECOND_SCREEN_LINE.exec(line)
      if (exported) {
        const [, name, suffix = ''] = exported
        const snap = this.snapFolder
        this.exports = this.exports.then(() => this.saveExport(snap, name, `${suffix}.png`))
      } else if (decklink) this.decklinkLine(decklink[1], decklink[2] ?? '')
      else if (screen) this.setDecklink({ source: screen[1] as DecklinkSource })
      else if (line.trim()) this.addLine(line.trimEnd())
    }
  }

  private setDecklink(change: Partial<DecklinkState>): void {
    this.decklink = { ...this.decklink, ...change }
    this.send('emulator:decklink', this.decklink)
  }

  /** A list comes as a line per device and then the count. */
  private decklinkLine(kind: string, text: string): void {
    switch (kind) {
      case 'DEVICE':
        this.listing.push(text)
        break
      case 'DEVICES':
        this.setDecklink({ driver: true, devices: this.listing })
        this.listing = []
        break
      case 'NODRIVER':
        this.setDecklink({ driver: false, devices: [] })
        break
      case 'ON':
        this.addLine(`DeckLink: playing ${SOURCE_NAMES[this.decklink.source]} on ${text}, NTSC 525i59.94. SECOND SCREEN picks what it plays.`)
        this.setDecklink({ active: text, error: null })
        break
      case 'OFF':
        this.addLine('DeckLink: stopped.')
        this.setDecklink({ active: null, error: null })
        break
      case 'ERROR':
        this.addLine(`DeckLink: ${text}`)
        this.setDecklink({ active: null, error: text })
        break
    }
  }

  private command(line: string): void {
    if (this.child?.stdin?.writable) this.child.stdin.write(`${line}\n`)
  }

  /** The emulator answers with the lines decklinkLine reads. */
  setDecklinkDevice(cfg: EmulatorConfig): void {
    const name = cfg.decklink.replace(/[\r\n]/g, '')
    this.command(name ? `decklink ${name}` : 'decklink off')
  }

  /**
   * The emulator holds the devices while it runs, so it's asked. Otherwise the binary starts with
   * MAXINE_DECKLINK_LIST set, which prints the list and exits before MAME starts.
   */
  async refreshDecklinks(): Promise<void> {
    if (this.child) {
      this.command('decklink list')
      return
    }
    const paths = layout()
    if (!existsSync(paths.binary)) return
    const libraryPath = [paths.lib, process.env['LD_LIBRARY_PATH']].filter(Boolean).join(':')
    try {
      const { stdout } = await run(paths.binary, [], {
        env: { ...process.env, MAXINE_DECKLINK_LIST: '1', ...(paths.lib ? { LD_LIBRARY_PATH: libraryPath } : {}) },
        timeout: DECKLINK_LIST_TIMEOUT_MS,
        windowsHide: true
      })
      if (this.child) return // started meanwhile, and asks for itself
      this.listing = []
      for (const line of stdout.split('\n')) {
        const decklink = DECKLINK_LINE.exec(line.trimEnd())
        if (decklink) this.decklinkLine(decklink[1], decklink[2] ?? '')
      }
    } catch (err) {
      this.addLine(`Couldn't look for DeckLink devices: ${(err as Error).message}`)
    }
  }

  /**
   * The driver saved the pair when the button was pressed, so it's what was on screen however long
   * this takes. The app asks for the folder because it has a native picker on every system. One at a time.
   */
  private async saveExport(snap: string, name: string, suffix: string): Promise<void> {
    if (this.win.isDestroyed()) return
    const sources = EXPORT_KINDS.map((kind) => join(snap, `${kind}-${name}`))
    try {
      if (this.win.isMinimized()) this.win.restore()
      this.win.show()
      this.win.focus()
      app.focus({ steal: true })
      const { canceled, filePaths } = await dialog.showOpenDialog(this.win, {
        title: 'Choose a folder for the Video and Key PNGs',
        defaultPath: this.exportFolder,
        properties: ['openDirectory', 'createDirectory']
      })
      if (!canceled) {
        const [folder] = filePaths
        this.exportFolder = folder
        // The next number free for both, so nothing in the folder gets replaced
        let count = 0
        let targets: string[]
        do {
          const number = String(count++).padStart(4, '0')
          targets = EXPORT_KINDS.map((kind) => join(folder, `${kind}-${number}${suffix}`))
        } while (targets.some((path) => existsSync(path)))
        for (const [i, target] of targets.entries()) await copyFile(sources[i], target)
        this.addLine(`Saved ${targets.map((path) => basename(path)).join(' and ')} in ${folder}`)
      }
      await Promise.all(sources.map((path) => rm(path, { force: true })))
    } catch (err) {
      this.addLine(`Couldn't save the export: ${(err as Error).message}`)
    }
  }

  async status(cfg: EmulatorConfig): Promise<EmulatorStatus> {
    const paths = layout()
    const disk = await stat(diskPath(cfg)).catch(() => null)
    return {
      missing: existsSync(paths.binary) ? null : app.isPackaged ? 'This build has no emulator.' : 'Run emulator/build.sh first.',
      captureMissing: existsSync(paths.ffmpeg) ? null : app.isPackaged ? 'This build has no ffmpeg.' : 'Run emulator/build-ffmpeg.sh first.',
      running: this.running,
      network: await networkUp(),
      tapMissing: WINDOWS && !tapInstalled(),
      image: imagePath(cfg),
      imageFound: existsSync(imagePath(cfg)),
      folder: folderPath(cfg),
      captureFolder: captureFolderPath(cfg),
      diskSize: disk?.size ?? null
    }
  }

  async start(cfg: EmulatorConfig): Promise<void> {
    if (this.child) throw new Error('The emulator is already running.')
    const paths = layout()
    const folder = folderPath(cfg)
    const disk = diskPath(cfg)
    await mkdir(folder, { recursive: true })
    this.snapFolder = join(folder, 'snap', 'maxine')

    // The firmware writes to its disk, so it runs on a copy that outlives the run
    if (!existsSync(disk)) {
      const image = imagePath(cfg)
      await assertChd(image)
      this.addLine(`Copying ${basename(image)} to ${disk}`)
      const partial = `${disk}.partial`
      await copyFile(image, partial)
      await chmod(partial, 0o644)
      await rename(partial, disk)
    }

    const args = [
      'maxine',
      '-rompath', paths.roms,
      '-hard', disk,
      '-nvram_directory', 'nvram',
      '-cfg_directory', 'cfg',
      '-artpath', paths.artwork,
      '-plugin', 'layout',
      '-pluginspath', paths.plugins,
      '-homepath', folder,
      '-window', '-skip_gameinfo', '-nomouse',
      // The headless tests run with no display
      ...(process.env['MAXINE_EMULATOR_ARGS']?.split(' ').filter(Boolean) ?? [])
    ]
    if (WINDOWS) await forgetNetworkInterface(folder)
    const libraryPath = [paths.lib, process.env['LD_LIBRARY_PATH']].filter(Boolean).join(':')
    const child = spawn(paths.binary, args, {
      cwd: folder,
      env: { ...process.env, MAXINE_LOG_STDOUT: '1', ...(paths.lib ? { LD_LIBRARY_PATH: libraryPath } : {}) },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    child.stdin?.on('error', () => {}) // a pipe that broke because it exited, which 'exit' reports
    this.child = child
    this.lastLine = ''
    this.partial = ''
    this.listing = []
    this.setDecklink({ active: null, source: 'color-edit', error: null })

    child.stdout!.setEncoding('utf8').on('data', (chunk: string) => this.receive(chunk))
    child.stderr!.setEncoding('utf8').on('data', (chunk: string) => this.receive(chunk))

    this.exited = new Promise((resolve) => {
      const finished = (message: string): void => {
        if (this.child !== child) return
        this.child = null
        void this.capture?.stop() // ffmpeg finishes the file from what arrived
        this.addLine(message)
        this.setDecklink({ active: null, source: 'color-edit' })
        this.send('emulator:state', false)
        resolve()
      }
      child.on('error', (err) => finished(`The emulator didn't start: ${err.message}`))
      child.on('exit', (code, signal) => {
        if (code === 0) finished('Stopped.')
        else finished(`The emulator stopped with ${signal ?? `code ${code}`}.`)
      })
    })
    this.send('emulator:state', true)
    void this.refreshDecklinks()
    if (cfg.decklink) this.setDecklinkDevice(cfg)
    if (cfg.videoInput) await this.setVideoInput(cfg).catch((err: Error) => this.addLine(`No video input: ${err.message}`))
  }

  /** The driver only reads PNG, so the picture goes to it as one, in the machine's folder. */
  async setVideoInput(cfg: EmulatorConfig): Promise<void> {
    const stdin = this.child?.stdin
    if (!stdin?.writable) return
    if (!cfg.videoInput) {
      stdin.write('videoin off\n')
      return
    }
    const path = join(folderPath(cfg), VIDEO_INPUT_FILE)
    await writeFile(path, readPicture(cfg.videoInput).toPNG())
    stdin.write(`videoin ${path}\n`)
  }

  async startCapture(cfg: EmulatorConfig): Promise<void> {
    if (!this.child) throw new Error('Run the emulator first.')
    this.capture ??= new Capture(
      layout().ffmpeg,
      (line) => this.command(line),
      (line) => this.addLine(line),
      (state) => this.send('emulator:capture', state)
    )
    await this.capture.start(captureFolderPath(cfg))
  }

  async stopCapture(): Promise<void> {
    await this.capture?.stop()
  }

  /**
   * SIGTERM is what saves the NVRAM: the driver turns it into a normal exit. Node's kill() on Windows
   * just ends the process, so there the driver watches for stdin closing instead. A capture finishes
   * first, so quitting the app leaves both files readable.
   */
  async stop(): Promise<void> {
    const child = this.child
    if (!child) return
    await this.stopCapture()
    if (this.child !== child) return
    if (WINDOWS) child.stdin!.end()
    else child.kill('SIGTERM')
    const timer = setTimeout(() => {
      this.addLine("The emulator didn't stop, so it was killed. Any NVRAM changes from this run are lost.")
      child.kill('SIGKILL')
    }, STOP_TIMEOUT_MS)
    await this.exited
    clearTimeout(timer)
  }

  /** Resolves to whether the link is up, which is unchanged if the password prompt was cancelled. */
  async setNetwork(up: boolean): Promise<boolean> {
    if (this.child) throw new Error('Stop the emulator first. It only attaches to the network when it starts.')
    try {
      if (WINDOWS) await elevateWindows(join(layout().scripts, up ? 'net-up.ps1' : 'net-down.ps1'))
      else await elevate(await readFile(join(layout().scripts, up ? 'net-up.sh' : 'net-down.sh'), 'utf8'))
    } catch (err) {
      const { code, message } = err as NodeJS.ErrnoException & { code?: string | number }
      if (code === 'ENOENT') throw new Error('pkexec is missing, so the app can\'t ask for your password. Install polkit.')
      if (!CANCELLED.has(Number(code)) && !/User canceled/.test(message)) throw err
    }
    return networkUp()
  }

  async readNvram(cfg: EmulatorConfig): Promise<NvramFile> {
    const data = await readFile(nvramPath(cfg)).catch(() => null)
    if (!data) return { exists: false, data: null }
    if (data.length !== NVRAM_SIZE) throw new Error(`The NVRAM file is ${data.length} bytes, not ${NVRAM_SIZE}.`)
    return { exists: true, data: new Uint8Array(data) }
  }

  /** The emulator writes this file when it exits, so an edit made while it runs would be lost. */
  async writeNvram(cfg: EmulatorConfig, data: Uint8Array): Promise<void> {
    if (this.child) throw new Error('Stop the emulator before editing NVRAM.')
    if (data.length !== NVRAM_SIZE) throw new Error(`NVRAM must be ${NVRAM_SIZE} bytes.`)
    const path = nvramPath(cfg)
    await mkdir(join(path, '..'), { recursive: true })
    if (existsSync(path)) await copyFile(path, `${path}.bak`)
    await writeFile(`${path}.tmp`, data)
    await rename(`${path}.tmp`, path)
  }
}

export function registerEmulator(win: BrowserWindow): Emulator {
  const emulator = new Emulator(win)

  ipcMain.handle('emulator:status', (_, cfg: EmulatorConfig) => emulator.status(cfg))
  ipcMain.handle('emulator:start', (_, cfg: EmulatorConfig) => emulator.start(cfg))
  ipcMain.handle('emulator:stop', () => emulator.stop())
  ipcMain.handle('emulator:capture-start', (_, cfg: EmulatorConfig) => emulator.startCapture(cfg))
  ipcMain.handle('emulator:capture-stop', () => emulator.stopCapture())
  ipcMain.handle('emulator:video-input', (_, cfg: EmulatorConfig) => emulator.setVideoInput(cfg))
  ipcMain.handle('emulator:decklink', (_, cfg: EmulatorConfig) => emulator.setDecklinkDevice(cfg))
  ipcMain.handle('emulator:decklink-refresh', () => emulator.refreshDecklinks())
  ipcMain.handle('emulator:network', (_, up: boolean) => emulator.setNetwork(up))
  ipcMain.handle('emulator:nvram-read', (_, cfg: EmulatorConfig) => emulator.readNvram(cfg))
  ipcMain.handle('emulator:nvram-write', (_, cfg: EmulatorConfig, data: Uint8Array) => emulator.writeNvram(cfg, data))
  ipcMain.handle('emulator:open-folder', async (_, cfg: EmulatorConfig) => {
    await mkdir(folderPath(cfg), { recursive: true })
    await shell.openPath(folderPath(cfg))
  })

  ipcMain.handle('emulator:open-capture-folder', async (_, cfg: EmulatorConfig) => {
    await mkdir(captureFolderPath(cfg), { recursive: true })
    await shell.openPath(captureFolderPath(cfg))
  })

  ipcMain.handle('emulator:tap-download', () => shell.openExternal(TAP_DOWNLOAD))

  ipcMain.handle('emulator:pick-image', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: 'Choose a read-only disk image',
      defaultPath: layout().roms,
      properties: ['openFile'],
      filters: [{ name: 'CHD disk images', extensions: ['chd'] }]
    })
    if (canceled) return null
    await assertChd(filePaths[0])
    return filePaths[0]
  })
  ipcMain.handle('emulator:pick-folder', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: 'Choose where the saved image is kept',
      buttonLabel: 'Use This Folder',
      properties: ['openDirectory', 'createDirectory']
    })
    return canceled ? null : filePaths[0]
  })

  ipcMain.handle('emulator:pick-capture-folder', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: 'Choose where captures are saved',
      buttonLabel: 'Use This Folder',
      properties: ['openDirectory', 'createDirectory']
    })
    return canceled ? null : filePaths[0]
  })

  ipcMain.handle('emulator:pick-video-input', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: 'Choose a picture for the video input',
      properties: ['openFile'],
      filters: [{ name: 'Pictures', extensions: PICTURE_EXTENSIONS }]
    })
    if (canceled) return null
    readPicture(filePaths[0])
    return filePaths[0]
  })

  ipcMain.handle('emulator:reset', async (_, cfg: EmulatorConfig) => {
    if (emulator.running) throw new Error('Stop the emulator first.')
    if (!isAbsolute(diskPath(cfg))) throw new Error('The saved image location must be a full path.')
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      message: 'Reset the saved image?',
      detail: `This deletes ${diskPath(cfg)}, with any messages, fonts and logos saved on it. The next run copies ${basename(imagePath(cfg))} again. NVRAM stays as it is.`,
      buttons: ['Reset', 'Cancel'],
      defaultId: 1,
      cancelId: 1
    })
    if (response !== 0) return false
    await rm(diskPath(cfg), { force: true })
    return true
  })

  return emulator
}
