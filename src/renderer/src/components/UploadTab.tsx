import { useEffect, useMemo, useState } from 'react'
import type { FontInfo, FtpConfig, FtpListing, FtpSettings, RemoteEntry, UploadProgress } from '@shared/types'
import { errorMessage, formatSize } from '../format'
import FontPreview from './FontPreview'
import type { LogKind } from './LogPanel'
import ui from './ui.module.css'
import styles from './UploadTab.module.css'

const api = window.maxine
const FONT_NAME = /^\.\d{4}$/
const TEST_FONT = /^\.9\d{3}$/

interface Props {
  settings: FtpSettings
  onSettings(settings: FtpSettings): void
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

  const set = <K extends keyof FtpSettings>(key: K, value: FtpSettings[K]): void => onSettings({ ...settings, [key]: value })
  const { remember: _remember, ...cfg } = settings
  const config: FtpConfig = cfg

  useEffect(() => api.onUploadProgress(setProgress), [])

  const remote = useMemo(() => new Map((listing?.entries ?? []).map((e) => [e.name, e])), [listing])
  const shown = fonts.find((f) => f.file === current) ?? null
  // With nothing ticked, the highlighted font is the one to send
  const ticked = selected.filter((file) => fonts.some((f) => f.file === file))
  const toUpload = ticked.length ? ticked : shown ? [shown.file] : []

  const list = async (): Promise<FtpListing | null> => {
    setConnecting(true)
    setStatus(`Connecting to ${settings.host}…`)
    try {
      const result = await api.ftpList(config)
      setListing(result)
      setStatus(`Connected to ${settings.host}`)
      log(`Connected to ${settings.host}: ${result.welcome}`, 'ok')
      log(`${result.cwd}: ${result.entries.length} entries`)
      setConnecting(false)
      return result
    } catch (err) {
      setListing(null)
      setStatus('FTP error')
      log(`FTP failed: ${errorMessage(err)}`, 'error')
      setConnecting(false)
      return null
    }
  }

  const upload = async (): Promise<void> => {
    setUploading(true)
    setStatus('Uploading…')
    try {
      const done = await api.ftpUpload(config, toUpload, toUpload.filter((file) => remote.has(file)))
      if (done) {
        for (const f of done) {
          log(`Uploaded ${f.name} (${f.local_size} bytes${f.remote_size === null ? ', unit did not report a size' : ''})`, 'ok')
        }
        setSelected([])
        setStatus('Uploaded. Load one font on the unit and check the CRT.')
        await list()
      } else {
        setStatus('Ready')
      }
    } catch (err) {
      log(`Upload failed, stopped the batch: ${errorMessage(err)}`, 'error')
      setStatus('Upload failed')
      await list()
    }
    setProgress(null)
    setUploading(false)
  }

  const deleteRemote = async (entry: RemoteEntry): Promise<void> => {
    try {
      if (await api.ftpDelete(config, entry.name)) {
        log(`Deleted ${entry.name} from ${settings.host}`, 'ok')
        await list()
      }
    } catch (err) {
      log(`Delete failed: ${errorMessage(err)}`, 'error')
    }
  }

  const deleteLocal = async (file: string): Promise<void> => {
    await api.deleteFont(file)
    setSelected((s) => s.filter((f) => f !== file))
    await refreshFonts()
  }

  return (
    <div className={styles.layout}>
      <aside className={styles.connection}>
        <div className={ui.sectionHeader}>Connection</div>
        <div className={ui.fields}>
          <label className={`${ui.field} ${ui.fieldWide}`}>
            Host or IP
            <input type="text" placeholder="192.168.1.50" value={settings.host} onChange={(e) => set('host', e.target.value)} />
          </label>
          <label className={ui.field}>
            User
            <input type="text" value={settings.user} onChange={(e) => set('user', e.target.value)} />
          </label>
          <label className={ui.field}>
            Port
            <input type="number" value={settings.port} onChange={(e) => set('port', Number(e.target.value))} />
          </label>
          <label className={`${ui.field} ${ui.fieldWide}`}>
            Password
            <input type="password" value={settings.password} onChange={(e) => set('password', e.target.value)} />
          </label>
          <label className={`${ui.field} ${ui.fieldWide}`}>
            Remote folder
            <input type="text" placeholder="/" value={settings.dir} onChange={(e) => set('dir', e.target.value)} />
          </label>
          <label className={ui.check} title="Untick if the old server only does active mode">
            <input type="checkbox" checked={settings.passive} onChange={(e) => set('passive', e.target.checked)} />
            Passive mode
          </label>
          <label className={ui.check} title="Stored encrypted in your system keychain">
            <input type="checkbox" checked={settings.remember} onChange={(e) => set('remember', e.target.checked)} />
            Remember password
          </label>
        </div>
        <div className={styles.connectBar}>
          <button className={`${ui.btnPrimary} ${styles.connectButton}`} disabled={connecting || !settings.host.trim()} onClick={list}>
            {connecting ? 'Connecting…' : listing ? 'Refresh' : 'Connect'}
          </button>
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
        <div className={styles.table}>
          {fonts.length === 0 && <div className={ui.empty}>Nothing converted yet. Fonts from the Convert tab appear here.</div>}
          {fonts.map((f) => (
            <div key={f.file} className={f.file === current ? styles.rowActive : styles.row} onClick={() => onCurrent(f.file)}>
              <input
                type="checkbox"
                aria-label={`Select ${f.file}`}
                checked={selected.includes(f.file)}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => setSelected((s) => (e.target.checked ? [...s, f.file] : s.filter((x) => x !== f.file)))}
              />
              <span className={`${ui.mono} ${styles.code}`}>{f.file}</span>
              <span className={styles.names}>
                <span className={styles.name}>{f.name}</span>
                <span className={styles.desc}>{f.desc}</span>
              </span>
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
          On the MAXINE
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
              <span className={styles.date}>{e.date}</span>
              <span className={styles.size}>{e.size === null ? '' : formatSize(e.size)}</span>
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

function OnUnit({ font, remote }: { font: FontInfo; remote?: RemoteEntry }): JSX.Element | null {
  if (!remote) return null
  const same = remote.size === null || remote.size === font.size
  return (
    <span className={same ? styles.onUnit : styles.onUnitDiffers} title={same ? undefined : `Unit has ${remote.size} bytes, this file is ${font.size}`}>
      {same ? 'On unit' : 'Differs'}
    </span>
  )
}
