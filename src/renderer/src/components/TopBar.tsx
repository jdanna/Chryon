import ui from './ui.module.css'
import styles from './TopBar.module.css'

export type Tab = 'convert' | 'upload' | 'emulator'

interface Props {
  tab: Tab
  onTab(tab: Tab): void
  status: string
  fontCount: number
}

export default function TopBar({ tab, onTab, status, fontCount }: Props): JSX.Element {
  return (
    <header className={styles.topbar}>
      <div className={styles.left}>
        {window.maxine.platform === 'darwin' && <div className={styles.trafficLightSpacer} />}
        <nav className={styles.tabs}>
          <button className={tab === 'convert' ? styles.tabActive : styles.tab} onClick={() => onTab('convert')}>
            Convert
          </button>
          <button className={tab === 'upload' ? styles.tabActive : styles.tab} onClick={() => onTab('upload')}>
            Upload
            {fontCount > 0 && <span className={`${ui.mono} ${styles.count}`}>{fontCount}</span>}
          </button>
          <button className={tab === 'emulator' ? styles.tabActive : styles.tab} onClick={() => onTab('emulator')}>
            Emulator
          </button>
        </nav>
      </div>
      <div className={styles.title}>
        <span className={styles.appName}>MAXINE! Studio</span>
        <span className={styles.meta}>{status}</span>
      </div>
    </header>
  )
}
