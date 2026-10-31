import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import type { ConvertRequest, FontInfo, FtpConfig, Settings, UploadedFile, UploadProgress } from '@shared/types'
import { Bridge } from './bridge'
import { loadSettings, saveSettings } from './settings'

/** Fonts go here rather than next to the source; the Upload tab and Export pick them up. */
function tempDir(): string {
  const dir = join(app.getPath('temp'), 'MAXINE Font Studio')
  mkdirSync(dir, { recursive: true })
  return dir
}

/** The renderer names files, never paths, so it can't reach outside the temp folder. */
function tempFile(file: string): string {
  if (!/^\.\d{4}$/.test(file)) throw new Error(`Not a font file name: ${file}`)
  return join(tempDir(), file)
}

const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`

export function registerIpc(win: BrowserWindow): Bridge {
  const bridge = new Bridge((event) => {
    if (event.event === 'upload' && !win.isDestroyed()) win.webContents.send('ftp:progress', event as unknown as UploadProgress)
  })

  ipcMain.handle('fonts:system', () => bridge.call('system_fonts'))
  ipcMain.handle('fonts:faces', (_, path: string) => bridge.call('faces', { path }))
  ipcMain.handle('fonts:pick', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: 'Choose a font',
      properties: ['openFile'],
      filters: [{ name: 'Fonts', extensions: ['ttf', 'otf', 'ttc'] }]
    })
    return canceled ? null : filePaths[0]
  })
  ipcMain.handle('fonts:convert', (_, req: ConvertRequest) =>
    bridge.call('convert', {
      ttf: req.ttf, index: req.index, name: req.name, scanlines: req.scanlines, code: req.code, master_id: req.masterId,
      edge: req.edge, lines: req.lines, aspect: req.aspect, spacing: req.spacing, kern: req.kern, out: tempDir()
    })
  )

  ipcMain.handle('outputs:list', async () => {
    const dir = tempDir()
    return { dir, files: await bridge.call<FontInfo[]>('outputs', { dir }) }
  })
  ipcMain.handle('outputs:preview', (_, file: string) => {
    const png = tempFile(file) + '.png'
    return existsSync(png) ? `data:image/png;base64,${readFileSync(png).toString('base64')}` : null
  })
  // A folder picker, not a save dialog: macOS refuses dotfile names in NSSavePanel
  ipcMain.handle('outputs:export', async (_, file: string) => {
    const source = tempFile(file)
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: `Export ${file} to folder`,
      buttonLabel: 'Export Here',
      properties: ['openDirectory', 'createDirectory']
    })
    if (canceled) return null
    const dest = join(filePaths[0], file)
    copyFileSync(source, dest)
    return dest
  })
  ipcMain.handle('outputs:delete', (_, file: string) => {
    const path = tempFile(file)
    rmSync(path, { force: true })
    rmSync(path + '.png', { force: true })
  })
  ipcMain.handle('outputs:open-folder', () => shell.openPath(tempDir()))

  ipcMain.handle('ftp:list', (_, cfg: FtpConfig) => bridge.call('ftp_list', cfg))
  ipcMain.handle('ftp:upload', async (_, cfg: FtpConfig, files: string[], replacing: string[]) => {
    const paths = files.map(tempFile)
    const notes = [
      `${files.join(', ')}\n\nLoad one font at a time on the unit. Stop if it fails to load, hangs or crashes.`
    ]
    if (replacing.length) notes.push(`Already on the unit, will be replaced: ${replacing.join(', ')}`)
    const originals = files.filter((f) => !f.startsWith('.9'))
    if (originals.length) notes.push(`Not a 9xxx test code, so this can replace an original font: ${originals.join(', ')}`)
    const { response } = await dialog.showMessageBox(win, {
      type: replacing.length || originals.length ? 'warning' : 'question',
      message: `Upload ${plural(files.length, 'font')} to ${cfg.host}?`,
      detail: notes.join('\n\n'),
      buttons: ['Upload', 'Cancel'],
      defaultId: originals.length ? 1 : 0,
      cancelId: 1
    })
    return response === 0 ? bridge.call<UploadedFile[]>('ftp_upload', { ...cfg, paths }) : null
  })
  ipcMain.handle('ftp:delete', async (_, cfg: FtpConfig, name: string) => {
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      message: `Delete ${name} from ${cfg.host}?`,
      detail: 'This removes the file from the MAXINE and cannot be undone.',
      buttons: ['Delete', 'Cancel'],
      defaultId: 1,
      cancelId: 1
    })
    if (response !== 0) return false
    await bridge.call('ftp_delete', { ...cfg, name })
    return true
  })

  ipcMain.handle('settings:load', () => loadSettings())
  ipcMain.handle('settings:save', (_, settings: Settings) => saveSettings(settings))

  return bridge
}
