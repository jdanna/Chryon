import { useCallback, useEffect, useRef, useState } from 'react'
import type { CaptureState, DecklinkSource, DecklinkState, EmulatorConfig, EmulatorStatus } from '@shared/types'
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

const CAPTURE_IDLE: CaptureState = { active: false, seconds: 0, bytes: 0, behind: false }
const DECKLINK_IDLE: DecklinkState = { driver: null, devices: [], active: null, source: 'color-edit', error: null }
const SOURCE_NAMES: Record<DecklinkSource, string> = { 'color-edit': 'Color Edit', video: 'Video', key: 'Key' }

const megabytes = (bytes: number): string => `${(bytes / 1048576).toFixed(1)} MB`
const elapsed = (seconds: number): string => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`

export default function EmulatorTab({ settings, onSettings, log: appLog, setStatus }: Props): JSX.Element {
  const [status, setEmulatorStatus] = useState<EmulatorStatus | null>(null)
  const [lines, setLines] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [networkBusy, setNetworkBusy] = useState(false)
  const [capture, setCapture] = useState(CAPTURE_IDLE)
  const [captureBusy, setCaptureBusy] = useState(false)
  const [decklink, setDecklink] = useState(DECKLINK_IDLE)
  const output = useRef<HTMLDivElement>(null)
  const followOutput = useRef(true)

  // The app's log is hidden on this tab, so the tab's own messages show in the emulator log too
  const log = useCallback(
    (text: string, kind?: LogKind) => {
      appLog(text, kind)
      setLines((all) => [...all, text].slice(-MAX_LOG_LINES))
    },
    [appLog]
  )

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

  // TAP-Windows and the network scripts can both be run outside the app
  useEffect(() => {
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [refresh])

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

  useEffect(() => api.onEmulatorCapture(setCapture), [])
  useEffect(() => api.onEmulatorDecklink(setDecklink), [])
  useEffect(() => {
    api.emulatorDecklinkRefresh()
  }, [])

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

  const startCapture = async (): Promise<void> => {
    setCaptureBusy(true)
    try {
      await api.emulatorCaptureStart(settings)
    } catch (err) {
      log(`Could not start the capture: ${errorMessage(err)}`, 'error')
    }
    setCaptureBusy(false)
  }

  const stopCapture = async (): Promise<void> => {
    setCaptureBusy(true)
    await api.emulatorCaptureStop()
    setCaptureBusy(false)
  }

  const pickCaptureFolder = async (): Promise<void> => {
    const captureFolder = await api.pickCaptureFolder()
    if (captureFolder) onSettings({ ...settings, captureFolder })
  }

  const setVideoInput = async (videoInput: string): Promise<void> => {
    const next = { ...settings, videoInput }
    onSettings(next)
    try {
      await api.emulatorVideoInput(next)
    } catch (err) {
      log(`Could not change the video input: ${errorMessage(err)}`, 'error')
    }
  }

  const setDecklinkDevice = async (name: string): Promise<void> => {
    const next = { ...settings, decklink: name }
    onSettings(next)
    try {
      await api.emulatorDecklink(next)
    } catch (err) {
      log(`Could not change the DeckLink output: ${errorMessage(err)}`, 'error')
    }
  }

  // The saved device stays in the list when it isn't connected, so choosing another is deliberate
  const decklinkChoices = settings.decklink && !decklink.devices.includes(settings.decklink) ? [...decklink.devices, settings.decklink] : decklink.devices
  const decklinkNote = (): JSX.Element => {
    if (decklink.error) return <div className={`${styles.note} ${ui.hintWarn}`}>{decklink.error}</div>
    if (decklink.driver === false)
      return <div className={`${styles.note} ${ui.hintWarn}`}>Blackmagic Desktop Video isn't installed, so there are no DeckLink devices.</div>
    if (decklink.driver && decklink.devices.length === 0)
      return <div className={`${styles.note} ${ui.hintWarn}`}>No DeckLink devices found. Connect one, then Refresh.</div>
    if (decklink.active)
      return (
        <span className={`${ui.mono} ${styles.pathValue}`}>
          {SOURCE_NAMES[decklink.source]}, NTSC 525i59.94
        </span>
      )
    return <div className={styles.note}>Plays Color Edit, Video or Key as NTSC 525i59.94, whichever SECOND SCREEN shows.</div>
  }

  const pickVideoInput = async (): Promise<void> => {
    try {
      const videoInput = await api.pickVideoInput()
      if (videoInput) await setVideoInput(videoInput)
    } catch (err) {
      log(errorMessage(err), 'error')
    }
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
      <div className={styles.sections}>
        <section className={styles.column}>
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
        </section>

        <section className={styles.column}>
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
        </section>

        <section className={styles.column}>
          <div className={ui.sectionHeader}>
            Video input
            <span className={ui.sectionMeta}>{settings.videoInput ? 'picture' : 'none'}</span>
          </div>
          <div className={styles.block}>
            <div className={styles.path}>
              <span className={styles.pathLabel}>Picture</span>
              <span className={`${ui.mono} ${styles.pathValue}`} title={settings.videoInput}>
                {settings.videoInput || 'None'}
              </span>
              <div className={styles.buttons}>
                <button className={ui.btnSmall} onClick={pickVideoInput}>
                  Browse…
                </button>
                {settings.videoInput && (
                  <button className={ui.btnSmall} onClick={() => setVideoInput('')}>
                    Clear
                  </button>
                )}
              </div>
              <span className={styles.note}>
                What the Video Input board sees. In Message Compose, CNTL then I shows it live, and Video Freeze keeps it.
              </span>
            </div>
          </div>

          <div className={ui.sectionHeader}>
            Capture
            <span className={ui.sectionMeta}>{capture.active ? 'recording' : 'stopped'}</span>
          </div>
          <div className={styles.block}>
            {capture.active ? (
              <button className={`${ui.btn} ${styles.wide}`} disabled={captureBusy} onClick={stopCapture}>
                {captureBusy ? 'Finishing…' : 'Stop capture'}
              </button>
            ) : (
              <button className={`${ui.btn} ${styles.wide}`} disabled={captureBusy || !running || !!status?.captureMissing} onClick={startCapture}>
                Start capture
              </button>
            )}
            {capture.active && (
              <span className={`${ui.mono} ${styles.pathValue}`}>
                {elapsed(capture.seconds)}, {megabytes(capture.bytes)}
              </span>
            )}
            {capture.behind && (
              <div className={`${styles.note} ${ui.hintWarn}`}>The emulator is behind real time. Every field is still being saved.</div>
            )}
            {status?.captureMissing ? (
              <div className={`${styles.note} ${ui.hintWarn}`}>{status.captureMissing}</div>
            ) : (
              !capture.active && (
                <div className={styles.note}>Records Video and Key as ProRes 422 HQ, 720×486 at 59.94i, up to about 1 GB a minute.</div>
              )
            )}
            <div className={styles.path}>
              <span className={styles.pathLabel}>Capture folder</span>
              <span className={`${ui.mono} ${styles.pathValue}`} title={status?.captureFolder}>
                {status?.captureFolder}
              </span>
              <div className={styles.buttons}>
                <button className={ui.btnSmall} disabled={capture.active} onClick={pickCaptureFolder}>
                  Browse…
                </button>
                {settings.captureFolder && (
                  <button className={ui.btnSmall} disabled={capture.active} onClick={() => onSettings({ ...settings, captureFolder: '' })}>
                    Use default
                  </button>
                )}
                <button className={ui.btnSmall} onClick={() => api.openCaptureFolder(settings)}>
                  Open
                </button>
              </div>
            </div>
          </div>

          <div className={ui.sectionHeader}>
            DeckLink output
            <span className={ui.sectionMeta}>{decklink.active ? 'playing' : 'off'}</span>
          </div>
          <div className={styles.block}>
            <label className={styles.path}>
              <span className={styles.pathLabel}>Device</span>
              <select value={settings.decklink} onChange={(e) => setDecklinkDevice(e.target.value)}>
                <option value="">Off</option>
                {decklinkChoices.map((name) => (
                  <option key={name} value={name}>
                    {decklink.driver !== null && !decklink.devices.includes(name) ? `${name} (not found)` : name}
                  </option>
                ))}
              </select>
            </label>
            <div className={styles.buttons}>
              <button className={ui.btnSmall} disabled={!!status?.missing} onClick={() => api.emulatorDecklinkRefresh()}>
                Refresh
              </button>
            </div>
            {decklinkNote()}
          </div>
        </section>

        <NvramPanel config={settings} running={running} log={log} />
      </div>

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
    </div>
  )
}
