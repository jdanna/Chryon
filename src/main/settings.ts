import { app } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { Settings } from '@shared/types'

const DEFAULTS: Settings = {
  convert: { scanlines: 46, code: '9100', masterId: '9000', edge: 'none', lines: 3, aspect: 1.17, spacing: 0.95, kern: true, batchAbove: 0, batchBelow: 0, batchStep: 4 },
  ftp: { host: '', port: 21, pause: 30 }
}

const settingsPath = (): string => join(app.getPath('userData'), 'settings.json')

export function loadSettings(): Settings {
  try {
    const saved = JSON.parse(readFileSync(settingsPath(), 'utf8'))
    const { host, port, pause } = { ...DEFAULTS.ftp, ...saved.ftp }
    return { convert: { ...DEFAULTS.convert, ...saved.convert }, ftp: { host, port, pause } }
  } catch {
    return DEFAULTS
  }
}

export function saveSettings(settings: Settings): void {
  mkdirSync(app.getPath('userData'), { recursive: true })
  writeFileSync(settingsPath(), JSON.stringify(settings, null, 2))
}
