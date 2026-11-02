import { useCallback, useEffect, useMemo, useState } from 'react'
import type { EmulatorConfig } from '@shared/types'
import { fieldError, NVRAM_FIELDS, NvramField, nvramDefaults, readField, writeField } from '@shared/nvram'
import { errorMessage } from '../format'
import type { LogKind } from './LogPanel'
import ui from './ui.module.css'
import styles from './NvramPanel.module.css'

const api = window.maxine
const GROUPS = [...new Set(NVRAM_FIELDS.map((f) => f.group))]

interface Props {
  config: EmulatorConfig
  running: boolean
  log(text: string, kind?: LogKind): void
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.every((byte, i) => byte === b[i])
}

function FieldInput({ field, value, disabled, onChange }: { field: NvramField; value: string; disabled: boolean; onChange(text: string): void }): JSX.Element {
  if (field.kind === 'flag') {
    return <input type="checkbox" checked={value !== '0'} disabled={disabled} onChange={(e) => onChange(e.target.checked ? '1' : '0')} />
  }
  if (field.kind === 'nibble' && field.options) {
    const known = field.options.some(([v]) => String(v) === value)
    return (
      <select value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
        {!known && <option value={value}>Value {value}</option>}
        {field.options.map(([v, label]) => (
          <option key={v} value={String(v)}>
            {label}
          </option>
        ))}
      </select>
    )
  }
  return <input type="text" className={ui.mono} spellCheck={false} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} />
}

/** Edits a copy of the file. Nothing reaches the disk until Save, and a field with
 *  bad text keeps it on screen and blocks Save without touching the copy. */
export default function NvramPanel({ config, running, log }: Props): JSX.Element {
  const [saved, setSaved] = useState<Uint8Array | null>(null)
  const [exists, setExists] = useState(false)
  const [draft, setDraft] = useState<Uint8Array>(nvramDefaults)
  const [texts, setTexts] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    try {
      const file = await api.readNvram(config)
      const data = file.data ? new Uint8Array(file.data) : nvramDefaults()
      setExists(file.exists)
      setSaved(data)
      setDraft(data.slice())
      setTexts({})
    } catch (err) {
      log(`Could not read NVRAM: ${errorMessage(err)}`, 'error')
    }
  }, [config, log])

  // The emulator rewrites the file as it exits, so stopping has to reload it
  useEffect(() => {
    if (!running) load()
  }, [running, load])

  const errors = useMemo(() => {
    const found: Record<string, string> = {}
    for (const field of NVRAM_FIELDS) {
      const text = texts[field.id]
      const error = text === undefined ? null : fieldError(field, text)
      if (error) found[field.id] = error
    }
    return found
  }, [texts])

  const invalid = Object.keys(errors).length > 0
  const changed = saved !== null && !sameBytes(saved, draft)

  const edit = (field: NvramField, text: string): void => {
    setTexts((all) => ({ ...all, [field.id]: text }))
    if (fieldError(field, text)) return
    const next = draft.slice()
    writeField(next, field, text)
    setDraft(next)
  }

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      await api.writeNvram(config, draft)
      log('Saved NVRAM.', 'ok')
      await load()
    } catch (err) {
      log(`Could not save NVRAM: ${errorMessage(err)}`, 'error')
    }
    setSaving(false)
  }

  return (
    <section className={styles.panel}>
      <div className={ui.sectionHeader}>
        NVRAM
        <span className={ui.sectionMeta}>{exists ? '' : 'no file yet'}</span>
        <span className={ui.spacer} />
        <button className={ui.btnSmall} disabled={running || !changed} onClick={load}>
          Revert
        </button>
        <button className={ui.btnSmall} disabled={running || saving || !changed || invalid} onClick={save}>
          Save
        </button>
      </div>
      <div className={styles.scroll}>
        {running ? (
          <div className={`${ui.hint} ${ui.hintWarn}`}>Stop the emulator to edit. It rewrites this file when it exits.</div>
        ) : (
          !exists && <div className={ui.hint}>These are the defaults. The first run or a Save creates the file.</div>
        )}
        {GROUPS.map((group) => (
          <div key={group}>
            <div className={styles.group}>{group}</div>
            <div className={ui.fields}>
              {NVRAM_FIELDS.filter((f) => f.group === group).map((field) => (
                <div key={field.id} className={styles.row}>
                  <label className={ui.field} title={`$${field.offset.toString(16).padStart(4, '0')}`}>
                    {field.label}
                    <FieldInput field={field} value={texts[field.id] ?? readField(draft, field)} disabled={running} onChange={(text) => edit(field, text)} />
                  </label>
                  {errors[field.id] ? (
                    <span className={styles.error}>{errors[field.id]}</span>
                  ) : (
                    field.hint && <span className={styles.note}>{field.hint}</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}
