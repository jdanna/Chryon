import icon from './assets/icon.png'
import { changelog } from './changelog'
import logo from './assets/retrograde-logo-only.png'
import wordmark from './assets/wordmark.png'
import styles from './Landing.module.css'

const HOME = 'https://retrograde.tools'
const REPOSITORY = 'https://github.com/jdanna/MaxineStudio'
const RELEASES = `${REPOSITORY}/releases/latest`

const FEATURES = [
  ['The original software', 'The real MAXINE! interface, running on the actual v11.01 firmware.'],
  ['Saved as you work', 'Messages and settings saved in the browser between visits.'],
  ['Video and Key export', 'Download matching PNGs of matte and fill outputs, in native NTSC raster or square pixels.']
]

interface Props {
  busy: boolean
  status: string
  saved: boolean
  onStart(): void
  onReset(): void
}

export default function Landing({ busy, status, saved, onStart, onReset }: Props): JSX.Element {
  return (
    <div className={styles.page}>
      <nav className={styles.nav}>
        <a className={styles.brand} href={HOME}>
          <img className={styles.logo} src={logo} alt="Retrograde Labs" />
          <img className={styles.wordmark} src={wordmark} alt="" />
        </a>
        <a className={styles.navLink} href={HOME}>
          retrograde.tools
        </a>
      </nav>

      <main className={styles.hero}>
        <img className={styles.icon} src={icon} alt="" />
        <h1 className={styles.title}>
          <span className={styles.gradient}>MAXINE! Emulator</span>
        </h1>
        <p className={styles.sub}>The Chyron MAXINE! broadcast character generator, emulated in full and running in your browser.</p>

        <button className={styles.start} disabled={busy} onClick={onStart}>
          {busy ? 'Starting…' : saved ? 'Continue' : 'Start emulator'}
        </button>
        <p className={styles.status} role="status">
          {status || 'Additional fonts coming soon...'}
        </p>
        {saved && !busy && (
          <button className={styles.reset} onClick={onReset}>
            Start over from the original disk
          </button>
        )}
      </main>

      <section className={styles.features}>
        {FEATURES.map(([title, text]) => (
          <div key={title} className={styles.feature}>
            <h2>{title}</h2>
            <p>{text}</p>
          </div>
        ))}
      </section>

      <section className={styles.changelog} aria-labelledby="changelog-title">
        <h2 id="changelog-title" className={styles.changelogLabel}>
          Changelog
        </h2>
        <div className={styles.changelogBox}>
          {changelog.map((block, i) =>
            block.kind === 'heading' ? (
              <h3 key={i}>{block.text}</h3>
            ) : block.kind === 'text' ? (
              <p key={i}>{block.text}</p>
            ) : (
              <ul key={i}>
                {block.items.map((item, j) => (
                  <li key={j}>{item}</li>
                ))}
              </ul>
            )
          )}
        </div>
      </section>

      <footer className={styles.footer}>
        <span>An independent preservation project, not affiliated with Chyron.</span>
        <span className={styles.footerLinks}>
          <a href={RELEASES}>Desktop app</a>
          <a href={REPOSITORY}>GitHub</a>
          <span>© 2026 Retrograde Labs</span>
        </span>
      </footer>
    </div>
  )
}
