# Chyron MAXINE font format reverse engineering

## Goal

Reverse engineer the proprietary "Machine Font" file format used by a vintage
Chyron MAXINE! character generator (iNFiNiT! family, broadcast lower-thirds
hardware) well enough to write a **TTF → MAXINE font converter**, for
preservation of these systems. Target fidelity: best-effort visual match.

**Status (2026-11-01): the format is decoded and converter output loads on the
hardware.** The glyph data is a run-length-encoded 8-bit antialiased bitmap, not
outlines. A reader/writer and a TTF converter exist in `tools/` and round-trip all
36 original files. On 2026-11-01 the user uploaded app-converted fonts over FTP and
reported that everything works on the unit; the one defect was a blank icon in the
unit's font browser, fixed the same day (the footer holds a 30×30 icon as well as
the 66×66 thumbnail, and the converter had left it empty).

## Branching

Keep all work on `main`, for both the Studio app and the emulator. Only branch when
the user says to.

## Assets

- `fonts/` — 36 original font files pulled from the MAXINE, named as dotfiles
  with 4-digit codes (`.0000`, `.0111`, `.1111`, `.2222`, `.3000`-`.3013`,
  `.3333`, `.5000`-`.5016`). The 4-digit dotfile name is required for the
  device to recognize a font, and **the code is also embedded in the header**
  (see `0xce`), so a copied file should be re-stamped, not just renamed.
- `experiments/` — synthetic test files for the hardware. See
  `experiments/MANIFEST.md`. Use `.9xxx` codes for anything synthetic.
- `tools/maxine_font.py` — library + CLI: `info`, `glyph` (ASCII art),
  `render` (PNG specimen sheet with edge layer in red), `kern`, `thumb`,
  `roundtrip` (re-encode every glyph and compare with the file).
- `tools/ttf2maxine.py` — the converter. Needs Pillow, numpy, fontTools.
  `python3 tools/ttf2maxine.py font.ttf --scanlines 46 --code 9100 --out experiments --preview`
  Also importable: `ttf2maxine.convert(...)` is what the GUI calls.
- `tools/studio_bridge.py` — JSON-lines backend for the Electron app (see
  below). Wraps the converter and all FTP commands.
- `tools/footer_template.bin` — the fixed 6036-byte footer copied from `.3000`
  (only the 66×66 thumbnail and 30×30 icon inside it are regenerated per font).

## Ground truth / test loop (we have real hardware)

The user has the actual MAXINE unit connected to a Sony CRT. Transfer is
FTP (see the Electron app section), feedback is a phone photo of the CRT. Batch several test files per round. **Ask the user
to stop and report immediately if a file fails to load, hangs, or crashes
the unit.** Standard test string (typed with these line breaks):

```
ABCDEFGHIJKLM
NOPQRSTUVWXYZ
abcdefghijklm
nopqrstuv
wxyz
1234567890
!$%'&*(),-/
```

A trailing box glyph in photos is the text cursor, not a character.

Hardware-confirmed so far: `.0000` loads and shows the name "Swiss 721
Bold(TM)" from the header; it renders as proportional bold sans with no edge,
and the glyphs typed above all appear as standard ASCII shapes. Converted
`.9200` lists in the Font Load Utility with its code, name and description,
shows `ID: 9200/9000` and its "Aa" thumbnail on the control screen, and types
correctly on the CRT (`docs/maxine-crt.jpg`, `docs/maxine-font-load.jpg`). The
rest of the format section below comes from static analysis plus internal
consistency (round-trip, cross-file checks).

## File format (all integers big-endian)

Verified on all 36 files unless noted. `tools/maxine_font.py` implements it.

### Header

