import { app, BrowserWindow, screen } from 'electron'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { registerIpc } from './ipc'
import { Emulator, registerEmulator } from './emulator'
import type { Bridge } from './bridge'

interface WindowState {
  width: number
  height: number
  x?: number
  y?: number
}

const APP_NAME = 'MAXINE! Studio'

// The name shows in menus and the About panel only. Nothing on disk may carry the "!",
// so userData is pinned first; the install folder comes from productName in electron-builder.yml.
const userData = app.getPath('userData')
app.setName(APP_NAME)
app.setPath('userData', userData)

const statePath = (): string => join(app.getPath('userData'), 'window-state.json')

function loadWindowState(): WindowState {
  try {
    const saved = JSON.parse(readFileSync(statePath(), 'utf8'))
    const state: WindowState = { width: Math.max(Number(saved.width) || 1440, 1160), height: Math.max(Number(saved.height) || 920, 700) }
    // A position saved on a since-disconnected monitor would restore off-screen
    const onScreen = screen.getAllDisplays().some(({ workArea: wa }) =>
      saved.x < wa.x + wa.width - 40 && saved.x + state.width > wa.x + 40 && saved.y >= wa.y - 20 && saved.y < wa.y + wa.height - 40)
    if (onScreen) {
      state.x = saved.x
      state.y = saved.y
    }
    return state
  } catch {
    return { width: 1440, height: 920 }
  }
}

function saveWindowState(win: BrowserWindow): void {
  if (win.isMaximized() || win.isMinimized()) return
  try {
    writeFileSync(statePath(), JSON.stringify(win.getBounds()))
  } catch {
    // ignore
  }
}

let bridge: Bridge | null = null
let emulator: Emulator | null = null
let stoppingEmulator = false

function createWindow(): void {
  const win = new BrowserWindow({
    ...loadWindowState(),
    minWidth: 1160,
    minHeight: 700,
    backgroundColor: '#1a1a1a',
    title: APP_NAME,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    autoHideMenuBar: true,
    icon: process.platform === 'linux' && app.isPackaged ? join(process.resourcesPath, 'icon.png') : undefined,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true
    }
  })

  win.on('ready-to-show', () => win.show())
  win.on('resized', () => saveWindowState(win))
  win.on('moved', () => saveWindowState(win))
  win.on('close', () => saveWindowState(win))

  // A font dropped outside the drop handler must not navigate the app away
  win.webContents.on('will-navigate', (event) => event.preventDefault())

  bridge = registerIpc(win)
  emulator = registerEmulator(win)

  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  app.setAppUserModelId('com.retrograde.maxinestudio')
  app.setAboutPanelOptions({ applicationName: APP_NAME, applicationVersion: app.getVersion() })
  createWindow()
})

app.on('window-all-closed', () => app.quit())

// The emulator saves its NVRAM as it exits, so quitting waits for that
app.on('before-quit', (event) => {
  if (!emulator?.running) return
  event.preventDefault()
  if (stoppingEmulator) return
  stoppingEmulator = true
  emulator.stop().finally(() => app.quit())
})
app.on('will-quit', () => bridge?.stop())
