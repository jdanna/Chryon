import { useEffect, useMemo, useState } from 'react'
import type { FontInfo, FtpConfig, FtpListing, RemoteEntry, UploadProgress } from '@shared/types'
import { errorMessage, formatSize } from '../format'
import FontPreview from './FontPreview'
import type { LogKind } from './LogPanel'
import ui from './ui.module.css'
import styles from './UploadTab.module.css'

const api = window.maxine
const FONT_NAME = /^\.\d{4}$/
const TEST_FONT = /^\.9\d{3}$/

interface FontGroup {
  key: string
  master: string
  name: string
  fonts: FontInfo[]
}

/** Groups by master id and name, since fonts left on the default id share it whatever
 *  their typeface. Newest group first, and smallest code first inside a group. */
function groupFonts(fonts: FontInfo[]): FontGroup[] {
  const groups = new Map<string, FontGroup>()
  for (const f of fonts) {
    const master = f.master ?? '????'
    const key = `${master}|${f.name}`
    if (!groups.has(key)) groups.set(key, { key, master, name: f.name, fonts: [] })
    groups.get(key)!.fonts.push(f)
  }
  for (const group of groups.values()) group.fonts.sort((a, b) => a.file.localeCompare(b.file))
  return [...groups.values()]
}

function groupSummary({ fonts }: FontGroup): string {
  if (fonts.length === 1) return fonts[0].desc
  const sizes = fonts.flatMap((f) => /(\d+) scanlines/.exec(f.desc)?.[1] ?? []).map(Number)
  const range = sizes.length ? ` · ${Math.min(...sizes)}–${Math.max(...sizes)} scanlines` : ''
  return `${fonts.length} variants${range}`
}

interface Props {
  settings: FtpConfig
  onSettings(settings: FtpConfig): void
  fonts: FontInfo[]
  tempDir: string
  refreshFonts(): Promise<FontInfo[]>
  current: string | null
  onCurrent(file: string): void
  log(text: string, kind?: LogKind): void
  setStatus(status: string): void
}

