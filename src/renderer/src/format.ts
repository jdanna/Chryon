export const FONT_EXTENSIONS = /\.(ttf|otf|ttc)$/i

export function formatSize(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB`
}

export function errorMessage(err: unknown): string {
  // ipcRenderer.invoke prefixes "Error invoking remote method 'x': Error: "
  return (err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method '[^']*': (Error: )?/, '')
}
