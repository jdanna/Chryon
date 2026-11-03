import { app } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { Settings } from '@shared/types'

const DEFAULTS: Settings = {
  convert: { scanlines: 46, code: '9100', masterId: '9000', edge: 'none', lines: 3, aspect: 1.17, spacing: 0.95, kern: true, master: false, batchAbove: 0, batchBelow: 0, batchStep: 4 },
  ftp: { host: '10.37.0.2', port: 21, pause: 5, speed: 1, gap: 250 }, // the emulator's address
  emulator: { image: '', folder: '', captureFolder: '', videoInput: '', decklink: '' }
}

const settingsPath = (): string => join(app.getPath('userData'), 'settings.json')

export function loadSettings(): Settings {
  try {
    const saved = JSON.parse(readFileSync(settingsPath(), 'utf8'))
    const { host, port, pause, speed, gap } = { ...DEFAULTS.ftp, ...saved.ftp }
    // Older versions saved an empty address, so that counts as never set
    return { convert: { ...DEFAULTS.convert, ...saved.convert }, ftp: { host: host || DEFAULTS.ftp.host, port, pause, speed, gap }, emulator: { ...DEFAULTS.emulator, ...saved.emulator } }
  } catch {
    return DEFAULTS
  }
}

export function saveSettings(settings: Settings): void {
  mkdirSync(app.getPath('userData'), { recursive: true })
  writeFileSync(settingsPath(), JSON.stringify(settings, null, 2))
}
