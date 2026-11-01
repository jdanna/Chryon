import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { MaxineApi, UploadProgress } from '@shared/types'

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
  ftpUpload: (cfg, files, replacing) => ipcRenderer.invoke('ftp:upload', cfg, files, replacing),
  ftpDelete: (cfg, name) => ipcRenderer.invoke('ftp:delete', cfg, name),
  ftpDisconnect: () => ipcRenderer.invoke('ftp:disconnect'),
  loadSettings: () => ipcRenderer.invoke('settings:load'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  onUploadProgress: (listener) => {
    const handler = (_: unknown, p: UploadProgress): void => listener(p)
    ipcRenderer.on('ftp:progress', handler)
    return () => ipcRenderer.off('ftp:progress', handler)
  }
}

contextBridge.exposeInMainWorld('maxine', api)
