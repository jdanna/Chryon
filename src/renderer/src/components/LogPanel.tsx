import { MouseEvent, useEffect, useRef, useState } from 'react'
import ui from './ui.module.css'
import styles from './LogPanel.module.css'

export type LogKind = 'info' | 'ok' | 'error'

const OPEN_KEY = 'log-open'

function loadOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) !== 'false'
  } catch {
    return true
  }
}

export interface LogEntry {
  id: number
  text: string
  kind: LogKind
}

export default function LogPanel({ entries, onClear, hidden }: { entries: LogEntry[]; onClear(): void; hidden?: boolean }): JSX.Element {
  const [open, setOpen] = useState(loadOpen)
  const body = useRef<HTMLDivElement>(null)
  const last = entries[entries.length - 1]

  useEffect(() => {
    if (body.current) body.current.scrollTop = body.current.scrollHeight
  }, [entries, open])

  useEffect(() => {
    try {
      localStorage.setItem(OPEN_KEY, String(open))
    } catch {
      // only a convenience, so it's fine if this doesn't persist
    }
  }, [open])

  const clear = (e: MouseEvent): void => {
    e.stopPropagation()
    onClear()
  }

  return (
    <section className={styles.panel} hidden={hidden}>
      <div className={`${ui.sectionHeader} ${styles.header}`} onClick={() => setOpen(!open)}>
        <span className={styles.chevron}>{open ? '▾' : '▸'}</span>
        Log
        {!open && last && <span className={`${ui.sectionMeta} ${styles[last.kind]}`}>{last.text}</span>}
        <span className={ui.spacer} />
        {open && entries.length > 0 && (
          <button className={ui.btnSmall} onClick={clear}>
            Clear
          </button>
        )}
        <button className={ui.btnSmall} aria-expanded={open}>
          {open ? 'Hide' : 'Show'}
        </button>
      </div>
      {open && (
        <div className={styles.body} ref={body}>
          {entries.map((e) => (
            <div key={e.id} className={styles[e.kind]}>
              {e.text}
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
