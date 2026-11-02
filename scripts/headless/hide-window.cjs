// Preloaded into the main process with `electron -r`, so the app runs with no
// window, Dock icon or focus change and needs no test code path of its own.
const { app, dialog } = require('electron')

app.dock?.hide()

// Converted fonts go to a throwaway folder, not the real one
if (process.env.HEADLESS_TEMP_DIR) app.setPath('temp', process.env.HEADLESS_TEMP_DIR)

// Native dialogs can't be driven and would block unseen on the hidden window.
// Button 0 is the confirming action in every message box in this app.
dialog.showMessageBox = async (...args) => {
  const options = args[args.length - 1]
  console.log(`[headless] dialog: ${options.message} | ${options.detail}`)
  return { response: 0 }
}

// Folder pickers take their answers in turn from HEADLESS_PICK_FOLDERS, separated by ;
// and cancel once those run out.
const picks = process.env.HEADLESS_PICK_FOLDERS?.split(';') ?? []
dialog.showOpenDialog = async (...args) => {
  const options = args[args.length - 1]
  const folder = picks.shift()
  console.log(`[headless] open dialog: ${options.title} | ${folder ?? 'cancelled'}`)
  return { canceled: !folder, filePaths: folder ? [folder] : [] }
}

app.on('browser-window-created', (_, win) => {
  // index.ts creates the window show:false, then calls show() on ready-to-show
  win.show = () => {}
  win.showInactive = () => {}
  win.focus = () => {}
  // Keeps rendering, ResizeObserver and rAF live. It also makes the page report
  // visibilityState 'visible', so the driver checks this line instead.
  win.webContents.setBackgroundThrottling(false)
  win.webContents.once('did-finish-load', () => {
    console.log(`[headless] window visible: ${win.isVisible()}`)
  })
})