| offset | size | content |
|---|---|---|
| 0x000 | u32 | 500, constant |
| 0x004 | u32 | `ff ff ff ff` in `.0000` (no edge); `00 00 28 16` in all 35 edge fonts. Purpose unknown; the converter copies this convention. |
| 0x008 | 60 | font name, NUL padded (confirmed on hardware) |
| 0x044 | 64 | two NUL-terminated strings for the device's file browser, e.g. `"  46 scanlines No edge "`,`" 4 lines "` or `"  40 scanlines Border    3 lines            "`,`""` or `"  22 scanlines Border & Shdw    4 lines lower left"` |
| 0x084 | 4 | zero |
| 0x088 | 60 | font name again |
| 0x0c0 | 14 | uninitialized junk in most files (zeros in `.0000`); write zeros |
| 0x0ce | 8 | ASCII digits: 4-digit Bitstream master-font id + **this file's own 4-digit code** (`.3001` → `53403001`, `.0000` → `50050000`) |
| 0x0d6 | u16 | total cell rows = nominal scanlines + 2 × edge lines (46 for `.0000`; `.3000` says "40 scanlines Border 3 lines" and has 46) |
| 0x0d8 | u16 | ascent in rows (height of `h`/cap height; 33 in `.0000`) |
| 0x0da | u16 | widest advance in the master font (`@` is wider than `W`); informational |
| 0x0e6 | u32 | file length − 136 in every edge font; `.0000` has glyph-data length + 0xb00 instead. Probably a memory-size hint. Converter writes length − 136. |
| 0x0ea | u32 | **byte length of the glyph data block** (exact in all files) |
| 0x0ee | u16 | byte length of the kerning table (0 if none) |
| 0x0f0 | u16 | 38, constant |
| 0x0f8 | u16 | descent in rows (9 in `.0000`) |
| 0x0fa | u16 | same value as 0xf8 |
| 0x0fe | u16 | baseline offset: **baseline row = ascent + this** (exact for `.0000`, ±1 elsewhere). 11 in `.0000`, 5 in the bordered Dutch series, 3–4 in the shadow series |
| 0x104 | u16 | 1317 (1314 in `.0000`); probably a tool version |
| 0x108 | 192×10 | glyph table, one 10-byte record per character code 0..191 |
| 0x888 | … | glyph data, then kerning table, then 6036-byte footer |

Glyph table record (`>HHBBI`):

```
u8  0x42  (0x46 in the Border & Shadow fonts)
s8  spacing hint: 0 for most glyphs; L/h/k negative, d positive, scales with size. Semantics unknown.
u16 bits 15..10: left-overhang hint (A, J, j, / in serif/italic fonts; scales with size)
    bits 7..4:   another spacing hint (0–14)       — semantics unknown, converter writes 0
    bits 1..0:   high bits of top
u8  top row × 4   → top = ((u16 & 3) << 8 | u8) >> 2     (cell row of the bitmap's first row)
u8  advance width in pixels (bitmap may be wider or narrower; bitmap starts at the pen)
u32 offset of the glyph's run data from 0x888
```