export default function UploadTab(props: Props): JSX.Element {
  const { settings, onSettings, fonts, tempDir, refreshFonts, current, onCurrent, log, setStatus } = props
  const [listing, setListing] = useState<FtpListing | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const [progress, setProgress] = useState<UploadProgress | null>(null)
  const [uploading, setUploading] = useState(false)
  const [expanded, setExpanded] = useState<string[]>([])

  const set = <K extends keyof FtpConfig>(key: K, value: FtpConfig[K]): void => onSettings({ ...settings, [key]: value })

  useEffect(() => api.onUploadProgress(setProgress), [])

  const remote = useMemo(() => new Map((listing?.entries ?? []).map((e) => [e.name, e])), [listing])
  const shown = fonts.find((f) => f.file === current) ?? null
  // With nothing ticked, the highlighted font is the one to send
  const ticked = selected.filter((file) => fonts.some((f) => f.file === file))
  const toUpload = ticked.length ? ticked : shown ? [shown.file] : []
  const allTicked = fonts.length > 0 && ticked.length === fonts.length
  const groups = useMemo(() => groupFonts(fonts), [fonts])

  // One FTP connection stays open from Connect until Disconnect: the unit hung once when a
  // batch upload opened and closed a session per step, so nothing here reconnects to refresh.
  const list = async (): Promise<void> => {
    setConnecting(true)
    setStatus(listing ? `Listing ${settings.host}…` : `Connecting to ${settings.host}…`)
    try {
      const result = await api.ftpList(settings)
      if (!listing) log(`Connected to ${settings.host}: ${result.welcome}`, 'ok')
      setListing(result)
      setStatus(`Connected to ${settings.host}`)
      log(`${result.cwd}: ${result.entries.length} entries`)
    } catch (err) {
      setListing(null)
      setStatus('FTP error')
      log(`FTP failed: ${errorMessage(err)}`, 'error')
    }
    setConnecting(false)
  }

  const disconnect = async (): Promise<void> => {
    await api.ftpDisconnect()
    setListing(null)
    setStatus('Disconnected')
    log(`Disconnected from ${settings.host}`)
  }

  const upload = async (): Promise<void> => {
    setUploading(true)
    setStatus('Uploading…')
    try {
      const result = await api.ftpUpload(settings, toUpload, toUpload.filter((file) => remote.has(file)))
      if (result) {
        for (const f of result.done) {
          log(`Uploaded ${f.name} (${f.size} bytes, size confirmed on the unit)`, 'ok')
        }
        setListing(result.listing)
        setSelected([])
        setStatus('Uploaded. Load one font on the unit and check the CRT.')
      } else {
        setStatus('Ready')
      }
    } catch (err) {
      // The connection is dropped on a failure; the listing may be stale until Refresh
      log(`Upload failed, stopped the batch: ${errorMessage(err)}`, 'error')
      setStatus('Upload failed. Check the unit, then Refresh.')
    }
    setProgress(null)
    setUploading(false)
  }

  const deleteRemote = async (entry: RemoteEntry): Promise<void> => {
    try {
      const result = await api.ftpDelete(settings, entry.name)
      if (result) {
        log(`Deleted ${entry.name} from ${settings.host}`, 'ok')
        setListing(result)
      }
    } catch (err) {
      log(`Delete failed: ${errorMessage(err)}`, 'error')
    }
  }

  const tick = (files: string[], on: boolean): void => {
    setSelected((s) => (on ? [...new Set([...s, ...files])] : s.filter((f) => !files.includes(f))))
  }

  const toggleGroup = (group: FontGroup): void => {
    setExpanded((keys) => (keys.includes(group.key) ? keys.filter((k) => k !== group.key) : [...keys, group.key]))
    if (!group.fonts.some((f) => f.file === current)) onCurrent(group.fonts[0].file)
  }

  const afterDelete = async (files: string[]): Promise<void> => {
    setSelected((s) => s.filter((f) => !files.includes(f)))
    const remaining = await refreshFonts()
    if (current && files.includes(current)) onCurrent(remaining[0]?.file ?? '')
  }

  const deleteLocal = async (file: string): Promise<void> => {
    await api.deleteFont(file)
    await afterDelete([file])
  }

  const deleteTicked = async (): Promise<void> => {
    try {
      if (!(await api.deleteFonts(ticked))) return
      log(`Deleted ${ticked.join(', ')} from the temp folder`, 'ok')
      await afterDelete(ticked)
    } catch (err) {
      log(`Delete failed: ${errorMessage(err)}`, 'error')
    }
  }

  return (
    <div className={styles.layout}>
      <aside className={styles.connection}>
        <div className={ui.sectionHeader}>Connection</div>
        <div className={ui.fields}>
          <label className={ui.field}>
            Host or IP
            <input type="text" placeholder="192.168.1.50" value={settings.host} onChange={(e) => set('host', e.target.value)} />
          </label>
          <label className={ui.field}>
            Port
            <input type="number" value={settings.port} onChange={(e) => set('port', Number(e.target.value))} />
          </label>
          <label className={ui.field} title="Seconds to wait after each font">
            Pause between fonts
            <input type="number" min={0} max={600} value={settings.pause} onChange={(e) => set('pause', Number(e.target.value))} />
          </label>
          <label className={ui.field} title="Upload speed limit in Mbit/s. Never goes above 10.">
            Max speed, Mbit/s
            <input type="number" min={0.1} max={10} step={0.1} value={settings.speed} onChange={(e) => set('speed', Number(e.target.value))} />
          </label>
          <label className={ui.field} title="Milliseconds to wait after each reply from the unit before the next FTP command">
            Command pause, ms
            <input type="number" min={0} max={5000} step={50} value={settings.gap} onChange={(e) => set('gap', Number(e.target.value))} />
          </label>
        </div>
        <div className={styles.connectBar}>
          <button className={`${ui.btnPrimary} ${styles.connectButton}`} disabled={connecting || uploading || !settings.host.trim()} onClick={list}>
            {connecting ? (listing ? 'Listing…' : 'Connecting…') : listing ? 'Refresh' : 'Connect'}
          </button>
          {listing && (
            <button className={`${ui.btn} ${styles.connectButton}`} disabled={connecting || uploading} onClick={disconnect}>
              Disconnect
            </button>
          )}
        </div>
        <div className={ui.hint}>
          Load one font at a time on the unit. If it fails to load, hangs or crashes, stop and note which file.
        </div>
      </aside>

      <section className={styles.local}>
        <div className={ui.sectionHeader}>
          Converted fonts
          <span className={ui.sectionMeta} title={tempDir}>
            temp folder, cleared by the OS
          </span>
          <span className={ui.spacer} />
          <button className={ui.btnSmall} onClick={() => api.openTempFolder()}>
            Open folder
          </button>
        </div>
        <div className={styles.listBar}>
          <label className={ui.check}>
            <TickBox
              checked={allTicked}
              partial={ticked.length > 0}
              disabled={fonts.length === 0}
              onChange={(on) => setSelected(on ? fonts.map((f) => f.file) : [])}
            />
            Select all
          </label>
          {ticked.length > 0 && <span className={styles.selectedCount}>{ticked.length} selected</span>}
          <span className={ui.spacer} />
          <button className={ui.btnSmall} disabled={ticked.length === 0} onClick={deleteTicked}>
            Delete selected
          </button>
        </div>
        <div className={styles.table}>
          {fonts.length === 0 && <div className={ui.empty}>Nothing converted yet. Fonts from the Convert tab appear here.</div>}
          {groups.map((group) => {
            const open = expanded.includes(group.key)
            const files = group.fonts.map((f) => f.file)
            const tickedHere = files.filter((file) => ticked.includes(file)).length
            const onUnit = files.filter((file) => remote.has(file)).length
            const total = group.fonts.reduce((sum, f) => sum + f.size, 0)
            return (
              <div key={group.key}>
                <div className={files.includes(current ?? '') ? styles.groupRowActive : styles.groupRow} onClick={() => toggleGroup(group)}>
                  <button className={styles.twirl} aria-expanded={open} aria-label={`${open ? 'Hide' : 'Show'} variants of ${group.name}`}>
                    <svg viewBox="0 0 12 12" aria-hidden="true">
                      <path d="M3 1 L10.5 6 L3 11 Z" fill="currentColor" />
                    </svg>
                  </button>
                  <span onClick={(e) => e.stopPropagation()} className={styles.tickCell}>
                    <TickBox
                      label={`Select all ${group.name}`}
                      checked={tickedHere === files.length}
                      partial={tickedHere > 0}
                      onChange={(on) => tick(files, on)}
                    />
                  </span>
                  <span className={`${ui.mono} ${styles.code}`}>{group.master}</span>
                  <span className={styles.names}>
                    <span className={styles.name}>{group.name}</span>
                    <span className={styles.desc}>{groupSummary(group)}</span>
                  </span>
                  {onUnit > 0 && <span className={styles.onUnit}>{onUnit === files.length ? 'On unit' : `${onUnit} of ${files.length} on unit`}</span>}
                  <span className={styles.size}>{formatSize(total)}</span>
                </div>
                {open &&
                  group.fonts.map((f) => (
                    <div key={f.file} className={f.file === current ? styles.rowActive : styles.row} onClick={() => onCurrent(f.file)}>
                      <input
                        type="checkbox"
                        aria-label={`Select ${f.file}`}
                        checked={selected.includes(f.file)}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => tick([f.file], e.target.checked)}
                      />
                      <span className={`${ui.mono} ${styles.code}`}>{f.file}</span>
                      <span className={styles.variantDesc}>{f.desc}</span>
                      <OnUnit font={f} remote={remote.get(f.file)} />
                      <span className={styles.size}>{formatSize(f.size)}</span>
                      <button
                        className={ui.btnSmall}
                        onClick={(e) => {
                          e.stopPropagation()
                          deleteLocal(f.file)
                        }}
                      >
                        Delete
                      </button>
                    </div>
                  ))}
              </div>
            )
          })}
        </div>
        <div className={styles.previewPane}>
          <FontPreview font={shown} empty="Select a font to preview it." />
        </div>
        <div className={styles.actionBar}>
          <button className={ui.btnPrimary} disabled={!toUpload.length || uploading || !listing} onClick={upload}>
            {toUpload.length > 1 ? `Upload ${toUpload.length} fonts` : `Upload ${toUpload[0] ?? ''}`}
          </button>
          {progress ? (
            <>
              <span className={`${ui.mono} ${styles.progressName}`}>{progress.name}</span>
              {progress.wait !== undefined && <span className={styles.actionHint}>sent, waiting {progress.wait} s before the next transfer</span>}
              <div className={styles.progressTrack}>
                <div className={styles.progressFill} style={{ width: `${(progress.sent / progress.total) * 100}%` }} />
              </div>
            </>
          ) : (
            !listing && <span className={styles.actionHint}>Connect to the unit first.</span>
          )}
        </div>
      </section>

      <section className={styles.remote}>
        <div className={ui.sectionHeader}>
          On the MAXINE!
          {listing && <span className={ui.sectionMeta}>{listing.cwd}</span>}
        </div>
        <div className={styles.table}>
          {!listing && <div className={ui.empty}>Not connected.</div>}
          {listing && listing.entries.length === 0 && <div className={ui.empty}>This folder is empty.</div>}
          {listing?.entries.map((e) => (
            <div key={e.name} className={FONT_NAME.test(e.name) ? styles.remoteRow : styles.remoteRowDim}>
              <span className={`${ui.mono} ${styles.remoteName}`}>
                {e.name}
                {e.dir ? '/' : ''}
              </span>
              <span className={styles.size}>{formatSize(e.size)}</span>
              {TEST_FONT.test(e.name) && (
                <button className={ui.btnSmall} onClick={() => deleteRemote(e)}>
                  Delete
                </button>
              )}
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}

interface TickBoxProps {
  checked: boolean
  partial: boolean
  disabled?: boolean
  label?: string
  onChange(on: boolean): void
}

/** A checkbox that shows a dash when only some of what it covers is ticked. */
function TickBox({ checked, partial, disabled, label, onChange }: TickBoxProps): JSX.Element {
  return (
    <input
      type="checkbox"
      aria-label={label}
      checked={checked}
      disabled={disabled}
      ref={(el) => {
        if (el) el.indeterminate = partial && !checked
      }}
      onChange={() => onChange(!checked)}
    />
  )
}

function OnUnit({ font, remote }: { font: FontInfo; remote?: RemoteEntry }): JSX.Element | null {
  if (!remote) return null
  const same = remote.size === font.size
  return (
    <span className={same ? styles.onUnit : styles.onUnitDiffers} title={same ? undefined : `Unit has ${remote.size} bytes, this file is ${font.size}`}>
      {same ? 'On unit' : 'Differs'}
    </span>
  )
}
