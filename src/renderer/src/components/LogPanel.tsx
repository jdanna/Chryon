import { useEffect, useRef, useState } from 'react'
import ui from './ui.module.css'
import styles from './LogPanel.module.css'

export type LogKind = 'info' | 'ok' | 'error'

export interface LogEntry {
  id: number
  text: string
  kind: LogKind
}

export default function LogPanel({ entries, onClear }: { entries: LogEntry[]; onClear(): void }): JSX.Element {
  const [open, setOpen] = useState(true)
  const body = useRef<HTMLDivElement>(null)
  const last = entries[entries.length - 1]

  useEffect(() => {
    if (body.current) body.current.scrollTop = body.current.scrollHeight
  }, [entries, open])

  return (
    <section className={styles.panel}>
      <div className={ui.sectionHeader}>
        <button className={styles.toggle} onClick={() => setOpen(!open)}>
          {open ? '▾' : '▸'} Log
        </button>
        {!open && last && <span className={`${ui.sectionMeta} ${styles[last.kind]}`}>{last.text}</span>}
        <span className={ui.spacer} />
        {open && entries.length > 0 && (
          <button className={ui.btnSmall} onClick={onClear}>
            Clear
          </button>
        )}
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
