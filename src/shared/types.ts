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
  /** Also write the outline master font Flash Font needs, as .<masterId> in the master folder. */
  master: boolean
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

/** A master (outline) font in the temp folder's master/ subfolder, named .<id>. */
export interface MasterInfo {
  path: string
  file: string
  size: number
  mtime: number
  name: string
  id: string
  glyphs: number
  kern: number
}

export interface ConvertResult {
  font: FontInfo
  master?: MasterInfo
  log: string[]
}

export interface FtpConfig {
  host: string
  port: number
  /** Seconds to wait after each file in a batch. */
  pause: number
  /** Upload ceiling in Mbit/s. The bridge never goes above 10. */
  speed: number
  /** Milliseconds to wait after each reply before the next FTP command. */
  gap: number
}

/** Empty strings mean the built-in image and the folder in the app's own data. */
export interface EmulatorConfig {
  /** The read-only .chd that a new saved image is copied from. */
  image: string
  /** Holds disk.chd, nvram/, cfg/ and snap/ for this machine. */
  folder: string
  /** Where video captures go. Empty for capture/ in the folder above. */
  captureFolder: string
  /** The picture the Video Input board sees. Empty for none. */
  videoInput: string
  /** The DeckLink device to play out of, by its display name. Empty for none. */
  decklink: string
}

/** What the SECOND SCREEN key shows, and so what a DeckLink plays. */
export type DecklinkSource = 'color-edit' | 'video' | 'key'

/** Only known while the emulator runs, because the emulator is what talks to the DeckLink. */
export interface DecklinkState {
  /** Whether Desktop Video is installed, or null until the emulator has looked. */
  driver: boolean | null
  devices: string[]
  /** The device playing, or null. */
  active: string | null
  source: DecklinkSource
  error: string | null
}

export interface CaptureState {
  active: boolean
  /** The length of the files so far. */
  seconds: number
  bytes: number
  /** The emulator is behind real time. Every field is still saved. */
  behind: boolean
}

export interface EmulatorStatus {
  /** Why it can't run on this computer, or null if it can. */
  missing: string | null
  /** Why it can't capture video, or null if it can. */
  captureMissing: string | null
  running: boolean
  network: boolean
  /** Windows only: the network needs TAP-Windows, which the user installs. */
  tapMissing: boolean
  image: string
  imageFound: boolean
  folder: string
  captureFolder: string
  /** Bytes, or null until the first run makes the saved image. */
  diskSize: number | null
}

export interface NvramFile {
  exists: boolean
  data: Uint8Array | null
}

export interface Settings {
  convert: ConvertSettings
  ftp: FtpConfig
  emulator: EmulatorConfig
}

export interface RemoteEntry {
  name: string
  size: number
  dir: boolean
}

/** A file on the unit: in /SYSTEM/MASTER when `master`, else in /MAXINE/MACHINE. */
export interface RemoteFile {
  name: string
  master: boolean
}

export interface FtpListing {
  welcome: string
  cwd: string
  entries: RemoteEntry[]
  /** The unit's /SYSTEM/MASTER folder, where Flash Font looks for outline fonts. */
  masters: RemoteEntry[]
}

export interface UploadedFile {
  name: string
  size: number
}

/** Every write comes back with the unit's listing, so the tab never reconnects to refresh. */
export interface UploadResult {
  done: UploadedFile[]
  masters: UploadedFile[]
  listing: FtpListing
}

export interface UploadProgress {
  event: 'upload'
  name: string
  sent: number
  total: number
  /** Set while pausing after `name`: seconds until the next connection */
  wait?: number
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
  outputs(): Promise<{ dir: string; files: FontInfo[]; masters: MasterInfo[] }>
  /** A data: URL of the decoded MAXINE file, or of the source it was converted from. */
  previewImage(file: string, kind: 'maxine' | 'source'): Promise<string | null>
  exportFont(file: string): Promise<string | null>
  deleteFont(file: string): Promise<void>
  /** Asks for confirmation in a native dialog. Resolves to false if declined. */
  deleteFonts(files: string[]): Promise<boolean>
  openTempFolder(): Promise<void>
  /** Connects on the first call; the connection then stays open until ftpDisconnect. */
  ftpList(cfg: FtpConfig): Promise<FtpListing>
  /** Asks for confirmation in a native dialog. Resolves to null if declined. `masters` are
   *  .<id> names from the master folder, sent to /SYSTEM/MASTER after the fonts. */
  ftpUpload(cfg: FtpConfig, files: string[], replacing: string[], masters: string[]): Promise<UploadResult | null>
  /** Deletes a batch of 9xxx files. Asks for confirmation in a native dialog. Resolves to null if declined. */
  ftpDelete(cfg: FtpConfig, items: RemoteFile[]): Promise<FtpListing | null>
  ftpDisconnect(): Promise<void>
  loadSettings(): Promise<Settings>
  saveSettings(settings: Settings): Promise<void>
  onUploadProgress(listener: (p: UploadProgress) => void): () => void
  emulatorStatus(cfg: EmulatorConfig): Promise<EmulatorStatus>
  emulatorStart(cfg: EmulatorConfig): Promise<void>
  emulatorStop(): Promise<void>
  emulatorCaptureStart(cfg: EmulatorConfig): Promise<void>
  /** Resolves once both files are finished. */
  emulatorCaptureStop(): Promise<void>
  /** Asks for the admin password. Resolves to whether the link is up afterwards. */
  emulatorNetwork(up: boolean): Promise<boolean>
  openTapDownload(): Promise<void>
  pickEmulatorImage(): Promise<string | null>
  pickEmulatorFolder(): Promise<string | null>
  openEmulatorFolder(cfg: EmulatorConfig): Promise<void>
  pickCaptureFolder(): Promise<string | null>
  openCaptureFolder(cfg: EmulatorConfig): Promise<void>
  /** Resolves to null if cancelled, and rejects a file that isn't a picture the app can read. */
  pickVideoInput(): Promise<string | null>
  /** Sends cfg.videoInput to the running emulator. */
  emulatorVideoInput(cfg: EmulatorConfig): Promise<void>
  /** Plays the running emulator out of cfg.decklink, or stops playing if it's empty. */
  emulatorDecklink(cfg: EmulatorConfig): Promise<void>
  /** Asks the running emulator for its DeckLink devices again. */
  emulatorDecklinkRefresh(): Promise<void>
  /** Asks for confirmation in a native dialog. Resolves to false if declined. */
  resetEmulatorDisk(cfg: EmulatorConfig): Promise<boolean>
  readNvram(cfg: EmulatorConfig): Promise<NvramFile>
  writeNvram(cfg: EmulatorConfig, data: Uint8Array): Promise<void>
  onEmulatorLog(listener: (lines: string[]) => void): () => void
  onEmulatorState(listener: (running: boolean) => void): () => void
  onEmulatorCapture(listener: (state: CaptureState) => void): () => void
  onEmulatorDecklink(listener: (state: DecklinkState) => void): () => void
}
