import { useEffect, useMemo, useState } from 'react'
import type { ConvertSettings, EdgeStyle, FontInfo, FontSource, SystemFont } from '@shared/types'
import { errorMessage, formatSize } from '../format'
import FontPreview from './FontPreview'
import type { LogKind } from './LogPanel'
import ui from './ui.module.css'
import styles from './ConvertTab.module.css'

const api = window.maxine

interface Props {
  settings: ConvertSettings
  onSettings(settings: ConvertSettings): void
  fonts: FontInfo[]
  refreshFonts(): Promise<FontInfo[]>
  source: FontSource | null
  onSource(source: FontSource): void
  onPickFile(path: string): void
  current: string | null
  onCurrent(file: string): void
  onUpload(): void
  log(text: string, kind?: LogKind): void
  setStatus(status: string): void
}

export default function ConvertTab(props: Props): JSX.Element {
  const { settings, onSettings, fonts, refreshFonts, source, onSource, onPickFile, current, onCurrent, onUpload, log, setStatus } = props
  const [systemFonts, setSystemFonts] = useState<SystemFont[] | null>(null)
  const [search, setSearch] = useState('')
  const [name, setName] = useState('')
  const [nameEdited, setNameEdited] = useState(false)
  const [busy, setBusy] = useState(false)

  const set = <K extends keyof ConvertSettings>(key: K, value: ConvertSettings[K]): void => onSettings({ ...settings, [key]: value })

  useEffect(() => {
    api.systemFonts().then(
      (list) => {
        setSystemFonts(list)
        log(`${list.length} installed font faces found.`)
      },
      (err) => {
        setSystemFonts([])
        log(`Font scan failed: ${errorMessage(err)}`, 'error')
      }
    )
  }, [log])

  useEffect(() => {
    if (!nameEdited) setName(source?.name ?? '')
  }, [source, nameEdited])

  const visible = useMemo(() => {
    const q = search.toLowerCase()
    return (systemFonts ?? []).filter((f) => f.name.toLowerCase().includes(q))
  }, [systemFonts, search])

  const shown = fonts.find((f) => f.file === current) ?? null
  const codeValid = /^\d{4}$/.test(settings.code)
  const replaces = fonts.some((f) => f.file === `.${settings.code}`)

  const pick = async (): Promise<void> => {
    const path = await api.pickFont()
    if (path) onPickFile(path)
  }

  const convert = async (): Promise<void> => {
    if (!source) return
    setBusy(true)
    setStatus('Converting…')
    try {
      const { font, log: lines } = await api.convert({ ...settings, ttf: source.path, index: source.index, name })
      lines.forEach((line) => log(line))
      log(`Converted ${font.file} (${formatSize(font.size)})`, 'ok')
      await refreshFonts()
      onCurrent(font.file)
      setStatus('Converted, not yet tested on hardware')
    } catch (err) {
      log(`Conversion failed: ${errorMessage(err)}`, 'error')
      setStatus('Conversion failed')
    }
    setBusy(false)
  }

  const exportFont = async (): Promise<void> => {
    if (!shown) return
    try {
      const dest = await api.exportFont(shown.file)
      if (dest) log(`Exported ${dest} (a dotfile, so Finder and Explorer may hide it)`, 'ok')
    } catch (err) {
      log(`Export failed: ${errorMessage(err)}`, 'error')
    }
  }

  return (
    <div className={styles.layout}>
      <aside className={styles.sources}>
        <div className={ui.sectionHeader}>
          Source font
          <span className={ui.spacer} />
          <button className={ui.btnSmall} onClick={pick}>
            Choose file…
          </button>
        </div>
        <div className={styles.search}>
          <input type="text" placeholder="Filter installed fonts…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <div className={styles.fontList}>
          {systemFonts === null && <div className={ui.empty}>Scanning installed fonts…</div>}
          {visible.map((f) => (
            <button
              key={`${f.path}#${f.index}`}
              className={source?.path === f.path && source.index === f.index ? styles.fontRowActive : styles.fontRow}
              title={f.path}
              onClick={() => onSource(f)}
            >
              {f.name}
            </button>
          ))}
        </div>
        <div className={ui.hint}>Or drop a .ttf, .otf or .ttc anywhere in this window.</div>
      </aside>

      <main className={styles.preview}>
        <div className={ui.sectionHeader}>
          Preview
          {shown && (
            <span className={ui.sectionMeta}>
              <span className={ui.mono}>{shown.file}</span> · {shown.name} · {shown.desc}
            </span>
          )}
          <span className={ui.spacer} />
          <button className={ui.btnSmall} disabled={!shown} onClick={exportFont}>
            Export…
          </button>
          <button className={ui.btnSmall} disabled={!shown} onClick={onUpload}>
            Upload →
          </button>
        </div>
        <FontPreview font={shown} empty="Convert a font to see what the MAXINE should display. Face in white, border and shadow in red." />
        <div className={styles.stats}>
          <Stat label="Glyphs" value={shown?.glyphs} />
          <Stat label="Kern pairs" value={shown?.kern} />
          <Stat label="Cell rows" value={shown?.cell_rows} />
          <Stat label="Ascent" value={shown?.ascent} />
          <Stat label="Descent" value={shown?.descent} />
          <Stat label="Baseline" value={shown?.baseline_row} />
          <Stat label="Size" value={shown ? formatSize(shown.size) : undefined} />
        </div>
      </main>

      <aside className={styles.inspector}>
        <div className={ui.sectionHeader}>Output</div>
        <div className={ui.fields}>
          <label className={`${ui.field} ${ui.fieldWide}`} title="Shown in the MAXINE font browser">
            Display name
            <input
              type="text"
              maxLength={59}
              value={name}
              onChange={(e) => {
                setName(e.target.value)
                setNameEdited(e.target.value !== '')
              }}
            />
          </label>
          {source?.faces && source.faces.length > 1 && (
            <label className={`${ui.field} ${ui.fieldWide}`}>
              Face
              <select
                value={source.index}
                onChange={(e) => onSource({ ...source, index: Number(e.target.value), name: source.faces![Number(e.target.value)] })}
              >
                {source.faces.map((face, i) => (
                  <option key={i} value={i}>
                    {face}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className={ui.field} title="The file is named after this code, and it's stamped into the header">
            Font code
            <input className={ui.mono} type="text" maxLength={4} value={settings.code} onChange={(e) => set('code', e.target.value)} />
          </label>
          <label className={ui.field} title="Nominal height in rows">
            Scanlines
            <input type="number" min={10} max={200} value={settings.scanlines} onChange={(e) => set('scanlines', Number(e.target.value))} />
          </label>
        </div>

        <div className={ui.sectionHeader}>Edge</div>
        <div className={`${ui.fields} ${styles.edgeFields}`}>
          <label className={ui.field}>
            Style
            <select value={settings.edge} onChange={(e) => set('edge', e.target.value as EdgeStyle)}>
              <option value="none">No edge</option>
              <option value="border">Border</option>
              <option value="shadow">Border &amp; shadow</option>
            </select>
          </label>
          <label className={ui.field}>
            Lines
            <input
              type="number"
              min={1}
              max={10}
              disabled={settings.edge === 'none'}
              value={settings.lines}
              onChange={(e) => set('lines', Number(e.target.value))}
            />
          </label>
        </div>

        <div className={ui.sectionHeader}>Spacing</div>
        <div className={ui.fields}>
          <label className={ui.field} title="Horizontal pixels per row. 1.17 was measured from Swiss 721 Bold.">
            Pixel aspect
            <input type="number" step={0.01} value={settings.aspect} onChange={(e) => set('aspect', Number(e.target.value))} />
          </label>
          <label className={ui.field} title="Advance width multiplier. The originals run tighter than the Bitstream metrics.">
            Advance scale
            <input type="number" step={0.01} value={settings.spacing} onChange={(e) => set('spacing', Number(e.target.value))} />
          </label>
          <label className={ui.field} title="4-digit master font id written to the header">
            Master id
            <input className={ui.mono} type="text" maxLength={4} value={settings.masterId} onChange={(e) => set('masterId', e.target.value)} />
          </label>
          <label className={ui.check}>
            <input type="checkbox" checked={settings.kern} onChange={(e) => set('kern', e.target.checked)} />
            Copy pair kerning from the font
          </label>
        </div>

        <div className={styles.convertBar}>
          {!codeValid && <div className={`${ui.hint} ${ui.hintWarn}`}>The font code must be exactly 4 digits.</div>}
          {codeValid && !settings.code.startsWith('9') && (
            <div className={`${ui.hint} ${ui.hintWarn}`}>Real fonts use codes below 9000. Stick to 9xxx so nothing collides on the unit.</div>
          )}
          {codeValid && settings.code.startsWith('9') && replaces && (
            <div className={ui.hint}>Replaces the existing .{settings.code} in the temp folder.</div>
          )}
          <button className={`${ui.btnPrimary} ${styles.convertButton}`} disabled={!source || !codeValid || busy} onClick={convert}>
            {busy ? 'Converting…' : `Convert to .${settings.code}`}
          </button>
        </div>
      </aside>
    </div>
  )
}

function Stat({ label, value }: { label: string; value?: number | string }): JSX.Element {
  return (
    <div className={styles.stat}>
      <span className={styles.statLabel}>{label}</span>
      <span className={styles.statValue}>{value ?? '—'}</span>
    </div>
  )
}
