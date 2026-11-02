import { ChildProcess, spawn } from 'child_process'
import { existsSync } from 'fs'
import { mkdir, rm, stat, statfs } from 'fs/promises'
import { AddressInfo, createServer, Server, Socket } from 'net'
import { basename, join } from 'path'
import type { CaptureState } from '@shared/types'

// What the driver sends: 720x486 at 29.97, one $KKRRGGBB pixel holding Video and Key
const FRAME_BYTES = 720 * 486 * 4
const FRAMES_PER_SECOND = 30000 / 1001

// A .mov can't be read until its index goes in at the end, so a full disk would lose the whole capture
const MIN_FREE_TO_START = 1024 ** 3
const MIN_FREE_WHILE_RUNNING = 500 * 1024 ** 2
const STATUS_MS = 1000
const BEHIND_SECONDS = 1
const FINISH_TIMEOUT_MS = 30000
const ERROR_TAIL = 2000

const IDLE: CaptureState = { active: false, seconds: 0, bytes: 0, behind: false }

/**
 * Both files come from one stream, so they can't drift apart. 486-line NTSC is lower field first, and
 * the fields stay on their own lines, because 4:2:2 has no vertical chroma to blend them. Pixels stay at
 * 720x486 and the file says 10:11, Rec. 601's value for NTSC. The key is a picture, so black is 64 and
 * white 940 in the 10-bit file, like any other video signal.
 */
function encoderArgs(video: string, key: string): string[] {
  const tags = 'setparams=field_mode=bff:range=tv:color_primaries=smpte170m:color_trc=bt709:colorspace=smpte170m,setsar=10/11'
  const scale = 'flags=bicubic+accurate_rnd,format=yuv422p10le'
  const filter =
    `[0:v]split=2[fill][matte];` +
    `[fill]scale=out_color_matrix=smpte170m:out_range=tv:${scale},${tags}[video];` +
    `[matte]alphaextract,scale=in_range=pc:out_range=tv:${scale},${tags}[key]`
  const encoder = ['-c:v', 'prores_ks', '-profile:v', 'hq', '-vendor', 'apl0', '-flags', '+ildct+ilme']
  return [
    '-hide_banner', '-nostats', '-loglevel', 'error',
    '-f', 'rawvideo', '-pixel_format', 'bgra', '-video_size', '720x486', '-framerate', '30000/1001', '-i', 'pipe:0',
    '-filter_complex', filter,
    '-map', '[video]', ...encoder, video,
    '-map', '[key]', ...encoder, key
  ]
}

const clock = (seconds: number): string =>
  `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`

/** The next number free for both, so nothing in the folder gets replaced. */
function nextFiles(folder: string): { video: string; key: string } {
  for (let count = 1; ; count++) {
    const number = String(count).padStart(4, '0')
    const video = join(folder, `capture-${number}-video.mov`)
    const key = join(folder, `capture-${number}-key.mov`)
    if (!existsSync(video) && !existsSync(key)) return { video, key }
  }
}

async function freeBytes(folder: string): Promise<number> {
  const { bavail, bsize } = await statfs(folder)
  return bavail * bsize
}

/** The driver connects to a local port here, and that stream goes on to ffmpeg's stdin. One capture at a time. */
export class Capture {
  private server: Server | null = null
  private socket: Socket | null = null
  private encoder: ChildProcess | null = null
  private timer: NodeJS.Timeout | null = null
  private finished: Promise<void> = Promise.resolve()
  private bytesIn = 0
  private firstByteAt = 0
  private files = { video: '', key: '' }
  private folder = ''
  private stopping = false
  private errorText = ''

  constructor(
    private ffmpeg: string,
    private command: (line: string) => void,
    private log: (line: string) => void,
    private report: (state: CaptureState) => void
  ) {}

  get active(): boolean {
    return this.encoder !== null
  }

  private get seconds(): number {
    return Math.floor(this.bytesIn / FRAME_BYTES) / FRAMES_PER_SECOND
  }

  private get behind(): boolean {
    return this.firstByteAt > 0 && (Date.now() - this.firstByteAt) / 1000 - this.seconds > BEHIND_SECONDS
  }

