import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { ChildProcess, execFile, spawn } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { chmod, copyFile, mkdir, open, readFile, rename, rm, stat, writeFile } from 'fs/promises'
import { basename, isAbsolute, join } from 'path'
import { promisify } from 'util'
import type { EmulatorConfig, EmulatorStatus, NvramFile } from '@shared/types'
import { NVRAM_SIZE } from '@shared/nvram'

const run = promisify(execFile)

const STOP_TIMEOUT_MS = 8000
const LOG_FLUSH_MS = 100
const LOG_BATCH_LINES = 500
const CHD_MAGIC = 'MComprHD'
const DEFAULT_IMAGE = 'maxine-default.chd'
const CANCELLED = new Set([126, 127]) // pkexec: dialog dismissed, or not authorised

interface Layout {
  binary: string
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
      binary: join(root, 'maxine'),
      plugins: join(root, 'plugins'),
      artwork: join(root, 'artwork'),
      roms: join(root, 'roms'),
      scripts: root,
      lib: join(root, 'lib')
    }
  }
  const root = join(app.getAppPath(), 'emulator')
  return {
    binary: join(root, 'mame', 'maxine'),
    plugins: join(root, 'mame', 'plugins'),
    artwork: join(root, 'artwork'),
    roms: join(root, 'roms'),
    scripts: root,
    lib: null
  }
}

const imagePath = (cfg: EmulatorConfig): string => cfg.image || join(layout().roms, DEFAULT_IMAGE)
const folderPath = (cfg: EmulatorConfig): string => cfg.folder || join(app.getPath('userData'), 'emulator')
const diskPath = (cfg: EmulatorConfig): string => join(folderPath(cfg), 'disk.chd')
const nvramPath = (cfg: EmulatorConfig): string => join(folderPath(cfg), 'nvram', 'maxine', 'nvram')

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

async function networkUp(): Promise<boolean> {
  try {
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

/** Owns the MAME process. Only one runs at a time, because it takes the only network interface. */
export class Emulator {
  private child: ChildProcess | null = null
  private exited: Promise<void> | null = null
  private pending: string[] = []
  private partial = ''
  private lastLine = ''
  private repeats = 0
  private flushTimer: NodeJS.Timeout | null = null

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
    for (const line of lines) if (line.trim()) this.addLine(line.trimEnd())
  }

  async status(cfg: EmulatorConfig): Promise<EmulatorStatus> {
    const paths = layout()
    const disk = await stat(diskPath(cfg)).catch(() => null)
    return {
      missing: existsSync(paths.binary) ? null : app.isPackaged ? 'This build has no emulator.' : 'Run emulator/build.sh first.',
      running: this.running,
      network: await networkUp(),
      image: imagePath(cfg),
      imageFound: existsSync(imagePath(cfg)),
      folder: folderPath(cfg),
      diskSize: disk?.size ?? null
    }
  }

  async start(cfg: EmulatorConfig): Promise<void> {
    if (this.child) throw new Error('The emulator is already running.')
    const paths = layout()
    const folder = folderPath(cfg)
    const disk = diskPath(cfg)
    await mkdir(folder, { recursive: true })

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
    const libraryPath = [paths.lib, process.env['LD_LIBRARY_PATH']].filter(Boolean).join(':')
    const child = spawn(paths.binary, args, {
      cwd: folder,
      env: { ...process.env, MAXINE_LOG_STDOUT: '1', ...(paths.lib ? { LD_LIBRARY_PATH: libraryPath } : {}) },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    this.child = child
    this.lastLine = ''
    this.partial = ''

    child.stdout!.setEncoding('utf8').on('data', (chunk: string) => this.receive(chunk))
    child.stderr!.setEncoding('utf8').on('data', (chunk: string) => this.receive(chunk))

    this.exited = new Promise((resolve) => {
      const finished = (message: string): void => {
        if (this.child !== child) return
        this.child = null
        this.addLine(message)
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
  }

  /** SIGTERM is what saves the NVRAM: the driver turns it into a normal exit. */
  async stop(): Promise<void> {
    const child = this.child
    if (!child) return
    child.kill('SIGTERM')
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
    const script = await readFile(join(layout().scripts, up ? 'net-up.sh' : 'net-down.sh'), 'utf8')
    try {
      await elevate(script)
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
  ipcMain.handle('emulator:network', (_, up: boolean) => emulator.setNetwork(up))
  ipcMain.handle('emulator:nvram-read', (_, cfg: EmulatorConfig) => emulator.readNvram(cfg))
  ipcMain.handle('emulator:nvram-write', (_, cfg: EmulatorConfig, data: Uint8Array) => emulator.writeNvram(cfg, data))
  ipcMain.handle('emulator:open-folder', async (_, cfg: EmulatorConfig) => {
    await mkdir(folderPath(cfg), { recursive: true })
    await shell.openPath(folderPath(cfg))
  })

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
