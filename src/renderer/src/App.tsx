import { useCallback, useEffect, useRef, useState } from 'react'
import type { FontInfo, FontSource, Settings } from '@shared/types'
import ConvertTab from './components/ConvertTab'
import EmulatorTab from './components/EmulatorTab'
import LogPanel, { LogEntry, LogKind } from './components/LogPanel'
import TopBar, { Tab } from './components/TopBar'
import UploadTab from './components/UploadTab'
import { errorMessage, FONT_EXTENSIONS } from './format'
import styles from './App.module.css'

const api = window.maxine
const SETTINGS_SAVE_DELAY_MS = 300

export default function App(): JSX.Element {
  const [tab, setTab] = useState<Tab>('convert')
  const [settings, setSettings] = useState<Settings | null>(null)
  const [status, setStatus] = useState('Ready')
  const [log, setLog] = useState<LogEntry[]>([])
  const [fonts, setFonts] = useState<FontInfo[]>([])
  const [tempDir, setTempDir] = useState('')
  const [source, setSource] = useState<FontSource | null>(null)
  const [current, setCurrent] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const logId = useRef(0)

  const addLog = useCallback((text: string, kind: LogKind = 'info') => {
    setLog((entries) => [...entries, { id: ++logId.current, text, kind }])
  }, [])

  const refreshFonts = useCallback(async (): Promise<FontInfo[]> => {
    try {
      const { dir, files } = await api.outputs()
      setTempDir(dir)
      setFonts(files)
      return files
    } catch (err) {
      addLog(`Could not list converted fonts: ${errorMessage(err)}`, 'error')
      return []
    }
  }, [addLog])

  useEffect(() => {
    api.loadSettings().then(setSettings)
    refreshFonts().then((files) => setCurrent((file) => file ?? files[0]?.file ?? null))
  }, [refreshFonts])

  useEffect(() => {
    if (!settings) return
    const timer = setTimeout(() => api.saveSettings(settings), SETTINGS_SAVE_DELAY_MS)
    return () => clearTimeout(timer)
  }, [settings])

  const openFontFile = useCallback(
    async (path: string) => {
      try {
        const faces = await api.fontFaces(path)
        setSource({ path, index: 0, name: faces[0] ?? '', faces })
        setTab('convert')
      } catch (err) {
        addLog(`Could not read ${path}: ${errorMessage(err)}`, 'error')
      }
    },
    [addLog]
  )

  useEffect(() => {
    const over = (e: DragEvent): void => {
      e.preventDefault()
      setDragging(true)
    }
    const leave = (e: DragEvent): void => {
      if (!e.relatedTarget) setDragging(false)
    }
    const drop = (e: DragEvent): void => {
      e.preventDefault()
      setDragging(false)
      const file = e.dataTransfer?.files[0]
      if (!file) return
      if (FONT_EXTENSIONS.test(file.name)) openFontFile(api.pathForFile(file))
      else addLog(`${file.name} is not a .ttf, .otf or .ttc font.`, 'error')
    }
    window.addEventListener('dragover', over)
    window.addEventListener('dragleave', leave)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragover', over)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('drop', drop)
    }
  }, [addLog, openFontFile])

  if (!settings) return <div className={styles.app} />

  return (
    <div className={styles.app}>
      <TopBar tab={tab} onTab={setTab} status={status} fontCount={fonts.length} />
      <div className={styles.workspace}>
        <div className={styles.tabView} hidden={tab !== 'convert'}>
          <ConvertTab
            settings={settings.convert}
            onSettings={(convert) => setSettings({ ...settings, convert })}
            fonts={fonts}
            refreshFonts={refreshFonts}
            source={source}
            onSource={setSource}
            onPickFile={openFontFile}
            current={current}
            onCurrent={setCurrent}
            onUpload={() => setTab('upload')}
            log={addLog}
            setStatus={setStatus}
          />
        </div>
        <div className={styles.tabView} hidden={tab !== 'upload'}>
          <UploadTab
            settings={settings.ftp}
            onSettings={(ftp) => setSettings({ ...settings, ftp })}
            fonts={fonts}
            tempDir={tempDir}
            refreshFonts={refreshFonts}
            current={current}
            onCurrent={setCurrent}
            log={addLog}
            setStatus={setStatus}
          />
        </div>
        <div className={styles.tabView} hidden={tab !== 'emulator'}>
          <EmulatorTab settings={settings.emulator} onSettings={(emulator) => setSettings({ ...settings, emulator })} log={addLog} setStatus={setStatus} />
        </div>
      </div>
      <LogPanel entries={log} onClear={() => setLog([])} />
      {dragging && (
        <div className={styles.dropOverlay}>
          <span className={styles.dropLabel}>Drop a .ttf, .otf or .ttc font</span>
        </div>
      )}
    </div>
  )
}