A record of all zeros = undefined character. Codes 0–3 are four **underline
tiles** (half-intensity bar; both-ends-soft / left-hard / right-hard / both-hard).
Code 32 (space) is undefined; the originals define exactly
`!$%&'()*,-./0123456789:;<>?A-Za-z`. Glyphs need not be stored in code order
(the edge fonts aren't). No glyph in any original is below row 0.

Vertical model (`.0000`): cap top row 10, x-height row 18/19, baseline row 44
(= ascent 33 + 11), descenders to 53, underline tiles rows 41–45. Row 0 is
the top of the cell; the cell is taller than "scanlines" (which is the em).

### Glyph data: RLE antialiased bitmap

Each glyph is a sequence of 4-byte run records, top row first, terminated by
`00 00 00 00`:

```
[layer u16][intensity u8][count u8]
   count bits 7..3 = 32 − run length   (run length 1..32)
   count bits 2..0 = type:  x0 = blank run, x1 = solid 0xff run, x2 = gray run, x3 = end of row
                            bit 2 (the x) is set in edge fonts, clear in no-edge fonts
   layer: 1 = face, 2 = edge (border AND drop shadow share this layer),
          0 = blank runs / end-of-row in edge fonts (no-edge fonts use layer 1 for those),
          0x8002 = an edge pixel *underneath* the next record, which is always a
                   1-pixel face record; this overlay does not advance x.
```

- No-edge (`.0000`): every row is padded with blanks to the bitmap width and
  ends with `00 01 00 03`. Example `I` row: `0001 00e0 | 0001 7ffa | 0001 ffd1 | 0001 dffa | 0001 60fa | 0001 0003`
  = 4 blank, 0x7f, 6×0xff, 0xdf, 0x60: a textbook antialiased stem.
- Edge fonts: rows end with `00 00 00 ff` except the last (the glyph
  terminator doubles as its end), trailing blanks are trimmed, and glyphs
  usually begin with 1–2 empty rows. Wherever the face is partially covered
  (or the edge under it is not solid), the edge value is emitted first as an
  `8002` overlay so the device can composite face over edge.
- The original tool splits equal-value runs at outline edge crossings (e.g.
  15 blank → 3+12); a decoder must merge, and an encoder may merge freely.
- `python3 tools/maxine_font.py roundtrip fonts/.3000` re-encodes every
  decoded glyph and compares normalized run streams: identical for all 36
  files except the underline tiles' blank-run layer and a trailing empty row
  on two glyphs.

### Kerning table and footer

Kerning: 4-byte records `[left char][right char][s16 kern px]`, e.g.
`41 54 ff fe` = "AT" −2. Grouped by left character. `.0000` has 147 pairs,
the Dutch series 245, the Pi font none.

Footer (6036 bytes, identical layout in every file): 64 zero bytes, a fixed
704-byte table of 16-bit values, a 10-byte header `0000 0042 0042 001e 001e`
(two image sizes), then two 8-bit **images of "Aa"**: a 66×66 preview thumbnail
and, directly after it, the 30×30 **icon the unit's font browser shows**, then
two zero bytes (`.0000` lacks them). 0xee = background, 0x00 = ink, 0x22 steps;
the border shows as gray. In the originals both are left-aligned at x≈2 with the
pair clipped on the right: thumbnail cap height ≈30 px on baseline row ≈48, icon
≈14 px on row ≈22. Only these pixels differ between files. The converter copies
`tools/footer_template.bin` and redraws both; until 2026-11-01 it treated the
span as one 66×79 image and left the icon blank, which the unit shows as an
empty box. `maxine_font.py thumb` writes both side by side.

### Measured scaling (for the converter)

Against macOS Helvetica Bold (a legitimate stand-in for Bitstream Swiss 721
Bold): vertical scale = nominal scanlines per em (46 rows/em → cap height 34
rows); horizontal scale ≈ 1.17× that (≈55 px/em), i.e. non-square NTSC
pixels. Original advance widths are ≈0.93–0.95× the TTF advance; bitmaps
start at the pen position and include the left side bearing as blank pixels.
The border in `.3000` is a ≈3-px rounded, antialiased dilation of the face;
the shadow in `.5000` is the face+border copied down-left (≈4 rows, ≈3 px)
into the same edge layer.

### Size series in the originals

A series is one master id and display name, consecutive codes, and sizes ascending
with the code. The edge stays the same thickness at every size; only the browser
description differs. Scanlines run from 22 to 100, and 24 of the 29 steps are +4:

| codes | master | face | edge | scanlines |
|---|---|---|---|---|
| 3000–3013 | 5340 | Dutch 766 Bold | Border 3 | 40 44 48 52 60 64 68 72 78 82 86 90 96 100 |
| 5000–5006 | 5293 | Humanist 521 Bold Italic | Border & Shdw 4 | 22 26 30 34 38 42 46 |
| 5007–5016 | 5290 | Humanist 521 | Border & Shdw 2 | 30 34 38 42 44 48 52 56 58 62 |

The app's Batch sizes option follows this (`batch` in `ConvertTab.tsx`, default step 4).
`Sizes above` and `Sizes below` count extra fonts on each side of the Scanlines value;
the first code is always the smallest size.

## Converter design (`tools/ttf2maxine.py`)

Rasterizes each glyph with Pillow at 4× supersampling, stretches by
`--aspect` (default 1.17), box-downsamples to 8-bit coverage, builds the
edge layer by elliptical dilation (`--edge border --lines N`) plus an offset
copy for `--edge shadow`, encodes with the rules above, copies pair kerning
from the TTF's `kern`/GPOS tables, generates the four underline tiles, the
header strings/metrics, the self-code digits and the thumbnail. Ink left of
the pen (negative lsb) is shifted right instead of using the overhang hint
bits, since those are unconfirmed. `--preview` renders the *finished file*
through the decoder as a PNG.

Defaults chosen to mimic the originals: baseline offset 11 (no edge) / 5
(edge), 1 leading empty row in edge glyphs, 0x42/0x46 tag, hint bits 0,
version 1317, master id 9000, chars 33–126 (the originals stop at 122).

## Electron app (MAXINE! Studio)

The "!" is display-only: UI text, window title, macOS menu items. Files and folders use
`MAXINE Studio` or `maxine-studio`, so don't put it in `productName` or `package.json`.
Never override `CFBundleName` either: Electron looks for `<CFBundleName> Helper.app` at
startup, so a name that differs from `productName` crashes the packaged app with
"Unable to find helper app". The bold macOS menu title therefore has no "!".

```bash
npm run dev            # needs python3 with Pillow, numpy, fontTools
npm run typecheck
npm run test:headless  # build, then run scripts/headless/smoke.json with no window
npm run predist:mac | predist:win | predist:linux     # Python and the emulator
npm run dist:mac | dist:win | dist:linux | release     # unsigned installers
```

- `src/main/` — `index.ts` (window), `ipc.ts` (all handlers; the temp folder and
  native dialogs live here), `bridge.ts` (spawns `tools/studio_bridge.py`, a
  JSON-lines subprocess that exits when stdin closes), `settings.ts`.
- `src/preload/index.ts` — `window.maxine`, typed by `MaxineApi` in `src/shared/types.ts`.
- `src/renderer/src/` — React + CSS Modules. `App.tsx` owns settings, the log and
  the converted-font list; `components/ConvertTab` and `components/UploadTab`
  stay mounted, so switching tabs keeps their state. Tokens mirror Luminary's.
- Converted fonts go to `<system temp>/MAXINE Studio/`. The renderer passes
  bare `.NNNN` names, never paths, and `tempFile()` in `ipc.ts` validates them.
  Dotfiles are hidden in Finder, so Export uses a folder picker (NSSavePanel
  refuses dot names).
- Packaged builds run a python-build-standalone interpreter from
  `resources/python/<platform>-<arch>/` (gitignored), with the pins in
  `resources/requirements-prod.txt` vendored in by
  `scripts/vendor-python-packages.mjs`. One Mac can build all three platforms. The Mac
  build is Apple Silicon only; Intel Mac support was removed on 2026-11-02.
  That script also compiles the `.pyc` files, which saves about 0.3 s, and the interpreter runs with
  `-I -B`, so nothing lands in the install folder. The first load after an install takes about 3 s, nearly
  all of it the system checking numpy's and Pillow's native libraries, so `preload()` in `studio_bridge.py`
  does that at launch. Measure on a fresh copy of the tree, because re-vendoring resets that check.
- Previews: `ttf2maxine.source_sheet` draws the source outlines with the converter's
  metrics, live as settings change (`source_preview`). A conversion writes `.NNNN.png`
  (decoded file) and `.NNNN.source.png` (same layout, driven by the file), both using
  `SPECIMEN`, the hardware test string, so the two line up and match a CRT photo.
  The edge layer only appears after converting.
- Not every font keeps its letters in Unicode. `font_cmap` falls back to the Mac Roman
  and Microsoft Symbol tables, which is how Wingdings and Hoefler Text Ornaments reach
  the ASCII keys (`Rasterizer.draw_char` applies the 0xF0xx offset). A font with no
  ASCII at all previews its own characters, and `convert()` refuses it instead of
  writing a file with only underline tiles. About 150 macOS fonts (Kohinoor Gujarati,
  Al Bayan) have digits and punctuation but no Latin letters, because the OS falls
  back to another font for Latin. They preview their own script and convert only what
  ASCII they have: the MAXINE is typed from ASCII keys, and mapping another script onto
  those keys isn't built.
- UI type follows Luminary: same stack and sizes at 100%, uppercase only on section
  titles, sentence-case labels, values in mono. `--font-scale` in `tokens.css` sets the
  overall size (1.2 here) and also drives field columns and row heights.
- The Upload tab groups converted fonts by master id and display name (`groupFonts`), not
  id alone, because fonts left on the default `9000` would otherwise all land in one group.
- The unit runs a pSOS FTP server (`215 UNIX Type: Chyron: pSOS`) that takes any login,
  so the app has no credential fields. `SIZE`, `MDTM`, `FEAT` and `STAT` are rejected.
  **Passive mode isn't available**: `PASV` gets 502 and the user confirmed the unit
  refuses passive, so don't try it again. Active mode is the only option: the unit
  connects back to this computer on an ephemeral port, and the user's firewall drops
  anything that isn't established/related, so those connections may be getting through
  only some of the time. Plain `LIST` includes dotfiles. Every date is Jan 1 1970, so
  none are shown.
- **One control connection** (`FtpLink` in `studio_bridge.py`) stays open from Connect
  until Disconnect or quit, and every command takes its lock in turn. A batch upload
  that opened a session per step (login, STOR, LIST, QUIT, repeat) hung the unit on
  2026-11-01, so don't go back to that. A reused link is probed with `NOOP` first and
  reopened if the unit dropped it. A batch is N × `STOR` and one `LIST`, which is the
  only way to read sizes back; upload and delete return that listing so the tab never
  reconnects to refresh. The replica of the unit's replies used to test this lives
  only in the session scratchpad, not the repo.
- **Batch uploads need pacing.** A 5-font batch finished cleanly on the unit on
  2026-11-01 with the current defaults: `pause` 5 (s after each `STOR`), `speed` 1
  (Mbit/s, hard ceiling `MAX_MBIT` 10, sent in 1 KB writes) and `gap` 250 (ms after each
  reply before the next command). Earlier batches locked it up after a few fonts: first
  as a session per step, then on one connection with a 2 s pause and no speed or command
  limits. Which setting matters isn't known, because they all changed together, so
  change one at a time if lowering them. Reads have never hung it: 8 `LIST`/`NLST` in
  one quick run were fine.
- The Emulator tab (`src/main/emulator.ts`, `EmulatorTab.tsx`, `NvramPanel.tsx`) runs on all three platforms. Confirmed on
  2026-11-02 in a Linux AppImage, except the real password prompt. Nothing Mac-specific has been run yet: the tab, the
  `osascript` prompt, or `bundleDylibs` in the vendor script. The tab's two
  paths are a read-only `.chd`, empty for the built-in default, and a folder holding `disk.chd`, `nvram/`, `cfg/` and
  `snap/`, empty for `<userData>/emulator`. Only `disk.chd` is ever deleted, by Reset. Tests set
  `MAXINE_EMULATOR_ARGS`, which is appended to MAME's arguments, plus `SDL_VIDEODRIVER=dummy`.
- Stop sends SIGTERM, which `maxine.cpp` turns into a clean exit. SDL catches that signal and posts an event MAME
  ignores, so without the driver's handler a kill never saves NVRAM. Quitting the app waits for that exit. On Windows,
  Node's `kill()` only terminates, so stdin is a pipe there and closing it is the signal: a driver thread blocks in
  `_read`, not `getchar`, whose stream lock could hang `exit()`.
- The log field reads stdout. `MAXINE_LOG_STDOUT` makes the driver send `logerror` there, so no `error.log` grows.
- `net-up.sh` and `net-down.sh` run as root by passing their text to `pkexec /bin/sh -c`, or through `osascript` on a
  Mac, because root can't read inside an AppImage's FUSE mount. Check a change to them from a packaged app.
- On Windows, `net-up.ps1` and `net-down.ps1` run elevated from their real path, through `Start-Process -Verb RunAs`. UAC
  can't return output, so errors come back in a temp file, and a declined prompt exits 1223. The user installs
  TAP-Windows in its default folder, because the user chose on 2026-11-02 not to ship the driver. Only the adapter named
  `MAXINE Emulator` is ever used: `net-up.ps1` always creates a new one, the driver matches that name, and
  `forgetNetworkInterface` strips `<network>` from `cfg/maxine.cfg` before each run, because MAME opens the saved index
  before `machine_reset` and it could be a VPN's adapter. Never rename an existing adapter or run `tapinstall remove`.
  A TAP adapter with no client is disconnected, so Node doesn't list it and it has no active address, and status is whether
  `netsh interface show interface` lists it.
- `shared/nvram.ts` lists the only NVRAM fields the editor shows, as the user chose on 2026-11-02: both serial records,
  Tel No Login, Ethernet and Debug mode. The rest stay at their defaults. Leave out anything the firmware overwrites at
  boot: `$76c`, `$774` and `$77c`–`$78f` come from `NET_CONF` on the disk.
- Packaging: `scripts/vendor-emulator.mjs` fills gitignored `resources/emulator/<platform>-<arch>/`, which
  electron-builder copies to `resources/emulator`. Linux builds in Docker on Ubuntu 22.04 in `emulator/mame-linux-x64`,
  so the binary needs glibc 2.35 or newer, and `collect-libs.sh` bundles SDL and the like, but not glibc, the GL stack
  or what Electron needs anyway. `MAXINE_NATIVE_BUILD=1` builds on the host instead. `release` on a Mac needs Docker.
  Windows cross-compiles with mingw in `emulator/Dockerfile.windows`, into `emulator/mame-win32-x64`, when `build.sh` sees
  `MAXINE_TARGET=windows`. It uses the SDL OSD, statically linked, so `sdlmaxine.exe` needs no DLLs and goes in as
  `maxine.exe`. Upstream CI doesn't build that combination, so the fixes are in `emulator/patches/windows/`, which only
  that build applies. `OSD=windows` isn't an option without patching MAME, because it resets the cursor count on every
  message pump. Wine runs the exe for tests, with `xvfb-run`, but has no TAP driver. On Linux with Wine 11 Staging,
  electron-builder's NSIS step hangs on its uninstaller stub, while `--win --dir` works. Installers come from the Mac.
  Tested on 2026-11-02 under Wine only: boot, log, a stop through stdin that saves NVRAM, and a real window. Nothing
  has run on real Windows yet: the app, the keys, UAC, TAP, the firewall rule or the installer.
- **Web target:** `npm run build:web` runs `build.sh` with `MAXINE_TARGET=web` in `emulator/mame-web`, then Vite on `src/web/`, into
  `dist-web/`, because electron-builder packages everything in `out/`. MAME's Emscripten build needs OSD `sdl3`, and only has
  `-video accel` and bgfx: `soft` isn't registered there and silently gives no window. `patches/web/page-support.patch` paces the
  main loop by real time, since it's called once per display refresh, and exports NVRAM saving, because that loop never returns
  to `run()`. Driver code that needs threads, sockets or stdin goes behind `__EMSCRIPTEN__`, as capture does.
- The web disk is a writable copy in Emscripten's MEMFS, saved whole to IndexedDB. Don't go back to a read-only disk with a MAME
  diff: an uncompressed CHD counts as writeable however it's opened, and with `harddriv.cpp` patched to force a diff, the second
  boot threw a C++ exception. `src/web` has its own startup page, styled after retrograde.tools, and a small top bar. Its teal icon comes from `make-icon.py --web`, and the desktop icon stays red. It doesn't use the Emulator tab or `window.maxine`.
- Test the web page with `npm run test:web`. In headless Chrome a synthetic key can set `document.hidden`, which stops the
  frames and so the machine, and looks like a firmware hang. `web-boot.mjs` has the flags that prevent it.
- Headless screenshots time out on Linux once the hidden window has updated. Use `xvfb-run -a node
  scripts/headless/driver.mjs steps.json --show`, but that real window doesn't auto-answer dialogs.
- Remote control isn't built. "Plan for MAXINE! Studio remote control" in `docs/remote-control-research.md` has the
  telnet setup it needs, including the `TELNETD.CFG` allow rule, tested on the emulator.
- Every command, reply and 64 KB of progress is appended, with timestamps, to
  `<system temp>/MAXINE Studio/ftp-trace.log`. After a hang, read that first.
- Login lands in `0.0/MAXINE`. Fonts are in `/MAXINE/MACHINE`, the only folder the app
  uses; `/MAXINE/MESSAGE` holds message files. `ftp_delete` refuses anything but
  `.9xxx`, so the originals on the unit can't be removed from the app.
- Confirmed on the unit 2026-11-01: login, `LIST`, `RETR`, `STOR` and `DELE`. All 36
  names and sizes match `fonts/`, `.0000` and `.3000` read back byte-identical, and
  `.9100` uploaded in 0.9 s, read back identical and deleted cleanly. The single-session
  rework has only been checked read-only on the unit (connect, list, list, QUIT).

**This repo is public**, and builds are unsigned. `.env` is gitignored and unused by
the build. `electron-builder.yml` is an allowlist, so it can't be packaged.

Verify in the running app with the headless driver, not `npm run dev`: it uses a
throwaway profile and temp folder and answers message boxes with button 0, which
is the confirming action everywhere in this app. Steps are JSON, see
`scripts/headless/driver.mjs`; within one step, actions run in the order `drop`,
`fill`, `click`, `select`, `wait`, `eval`/`expect`, `shot`. `launch({ binary })`
drives a packaged app, with a visible window and the real temp folder.

## Emulator (`emulator/`)

A MAME driver for the whole machine, as an overlay on a pinned MAME master commit (the NCR53C710
model isn't in a release yet). `emulator/README.md` has build and run steps. Hardware facts are in
`docs/hardware-map.md`, which is the place to add more.

```bash
emulator/build.sh             # clones MAME to emulator/mame on first run; later builds take a minute
emulator/run.sh               # add -debug for the MAME debugger
emulator/tests/run-test.sh    # headless boot check
python3 tools/phile.py ls emulator/roms/maxine-v11.01.img /SYSTEM/PROGRAMS
```

- **Status 2026-11-02:** boots on a stub to the real Program Loader and Message Compose. Working:
  keyboard and mouse, 64 MB expansion RAM, font load, typing in colour, messages saved to and read
  from disk, the frame buffer (`chyronfb.cpp`), Prompts and Color Edit screens, Video and Key export, roll and crawl,
  live capture. `emulator/README.md` lists the gaps.
- The machine has four outputs: Prompts, Color Edit, Video, Key. The window shows Prompts on the left, and on the right
  Color Edit, Video or Key, from the SECOND SCREEN key (`m_second_screen`). Right Ctrl exports Video and Key. Video and Key must stay clean of overlays. The panel's export buttons save to the
  snapshot folder and print `MAXINE_EXPORT`, then `saveExport` in `emulator.ts` asks for a folder and moves the pair,
  because Electron has a native picker everywhere and Linux has none a driver can rely on.
- `artwork/make_layout.py` is the single key list, and generates the layout and `maxine_keys.h`. The
  panel's right side copies a PC keyboard, with each key where its host key is, and the user chose the host keys on
  2026-11-02, so check before moving one. The cursor keys are SVG shapes, because layout text uses each system's font.
  Scroll Lock is INS ROW, so `machine_start` unbinds MAME's `UI_TOGGLE_UI`, which would turn on hotkeys like Esc to quit.
  Every key needs a unique
  name, because MAME's Lua `port.fields` is keyed by name and duplicates silently vanish. The panel
  ports must stay `IPT_OTHER`: MAME locks out all `IPT_KEYBOARD` fields outside the one enabled keyboard
  (`generic_keyboard`, in `run/cfg/maxine.cfg`), and Lua presses and clicks bypass that lockout, so a test
  needs `field:set_input_seq` to exercise the host path.
- The mouse isn't captured: the layout script writes the host pointer to a test port and
  `update_mouse()` steers the firmware's cursor to it with serial mouse packets. See "Mouse cursor" in
  `docs/hardware-map.md` for how it stays lined up.
- The Video Input board at `$81300000` takes a picture from the app (`videoin <PNG path>` or `videoin off` on stdin)
  or the web page (`maxine_video_input`, a PNG in MEMFS), and writes it into the frame buffer while the firmware
  holds control bits 10 and 6 clear. Control bit 1 (ALT V, or leaving the menu live) composites it behind the
  graphics on Video and Color Edit, not Key. `set_video_input` in `maxine.cpp` fits it to 4:3 and only narrows square-pixel
  pictures: 720 or 704 by 486 or 480 is taken as NTSC already. See `docs/hardware-map.md`.
- The frame buffer's data port takes font file records directly, so `tools/maxine_font.py` is a good
  oracle for it.
- **It's an MVME162, not a 167.** Earlier notes in the repo history said 167.
- Networking on Linux: `net-up.sh` makes a TAP named `tap-mess-<uid>-0`, the only name MAME's taptun opens, and the
  driver attaches to the device described as `TUN/TAP Device`. Confirmed 2026-11-02 in a throwaway Docker container
  with its own network, running net-up.sh itself: ping, active FTP, a font read back byte-identical, STOR and DELE.
  It hasn't been run on the host, where a firewall could still block active FTP. AppArmor blocks `unshare -Urn`
  on Ubuntu, so a container is how to test this without sudo.
- Networking on macOS: `net-up.sh` (root, once per reboot) makes a `feth0`/`feth1` pair and opens `/dev/bpf*`. The driver
  attaches to `feth0` through MAME's pcap backend whenever it exists. macOS has no tap, and MAME's taptun isn't
  built here. `patches/*.patch` are applied to the MAME checkout by `build.sh`.
  Confirmed 2026-11-02 from the Mac at 10.37.0.1: ping, FTP in active mode, a 251 KB font read back byte-identical,
  STOR and DELE. The 82596's blocks can sit on 2-byte boundaries, so the patch makes its dword access unaligned.
  Scripted runs can now reach the host: cap their log with `ulimit -f`, because a stuck chip wrote 11 GB in minutes.
- `roms/maxine-default.chd` gained `/SYSTEM/ETC/TELNETD.CFG` on 2026-11-02, written through the firmware's own FTP
  server so the filesystem stayed valid: five sectors changed. Do the same for any later change to it, because
  `tools/phile.py` is read-only. `maxine-v11.01.chd` stays clean.
- There's no boot PROM dump. `boot_stub()` in `maxine.cpp` loads `PSOS` at `$3000` and starts it
  through the reset vectors, which is meant to stay as a supported path.
- Driver-local devices go in `emulator/src/mame/chyron/`, and `build.sh` picks up new `.cpp` files.
  That keeps MAME's own build scripts unpatched.
- `emulator/mame`, `emulator/roms`, `emulator/run`, `*.chd` and `*.img` are gitignored, except two images
  the user chose on 2026-11-02 to preserve here: `emulator/roms/maxine-v11.01.chd`, the clean archive.org
  image, and `emulator/roms/maxine-default.chd`, a snapshot of their disk with options enabled, which is what
  `run.sh` starts from. Both are read-only, so never modify them by accident. PROM dumps must never be
  committed, and a real unit's site ID stays out of the repo.
- The host's SHIFT ROW, CHAR and PAGE keys are `HOSTHOLD` in `maxine.cpp`, held only, and win over a panel key's latch.
  To test host keys for real, run with a real window under `xvfb-run` and send `xdotool keydown`, a 120 ms wait and
  `keyup`: `xdotool key` is too short for MAME's input poll. `key_w` is the place to watch, because the firmware doesn't
  read keys from the DUART address a Lua tap can see. The firmware's key names have no centre-character key.
- **Capture:** the driver sends one `$KKRRGGBB` stream, 720×486×4, from a writer thread (`fieldcapture.cpp`) through
  MAME's `osd_file` socket to a Node server on `127.0.0.1` (`src/main/capture.ts`), which pipes it to ffmpeg. One stream
  split by `-filter_complex` is why the two files can't drift apart. The clock is emulated time, so every field is
  written: falling behind fills the 8-frame pool, slows the machine and shows a warning. Don't drop fields to keep up.
  `setparams` sets the tags, because ffmpeg 7 takes colour tags from frames. The fields come from `render_field`,
  sampled by `capture_field` 21 lines after `field_tick`, so they're real interlace. The app sends `capture <port>` and
  `capture stop` on stdin, which is a pipe on all platforms. EOF quits on Windows only. Tested on 2026-11-02 in a Linux
  AppImage and with `maxine.exe` and `ffmpeg.exe` under Wine, whose default prefix can hang, so use a fresh `WINEPREFIX`
  with `WINEDLLOVERRIDES="mscoree,mshtml="`. It hasn't run on a Mac or real Windows, or in an editor.
- `build-ffmpeg.sh` builds a 2 MB LGPL ffmpeg with only ProRes and what feeds it, from a pinned commit on GitHub. Never add
  `--enable-gpl`, and `vendor-emulator.mjs` refuses a build that has it.
- To test a roll: save pages with RCD, `$f1`. It refuses an address that exists, and the default disk has 1000 and 1001.
  Then SET-UP `$ea`, ROLL `$d9`, ROLL to add a row, keypad From, CURSOR R `$8d`, keypad To, NEW LINE `$ce`, Q `$51`. ROLL
  arms it and any key starts it. CRAWL `$d8` in place of ROLL does the same for a crawl. Look at the screen between
  ROLL and the key too, because that's when the firmware copies the page between banks through the `+18` pixel port.
- `tests/script.py` builds input scripts and `tests/drive.lua` plays them. Run them with `-window -video
  none -mouseprovider none -keyboardprovider none`. Any real window takes pointer events from the user's
  mouse despite the providers, which corrupts the test, and leaving out `-window` goes fullscreen. Set
  `SDL_VIDEODRIVER=dummy` too, or a blank window opens on the user's screen; snapshots still work.
  `tools/dis68.py` disassembles firmware, and modules are at file offset = address − load base.
- Bring-up technique: `-debug -debugger none -autoboot_script x.lua` runs headless with breakpoints.
  `cpu.debug:bpset(addr, cond, 'logerror "...",d0; g')` logs to `error.log` (`-log`), and a breakpoint
  on `$ffe00024`, the `TRAP #11` entry, traces every pSOS+ call. `LOG_REGS`, `LOG_SCSI` and
  `LOG_HEARTBEAT` in `maxine.cpp` are off by default; turn them on with `VERBOSE`.
- A new NVRAM comes from `ROM_START` in `maxine.cpp`: the SCSI disk entry, both serial records, `$262` and tablet type
  `$411` = 1, using the values Setup wrote on this unit. `nvramDefaults()` in `shared/nvram.ts` has to match. An
  existing NVRAM file is left alone, and it's the only place these live, not the disk. The Loader's serial warning
  tests only `$262`, so scripted runs have no warning to dismiss. Run them one at a time: two side by side dropped
  Logo Compose into menu mode once.
- pSOS+ fatal errors land in pROBE+, which then loops reading the console for `S`, so a stack in
  `$ffe1c7ea` means something failed earlier.

## Open questions (need hardware)

1. Meaning of the glyph-record spacing hints (s8 at byte 1, u16 bits 15..4)
   and of `0xda`. Only matters for spacing polish.
2. Exact border/shadow geometry (ours is symmetric; the originals' border is
   one row thinner at the bottom) and whether the device recolors layer 2 as
   one color or distinguishes border from shadow some other way.
3. Whether `0xd8`/`0xf8`/`0xfe` affect on-screen line layout or are only
   informational.
4. Which pacing setting stops the batch-upload lockups (see the FTP notes), and
   whether a hung unit comes back on its own or needs a power cycle. Any cleaner
   capture than a phone photo.

5. Is the CPU card really an MVME162, and is Chyron's boot code in its EPROM or Flash?

## History

- 2026-08-19 sessions (Opus): located the name strings, the glyph table at
  0x252 (actually part of a table starting at 0x108) and the row terminator,
  but modeled the glyph data as signed fixed-point outline coordinates. That
  model was wrong; the earlier tools and the Q15/"ring fill" renderer were
  removed on 2026-10-30. The `.9001`–`.9006` zeroing experiments were never
  reported back and are superseded.
- 2026-10-30 (Fable): re-derived the format from the raw bytes: 192-record
  table, RLE 8-bit bitmap runs with layers/overlays, kerning table, footer
  thumbnail, header metrics; wrote `tools/maxine_font.py` and
  `tools/ttf2maxine.py`; generated `experiments/.9100`–`.9103` for hardware
  testing.
- 2026-10-31 (Opus): replaced the local web GUI with an Electron app (two tabs,
  fonts saved to a temp folder, unsigned builds for mac/win/linux) on the same
  stack as Luminary/SuperGroup. Added a source preview and side-by-side compare.
- 2026-11-01 (Opus): probed the live unit's FTP server and reworked the app around
  it: no login fields, active mode only, fixed font folder, sizes verified from `LIST`.
- 2026-11-01 (Fable): first hardware confirmation that converted fonts load and render.
  Found the 30×30 browser icon in the footer and made the converter draw it. A multi-font
  upload hung the unit; FTP became one persistent session with a Disconnect button,
  and when that still locked up after three files, a pause between files was added.
- 2026-11-01 (Opus): started the MAME emulator. Booted the 11.01 image to the Program Loader on a stub
  boot, and found from the firmware's behaviour that the CPU card is an MVME162. Then keyboard,
  mouse, frame buffer, Message Compose, and the output split, into 2026-11-02.
