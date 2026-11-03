import { useEffect, useRef, useState } from 'react'
import ui from '@renderer/components/ui.module.css'
import Landing from './Landing'
import { machine, onSpeed, onState, onStatus } from './machine'
import Screen from './Screen'
import { hasSavedDisk } from './store'
import styles from './WebApp.module.css'

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export default function WebApp(): JSX.Element {
  const [running, setRunning] = useState(false)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const [saved, setSaved] = useState(false)
  const [speed, setSpeed] = useState<number | null>(null)
  const [videoInput, setVideoInput] = useState('')
  const screen = useRef<HTMLCanvasElement>(null)
  const picker = useRef<HTMLInputElement>(null)

  useEffect(() => {
    onStatus(setStatus)
    onState(setRunning)
    onSpeed(setSpeed)
    hasSavedDisk().then(setSaved, () => {})
  }, [])

  const start = async (): Promise<void> => {
    setBusy(true)
    try {
      await machine.start(screen.current!)
      setStatus('')
      screen.current!.focus()
    } catch (err) {
      setStatus(errorText(err))
    }
    setBusy(false)
  }

  const stop = async (): Promise<void> => {
    setBusy(true)
    setStatus('Saving…')
    await machine.stop()
  }

  const chooseVideoInput = async (file: File | null): Promise<void> => {
    try {
      await machine.videoInput(file)
      setVideoInput(file?.name ?? '')
      setStatus(file ? `Video input: ${file.name}. In Message Compose, CNTL then I shows it.` : 'No video input')
    } catch (err) {
      setStatus(errorText(err))
    }
    screen.current?.focus()
  }

  const reset = async (): Promise<void> => {
    if (confirm('Go back to the original disk? This deletes your saved messages and settings.')) await machine.reset()
  }

  return (
    <div className={styles.app}>
      <header className={styles.bar}>
        <span className={styles.name}>MAXINE!</span>
        <span className={`${ui.mono} ${styles.version}`}>v{__APP_VERSION__}</span>
        <button className={ui.btnSmall} disabled={busy} onClick={stop}>
          Stop
        </button>
        <button className={ui.btnSmall} disabled={busy} onClick={reset}>
          Reset…
        </button>
        <button className={ui.btnSmall} disabled={busy || !running} onClick={() => picker.current?.click()} title={videoInput || undefined}>
          Video in…
        </button>
        {videoInput && (
          <button className={ui.btnSmall} disabled={busy || !running} onClick={() => chooseVideoInput(null)}>
            Clear video
          </button>
        )}
        <input
          ref={picker}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => {
            const file = e.currentTarget.files?.[0] ?? null
            e.currentTarget.value = ''
            if (file) void chooseVideoInput(file)
          }}
        />
        <span className={styles.status}>{status}</span>
        {speed !== null && <span className={`${ui.mono} ${styles.speed}`}>{speed}%</span>}
      </header>
      <Screen ref={screen} />
      {!running && <Landing busy={busy} status={status} saved={saved} onStart={start} onReset={reset} />}
    </div>
  )
}
