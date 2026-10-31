import { useEffect, useState } from 'react'
import type { FontInfo } from '@shared/types'
import ui from './ui.module.css'
import styles from './FontPreview.module.css'

/** The specimen sheet rendered from the finished file by our own decoder. */
export default function FontPreview({ font, empty }: { font: FontInfo | null; empty: string }): JSX.Element {
  const [image, setImage] = useState<string | null>(null)

  useEffect(() => {
    let stale = false
    if (font?.preview) window.maxine.previewImage(font.file).then((url) => !stale && setImage(url))
    else setImage(null)
    return () => {
      stale = true
    }
  }, [font?.file, font?.mtime, font?.preview])

  return (
    <div className={styles.well}>
      {image ? <img className={styles.image} src={image} alt={font?.name} /> : <div className={ui.empty}>{empty}</div>}
    </div>
  )
}
