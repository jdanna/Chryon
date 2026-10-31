import { app } from 'electron'
import { ChildProcessWithoutNullStreams, spawn } from 'child_process'
import { join } from 'path'

interface Pending {
  resolve(value: unknown): void
  reject(err: Error): void
}

function pythonCommand(): { bin: string; args: string[] } {
  // Keep .pyc files out of the install folder, which may be read-only
  const cache = ['-X', `pycache_prefix=${join(app.getPath('userData'), 'pycache')}`]
  if (!app.isPackaged) {
    return { bin: process.platform === 'win32' ? 'python' : 'python3', args: [...cache, '-X', 'utf8'] }
  }
  const python = join(process.resourcesPath, 'python')
  return {
    bin: process.platform === 'win32' ? join(python, 'python.exe') : join(python, 'bin', 'python3'),
    args: ['-I', ...cache, '-X', 'utf8'] // -I: ignore any Python setup on the user's machine
  }
}

function bridgeScript(): string {
  const tools = app.isPackaged ? join(process.resourcesPath, 'tools') : join(app.getAppPath(), 'tools')
  return join(tools, 'studio_bridge.py')
}

/** Owns the tools/studio_bridge.py subprocess. Respawns on the next call if it dies. */
export class Bridge {
  private child: ChildProcessWithoutNullStreams | null = null
  private pending = new Map<number, Pending>()
  private nextId = 0
  private buffer = ''
  private stderrTail = ''

  constructor(private onEvent: (event: Record<string, unknown>) => void) {}

  private start(): ChildProcessWithoutNullStreams {
    const { bin, args } = pythonCommand()
    const child = spawn(bin, [...args, bridgeScript()], { stdio: 'pipe', windowsHide: true })
    this.child = child
    this.buffer = ''
    this.stderrTail = ''

    // Every handler checks identity, so a dead process can't touch a newer one's state
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      if (this.child !== child) return
      this.buffer += chunk
      const lines = this.buffer.split('\n')
      this.buffer = lines.pop() ?? ''
      for (const line of lines) if (line.trim()) this.receive(JSON.parse(line))
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      if (this.child === child) this.stderrTail = (this.stderrTail + chunk).slice(-2000)
    })
    const died = (reason: string): void => {
      if (this.child !== child) return
      this.child = null
      const detail = this.stderrTail.trim()
      const err = new Error(`The Python backend ${reason}${detail ? `:\n${detail}` : '.'}`)
      for (const p of this.pending.values()) p.reject(err)
      this.pending.clear()
    }
    child.on('error', (err) => died(`failed to start (${err.message})`))
    child.on('exit', (code) => died(`exited with code ${code}`))
    return child
  }

  private receive(msg: { id?: number; ok?: boolean; result?: unknown; error?: string; event?: string }): void {
    if (msg.event) {
      this.onEvent(msg as Record<string, unknown>)
      return
    }
    const pending = this.pending.get(msg.id!)
    if (!pending) return
    this.pending.delete(msg.id!)
    if (msg.ok) pending.resolve(msg.result)
    else pending.reject(new Error(msg.error))
  }

  call<T>(cmd: string, args: object = {}): Promise<T> {
    const child = this.child ?? this.start()
    const id = ++this.nextId
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
      child.stdin.write(JSON.stringify({ id, cmd, args }) + '\n')
    })
  }

  stop(): void {
    this.child?.stdin.end() // the bridge exits when stdin closes
    this.child = null
  }
}
