import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { CaptureState, MaxineApi, UploadProgress } from '@shared/types'

const api: MaxineApi = {
  platform: process.platform,
  pathForFile: (file) => webUtils.getPathForFile(file),
  systemFonts: () => ipcRenderer.invoke('fonts:system'),
  fontFaces: (path) => ipcRenderer.invoke('fonts:faces', path),
  pickFont: () => ipcRenderer.invoke('fonts:pick'),
  sourcePreview: (req) => ipcRenderer.invoke('fonts:source-preview', req),
  convert: (req) => ipcRenderer.invoke('fonts:convert', req),
  outputs: () => ipcRenderer.invoke('outputs:list'),
  previewImage: (file, kind) => ipcRenderer.invoke('outputs:preview', file, kind),
  exportFont: (file) => ipcRenderer.invoke('outputs:export', file),
  deleteFont: (file) => ipcRenderer.invoke('outputs:delete', file),
  deleteFonts: (files) => ipcRenderer.invoke('outputs:delete-many', files),
  openTempFolder: () => ipcRenderer.invoke('outputs:open-folder'),
  ftpList: (cfg) => ipcRenderer.invoke('ftp:list', cfg),
  ftpUpload: (cfg, files, replacing, masters) => ipcRenderer.invoke('ftp:upload', cfg, files, replacing, masters),
  ftpDelete: (cfg, items) => ipcRenderer.invoke('ftp:delete', cfg, items),
  ftpDisconnect: () => ipcRenderer.invoke('ftp:disconnect'),
  loadSettings: () => ipcRenderer.invoke('settings:load'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  onUploadProgress: (listener) => {
    const handler = (_: unknown, p: UploadProgress): void => listener(p)
    ipcRenderer.on('ftp:progress', handler)
    return () => ipcRenderer.off('ftp:progress', handler)
  },
  emulatorStatus: (cfg) => ipcRenderer.invoke('emulator:status', cfg),
  emulatorStart: (cfg) => ipcRenderer.invoke('emulator:start', cfg),
  emulatorStop: () => ipcRenderer.invoke('emulator:stop'),
  emulatorCaptureStart: (cfg) => ipcRenderer.invoke('emulator:capture-start', cfg),
  emulatorCaptureStop: () => ipcRenderer.invoke('emulator:capture-stop'),
  emulatorNetwork: (up) => ipcRenderer.invoke('emulator:network', up),
  openTapDownload: () => ipcRenderer.invoke('emulator:tap-download'),
  pickEmulatorImage: () => ipcRenderer.invoke('emulator:pick-image'),
  pickEmulatorFolder: () => ipcRenderer.invoke('emulator:pick-folder'),
  openEmulatorFolder: (cfg) => ipcRenderer.invoke('emulator:open-folder', cfg),
  pickCaptureFolder: () => ipcRenderer.invoke('emulator:pick-capture-folder'),
  openCaptureFolder: (cfg) => ipcRenderer.invoke('emulator:open-capture-folder', cfg),
  pickVideoInput: () => ipcRenderer.invoke('emulator:pick-video-input'),
  emulatorVideoInput: (cfg) => ipcRenderer.invoke('emulator:video-input', cfg),
  resetEmulatorDisk: (cfg) => ipcRenderer.invoke('emulator:reset', cfg),
  readNvram: (cfg) => ipcRenderer.invoke('emulator:nvram-read', cfg),
  writeNvram: (cfg, data) => ipcRenderer.invoke('emulator:nvram-write', cfg, data),
  onEmulatorLog: (listener) => {
    const handler = (_: unknown, lines: string[]): void => listener(lines)
    ipcRenderer.on('emulator:log', handler)
    return () => ipcRenderer.off('emulator:log', handler)
  },
  onEmulatorState: (listener) => {
    const handler = (_: unknown, running: boolean): void => listener(running)
    ipcRenderer.on('emulator:state', handler)
    return () => ipcRenderer.off('emulator:state', handler)
  },
  onEmulatorCapture: (listener) => {
    const handler = (_: unknown, state: CaptureState): void => listener(state)
    ipcRenderer.on('emulator:capture', handler)
    return () => ipcRenderer.off('emulator:capture', handler)
  }
}

contextBridge.exposeInMainWorld('maxine', api)
