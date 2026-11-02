import { useCallback, useEffect, useRef, useState } from 'react'
import type { EmulatorConfig, EmulatorStatus } from '@shared/types'
import { errorMessage } from '../format'
import type { LogKind } from './LogPanel'
import NvramPanel from './NvramPanel'
import ui from './ui.module.css'
import styles from './EmulatorTab.module.css'

const api = window.maxine
const MAX_LOG_LINES = 2000
const BOTTOM_SLACK_PX = 24

interface Props {
  settings: EmulatorConfig
  onSettings(settings: EmulatorConfig): void
  log(text: string, kind?: LogKind): void
  setStatus(status: string): void
}

const megabytes = (bytes: number): string => `${(bytes / 1048576).toFixed(1)} MB`

export default function EmulatorTab({ settings, onSettings, log, setStatus }: Props): JSX.Element {
  const [status, setEmulatorStatus] = useState<EmulatorStatus | null>(null)
  const [lines, setLines] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [networkBusy, setNetworkBusy] = useState(false)
  const output = useRef<HTMLDivElement>(null)
  const followOutput = useRef(true)

  const running = status?.running ?? false
  const needsTap = (status?.tapMissing ?? false) && !status?.network

  const refresh = useCallback(async () => {
    try {
      setEmulatorStatus(await api.emulatorStatus(settings))
    } catch (err) {
      log(`Could not check the emulator: ${errorMessage(err)}`, 'error')
    }
  }, [settings, log])

  useEffect(() => {
    refresh()
  }, [refresh])

  // The user installs TAP-Windows outside the app, then comes back
  useEffect(() => {
    if (!status?.tapMissing) return
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [status?.tapMissing, refresh])

  useEffect(
    () =>
      api.onEmulatorLog((added) => {
        setLines((all) => [...all, ...added].slice(-MAX_LOG_LINES))
      }),
    []
  )
  useEffect(
    () =>
      api.onEmulatorState((nowRunning) => {
        setStatus(nowRunning ? 'Emulator running' : 'Emulator stopped')
        refresh()
      }),
    [refresh, setStatus]
  )

  useEffect(() => {
    const el = output.current
    if (el && followOutput.current) el.scrollTop = el.scrollHeight
  }, [lines])

  const start = async (): Promise<void> => {
    setBusy(true)
    try {
      await api.emulatorStart(settings)
    } catch (err) {
      log(`Could not start the emulator: ${errorMessage(err)}`, 'error')
    }
    setBusy(false)
  }

  const stop = async (): Promise<void> => {
    setBusy(true)
    setStatus('Stopping the emulator…')
    await api.emulatorStop()
    setBusy(false)
  }

  const setNetwork = async (up: boolean): Promise<void> => {
    setNetworkBusy(true)
    try {
      const nowUp = await api.emulatorNetwork(up)
      if (nowUp === up) log(up ? 'Network up: this computer is 10.37.0.1, and the MAXINE will be 10.37.0.2.' : 'Network stopped.', 'ok')
      await refresh()
    } catch (err) {
      log(`Could not ${up ? 'start' : 'stop'} the network: ${errorMessage(err)}`, 'error')
    }
    setNetworkBusy(false)
  }

  const pickImage = async (): Promise<void> => {
    try {
      const image = await api.pickEmulatorImage()
      if (image) onSettings({ ...settings, image })
    } catch (err) {
      log(errorMessage(err), 'error')
    }
  }

  const pickFolder = async (): Promise<void> => {
    const folder = await api.pickEmulatorFolder()
    if (folder) onSettings({ ...settings, folder })
  }

  const resetDisk = async (): Promise<void> => {
    try {
      if (await api.resetEmulatorDisk(settings)) {
        log('Reset the saved image. The next run makes a new copy.', 'ok')
        await refresh()
      }
    } catch (err) {
      log(`Could not reset the saved image: ${errorMessage(err)}`, 'error')
    }
  }

  const hasDisk = status?.diskSize !== null && status?.diskSize !== undefined
  const canRun = !!status && !status.missing && (hasDisk || status.imageFound)

  return (
    <div className={styles.layout}>
      <aside className={styles.controls}>
        <div className={ui.sectionHeader}>
          Emulator
          <span className={ui.sectionMeta}>{running ? 'running' : 'stopped'}</span>
        </div>
        <div className={styles.block}>
          {running ? (
            <button className={`${ui.btn} ${styles.wide}`} disabled={busy} onClick={stop}>
              {busy ? 'Stopping…' : 'Stop emulator'}
            </button>
          ) : (
            <button className={`${ui.btnPrimary} ${styles.wide}`} disabled={busy || !canRun} onClick={start}>
              {busy ? 'Starting…' : 'Run emulator'}
            </button>
          )}
          {status?.missing && <div className={`${styles.note} ${ui.hintWarn}`}>{status.missing}</div>}
        </div>

        <div className={ui.sectionHeader}>
          Network
          <span className={ui.sectionMeta}>{status?.network ? 'up' : 'down'}</span>
        </div>
        <div className={styles.block}>
          <div className={styles.buttons}>
            {needsTap ? (
              <button className={ui.btn} onClick={() => api.openTapDownload()}>
                Download TAP-Windows
              </button>
            ) : (
              <button className={ui.btn} disabled={networkBusy || running || status?.network} onClick={() => setNetwork(true)}>
                Start network
              </button>
            )}
            <button className={ui.btn} disabled={networkBusy || running || !status?.network} onClick={() => setNetwork(false)}>
              Stop network
            </button>
          </div>
          <div className={styles.note}>
            {running
              ? 'The emulator only attaches when it starts, so stop it to change this.'
              : status?.network
                ? 'This computer is 10.37.0.1, and the MAXINE will be 10.37.0.2.'
                : needsTap
                  ? 'The network needs the free TAP-Windows driver from OpenVPN. Install it with the default options, then come back here.'
                  : api.platform === 'win32'
                    ? 'Asks for administrator approval. Stays set up until you stop it.'
                    : 'Asks for your password. Lasts until you restart your computer.'}
          </div>
        </div>

        <div className={ui.sectionHeader}>Disk</div>
        <div className={styles.block}>
          <div className={styles.path}>
            <span className={styles.pathLabel}>Read-only image</span>
            <span className={`${ui.mono} ${styles.pathValue}`} title={status?.image}>
              {settings.image || 'Built-in, maxine-default.chd'}
            </span>
            <div className={styles.buttons}>
              <button className={ui.btnSmall} disabled={running} onClick={pickImage}>
                Browse…
              </button>
              {settings.image && (
                <button className={ui.btnSmall} disabled={running} onClick={() => onSettings({ ...settings, image: '' })}>
                  Use built-in
                </button>
              )}
            </div>
            {status && !status.imageFound && <span className={`${styles.note} ${ui.hintWarn}`}>This file is missing.</span>}
          </div>

          <div className={styles.path}>
            <span className={styles.pathLabel}>Saved image location</span>
            <span className={`${ui.mono} ${styles.pathValue}`} title={status?.folder}>
              {status?.folder}
            </span>
            <div className={styles.buttons}>
              <button className={ui.btnSmall} disabled={running} onClick={pickFolder}>
                Browse…
              </button>
              {settings.folder && (
                <button className={ui.btnSmall} disabled={running} onClick={() => onSettings({ ...settings, folder: '' })}>
                  Use default
                </button>
              )}
              <button className={ui.btnSmall} onClick={() => api.openEmulatorFolder(settings)}>
                Open
              </button>
            </div>
          </div>

          <div className={styles.path}>
            <span className={styles.pathLabel}>Saved image</span>
            <span className={`${ui.mono} ${styles.pathValue}`}>{hasDisk ? `disk.chd, ${megabytes(status!.diskSize!)}` : 'None yet'}</span>
            <div className={styles.buttons}>
              <button className={ui.btnSmall} disabled={running || !hasDisk} onClick={resetDisk}>
                Reset…
              </button>
            </div>
            <span className={styles.note}>
              {hasDisk
                ? 'Runs use this copy, so a new read-only image only applies after a reset.'
                : 'The first run copies the read-only image here.'}
            </span>
          </div>
        </div>
      </aside>

      <section className={styles.output}>
        <div className={ui.sectionHeader}>
          Emulator log
          <span className={ui.spacer} />
          <button className={ui.btnSmall} disabled={lines.length === 0} onClick={() => setLines([])}>
            Clear
          </button>
        </div>
        <div
          className={styles.logBody}
          ref={output}
          onScroll={(e) => {
            const el = e.currentTarget
            followOutput.current = el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_SLACK_PX
          }}
        >
          {lines.length === 0 ? (
            <div className={ui.empty}>The emulator and firmware log here while it runs.</div>
          ) : (
            lines.map((line, i) => (
              <div key={i} className={styles.logLine}>
                {line}
              </div>
            ))
          )}
        </div>
      </section>

      <NvramPanel config={settings} running={running} log={log} />
    </div>
  )
}