  async start(folder: string): Promise<void> {
    if (this.encoder) throw new Error('A capture is already running.')
    await mkdir(folder, { recursive: true })
    if ((await freeBytes(folder)) < MIN_FREE_TO_START) throw new Error(`${folder} has under 1 GB free.`)

    this.folder = folder
    this.files = nextFiles(folder)
    this.bytesIn = 0
    this.firstByteAt = 0
    this.stopping = false
    this.errorText = ''

    const server = createServer()
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })

    const encoder = spawn(this.ffmpeg, encoderArgs(this.files.video, this.files.key), {
      stdio: ['pipe', 'ignore', 'pipe'],
      windowsHide: true
    })
    this.server = server
    this.encoder = encoder
    encoder.stderr!.setEncoding('utf8').on('data', (text: string) => {
      this.errorText = (this.errorText + text).slice(-ERROR_TAIL)
    })
    encoder.stdin!.on('error', () => {}) // it stopped reading, which its exit reports

    server.once('connection', (socket) => {
      server.close()
      this.socket = socket
      socket.on('data', (chunk) => {
        this.firstByteAt ||= Date.now()
        this.bytesIn += chunk.length
      })
      socket.on('error', () => encoder.stdin!.end()) // the emulator crashed, so finish what arrived
      socket.pipe(encoder.stdin!)
    })

    this.finished = new Promise((resolve) => {
      const done = (message: string | null): void => {
        if (this.encoder !== encoder) return
        this.encoder = null
        void this.close(message).finally(resolve)
      }
      encoder.on('error', (err) => done(`Couldn't run ffmpeg: ${err.message}`))
      encoder.on('close', (code, signal) => done(code === 0 ? null : `ffmpeg stopped with ${signal ?? `code ${code}`}.`))
    })

    this.timer = setInterval(() => void this.tick(), STATUS_MS)
    this.command(`capture ${(server.address() as AddressInfo).port}`)
    this.report({ active: true, seconds: 0, bytes: 0, behind: false })
  }

  private async sizes(): Promise<number> {
    const sizes = await Promise.all([this.files.video, this.files.key].map((path) => stat(path).catch(() => null)))
    return sizes.reduce((sum, size) => sum + (size?.size ?? 0), 0)
  }

  private async tick(): Promise<void> {
    if (this.stopping) return
    const bytes = await this.sizes()
    if (!this.encoder) return
    this.report({ active: true, seconds: this.seconds, bytes, behind: this.behind })
    if ((await freeBytes(this.folder).catch(() => Infinity)) < MIN_FREE_WHILE_RUNNING) {
      this.log(`Stopping the capture, because ${this.folder} has under 500 MB free.`)
      void this.stop()
    }
  }

  private async close(failure: string | null): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.server?.close()
    this.server = null
    this.socket?.destroy() // after a failure, this is what tells the driver to stop sending
    this.socket = null

    const names = `${basename(this.files.video)} and ${basename(this.files.key)}`
    const hasFrames = this.bytesIn >= FRAME_BYTES
    if (failure) {
      this.log(`The capture failed: ${failure}`)
      for (const line of this.errorText.trim().split('\n').filter(Boolean)) this.log(line)
    }
    if (hasFrames && !failure) {
      this.log(`Captured ${clock(this.seconds)} to ${names} in ${this.folder}`)
      if (this.behind) this.log('The emulator ran behind real time. Every field is in the file, so the action in it is as the machine saw it.')
    } else {
      if (!failure) this.log('The capture stopped before a whole frame arrived, so there are no files.')
      await Promise.all([this.files.video, this.files.key].map((path) => rm(path, { force: true })))
    }
    this.report(IDLE)
  }

  /** Resolves once ffmpeg has written both files. If the emulator has gone, it's finishing already. */
  async stop(): Promise<void> {
    const encoder = this.encoder
    if (!encoder) return this.finished
    this.stopping = true
    this.command('capture stop')
    if (!this.socket) encoder.stdin!.end() // it never connected
    const timeout = setTimeout(() => encoder.kill(), FINISH_TIMEOUT_MS)
    await this.finished
    clearTimeout(timeout)
  }
}
