import { useEffect, useState } from 'react'
import type { FontInfo } from '@shared/types'
import ui from './ui.module.css'
import styles from './FontPreview.module.css'

/** Loads one of a converted font's specimen sheets. */
function useFontImage(font: FontInfo | null, kind: 'maxine' | 'source'): string | null {
  const [image, setImage] = useState<string | null>(null)

  useEffect(() => {
    let stale = false
    if (font) window.maxine.previewImage(font.file, kind).then((url) => !stale && setImage(url))
    else setImage(null)
    return () => {
      stale = true
    }
  }, [font?.file, font?.mtime, kind])

  return image
}

/** A specimen sheet in a well, or `empty` when there's nothing to show. */
export function PreviewWell({ image, empty, label }: { image: string | null; empty: string; label?: string }): JSX.Element {
  return (
    <div className={styles.pane}>
      {label && <div className={styles.label}>{label}</div>}
      <div className={styles.well}>{image ? <img className={styles.image} src={image} alt={label ?? 'Font specimen'} /> : <div className={ui.empty}>{empty}</div>}</div>
    </div>
  )
}

/** The specimen rendered from the finished file by our own decoder. */
export default function FontPreview({ font, empty }: { font: FontInfo | null; empty: string }): JSX.Element {
  return <PreviewWell image={useFontImage(font, 'maxine')} empty={empty} />
}

/** The source outlines next to the converted file, at the same scale and layout. */
export function ComparePreview({ font, empty }: { font: FontInfo | null; empty: string }): JSX.Element {
  const source = useFontImage(font, 'source')
  const maxine = useFontImage(font, 'maxine')
  if (!font) return <PreviewWell image={null} empty={empty} />
  return (
    <div className={styles.compare}>
      <PreviewWell image={source} label="Source" empty="This font has no source render. Convert it again to compare." />
      <PreviewWell image={maxine} label="MAXINE!" empty="This file has no preview." />
    </div>
  )
}
