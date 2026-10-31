import styles from './TopBar.module.css'

export type Tab = 'convert' | 'upload'

interface Props {
  tab: Tab
  onTab(tab: Tab): void
  status: string
  fontCount: number
}

export default function TopBar({ tab, onTab, status, fontCount }: Props): JSX.Element {
  return (
    <header className={styles.topbar}>
      {window.maxine.platform === 'darwin' && <div className={styles.trafficLightSpacer} />}
      <span className={styles.appName}>MAXINE Font Studio</span>
      <nav className={styles.tabs}>
        <button className={tab === 'convert' ? styles.tabActive : styles.tab} onClick={() => onTab('convert')}>
          Convert
        </button>
        <button className={tab === 'upload' ? styles.tabActive : styles.tab} onClick={() => onTab('upload')}>
          Upload{fontCount > 0 && <span className={styles.count}>{fontCount}</span>}
        </button>
      </nav>
      <span className={styles.spacer} />
      <span className={styles.status}>{status}</span>
      <span className={styles.badge} title="No converter output has been loaded on a real MAXINE yet">
        UNTESTED ON HARDWARE
      </span>
    </header>
  )
}
