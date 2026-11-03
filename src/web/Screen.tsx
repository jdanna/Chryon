import { forwardRef, useEffect } from 'react'
import { machine } from './machine'
import styles from './Screen.module.css'

/** The canvas stays mounted for good, because the running machine holds on to it. */
const Screen = forwardRef<HTMLCanvasElement>(function Screen(_, ref): JSX.Element {
  // Command belongs to the browser, as it does to the host on a desktop. SDL would cancel those keys, which
  // also stops the paste event, and that's the only way the driver gets the clipboard here.
  useEffect(() => {
    const key = (e: KeyboardEvent): void => {
      if (e.metaKey || (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'v')) e.stopImmediatePropagation()
    }
    const paste = (e: ClipboardEvent): void => {
      if (document.activeElement?.id !== 'canvas') return
      const text = e.clipboardData?.getData('text/plain')
      if (text) machine.paste(text)
    }
    addEventListener('keydown', key, true)
    addEventListener('paste', paste)
    return () => {
      removeEventListener('keydown', key, true)
      removeEventListener('paste', paste)
    }
  }, [])

  return (
    <div className={styles.frame}>
      <canvas id="canvas" ref={ref} className={styles.canvas} tabIndex={0} onContextMenu={(e) => e.preventDefault()} onMouseEnter={(e) => e.currentTarget.focus()} />
    </div>
  )
})

export default Screen
