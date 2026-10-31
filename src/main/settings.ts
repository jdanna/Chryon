import { app, safeStorage } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { Settings } from '@shared/types'

const DEFAULTS: Settings = {
  convert: { scanlines: 46, code: '9100', masterId: '9000', edge: 'none', lines: 3, aspect: 1.17, spacing: 0.95, kern: true },
  ftp: { host: '', port: 21, user: 'anonymous', password: '', dir: '', passive: true, remember: false }
}

const settingsPath = (): string => join(app.getPath('userData'), 'settings.json')

/** Linux falls back to a hardcoded key when there's no keyring, which is not encryption. */
function canEncrypt(): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false
  return process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'
}

export function loadSettings(): Settings {
  try {
    const saved = JSON.parse(readFileSync(settingsPath(), 'utf8'))
    const ftp = { ...DEFAULTS.ftp, ...saved.ftp, password: '' }
    if (saved.ftpPassword && canEncrypt()) {
      ftp.password = safeStorage.decryptString(Buffer.from(saved.ftpPassword, 'base64'))
    }
    return { convert: { ...DEFAULTS.convert, ...saved.convert }, ftp }
  } catch {
    return DEFAULTS
  }
}

export function saveSettings(settings: Settings): void {
  const { password, ...ftp } = settings.ftp
  const ftpPassword = ftp.remember && password && canEncrypt() ? safeStorage.encryptString(password).toString('base64') : undefined
  mkdirSync(app.getPath('userData'), { recursive: true })
  writeFileSync(settingsPath(), JSON.stringify({ convert: settings.convert, ftp, ftpPassword }, null, 2))
}
