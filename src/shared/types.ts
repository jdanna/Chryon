export type EdgeStyle = 'none' | 'border' | 'shadow'

export interface SystemFont {
  path: string
  index: number
  name: string
}

/** A selected source face. `faces` lists a chosen file's faces, when it has several. */
export interface FontSource {
  path: string
  index: number
  name: string
  faces?: string[]
}

export interface ConvertSettings {
  scanlines: number
  code: string
  masterId: string
  edge: EdgeStyle
  lines: number
  aspect: number
  spacing: number
  kern: boolean
  /** Extra fonts above and below `scanlines`, with codes rising with size. */
  batchAbove: number
  batchBelow: number
  batchStep: number
}

export interface ConvertRequest extends ConvertSettings {
  ttf: string
  index: number
  name: string
}

/** The settings that change how the source specimen is laid out. */
export type SourcePreviewRequest = Pick<ConvertRequest, 'ttf' | 'index' | 'scanlines' | 'aspect' | 'spacing' | 'kern' | 'edge' | 'lines'>

/** `ascii` counts the font's printable ASCII characters, out of 94, and `letters` the A-Z
 *  and a-z among them, out of 52. With no letters the image shows the font's own script too,
 *  and with no ASCII there's nothing to convert. */
export interface SourcePreview {
  image: string
  ascii: number
  letters: number
}

/** A converted file in the temp folder. Metrics are absent if it couldn't be read. */
export interface FontInfo {
  path: string
  file: string
  size: number
  mtime: number
  preview: boolean
  name: string
  desc: string
  master?: string
  glyphs?: number
  kern?: number
  cell_rows?: number
  ascent?: number
  descent?: number
  baseline_row?: number
}

export interface ConvertResult {
  font: FontInfo
  log: string[]
}

export interface FtpConfig {
  host: string
  port: number
  user: string
  password: string
  dir: string
  passive: boolean
}

export interface FtpSettings extends FtpConfig {
  remember: boolean
}

export interface Settings {
  convert: ConvertSettings
  ftp: FtpSettings
}

export interface RemoteEntry {
  name: string
  size: number | null
  date: string
  dir: boolean
}

export interface FtpListing {
  welcome: string
  cwd: string
  entries: RemoteEntry[]
}

export interface UploadedFile {
  name: string
  local_size: number
  remote_size: number | null
}

export interface UploadProgress {
  event: 'upload'
  name: string
  sent: number
  total: number
}

/** Exposed to the renderer as window.maxine. File arguments are bare `.NNNN` names. */
export interface MaxineApi {
  platform: string
  pathForFile(file: File): string
  systemFonts(): Promise<SystemFont[]>
  fontFaces(path: string): Promise<string[]>
  pickFont(): Promise<string | null>
  /** The source outlines as a data: URL, laid out as the converter would. */
  sourcePreview(req: SourcePreviewRequest): Promise<SourcePreview>
  convert(req: ConvertRequest): Promise<ConvertResult>
  outputs(): Promise<{ dir: string; files: FontInfo[] }>
  /** A data: URL of the decoded MAXINE file, or of the source it was converted from. */
  previewImage(file: string, kind: 'maxine' | 'source'): Promise<string | null>
  exportFont(file: string): Promise<string | null>
  deleteFont(file: string): Promise<void>
  /** Asks for confirmation in a native dialog. Resolves to false if declined. */
  deleteFonts(files: string[]): Promise<boolean>
  openTempFolder(): Promise<void>
  ftpList(cfg: FtpConfig): Promise<FtpListing>
  /** Asks for confirmation in a native dialog. Resolves to null if declined. */
  ftpUpload(cfg: FtpConfig, files: string[], replacing: string[]): Promise<UploadedFile[] | null>
  ftpDelete(cfg: FtpConfig, name: string): Promise<boolean>
  loadSettings(): Promise<Settings>
  saveSettings(settings: Settings): Promise<void>
  onUploadProgress(listener: (p: UploadProgress) => void): () => void
}
