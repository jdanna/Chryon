# Chyron MAXINE font format reverse engineering

## Goal

Reverse engineer the proprietary "Machine Font" file format used by a vintage
Chyron MAXINE! character generator (iNFiNiT! family, broadcast lower-thirds
hardware) well enough to write a **TTF → MAXINE font converter**, for
preservation of these systems. Target fidelity: best-effort visual match.

**Status (2026-10-30): the format is decoded end to end offline.** The glyph
data is a run-length-encoded 8-bit antialiased bitmap, not outlines. A
reader/writer and a TTF converter exist in `tools/` and round-trip all 36
original files. Nothing produced by the converter has been loaded on the
hardware yet — that is the next step (see `experiments/MANIFEST.md`).

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
  (only the 66×79 preview thumbnail inside it is regenerated per font).

## Ground truth / test loop (we have real hardware)

The user has the actual MAXINE unit connected to a Sony CRT. Transfer is
manual (user copies files over the unit's network share), feedback is a
phone photo of the CRT. Batch several test files per round. **Ask the user
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
and the glyphs typed above all appear as standard ASCII shapes. Everything in
the format section below is from static analysis plus internal consistency
(round-trip, cross-file checks) and matches the one CRT photo we have, but is
not byte-by-byte hardware validated.

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
704-byte table of 16-bit values, a 10-byte header `0042 0042 001e 001e`, then
a 66×79 8-bit **preview thumbnail of "Aa"** (0xee = background, 0x00 = ink,
0x22 steps; the border shows as gray). Only the thumbnail pixels differ
between files. The converter copies `tools/footer_template.bin` and redraws
the thumbnail.

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
version 1317, master id 9000, chars 33–126 (the originals stop at 122; codes
123–191 are untested on hardware).

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
  `scripts/vendor-python-packages.mjs`. One Mac can build all three platforms.
  The interpreter runs with `-I` and `pycache_prefix` under userData, so no
  `.pyc` lands in the install folder.
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
- Fonts are dotfiles, so `ftp_list_entries` tries `LIST -a`, then `LIST`, then
  `NLST`. `ftp_delete` refuses anything but `.9xxx`, so the originals on the unit
  can't be removed from the app. Nothing here has been tried on the real unit.

**This repo is public**, and builds are unsigned. `.env` is gitignored and unused by
the build. `electron-builder.yml` is an allowlist, so it can't be packaged.

Verify in the running app with the headless driver, not `npm run dev`: it uses a
throwaway profile and temp folder and answers message boxes with button 0, which
is the confirming action everywhere in this app. Steps are JSON, see
`scripts/headless/driver.mjs`; within one step, actions run in the order `drop`,
`fill`, `click`, `select`, `wait`, `eval`/`expect`, `shot`. `launch({ binary })`
drives a packaged app, with a visible window and the real temp folder.

## Open questions (need hardware)

1. Do converter outputs load at all? (`experiments/.9100` is the closest A/B
   to `.0000`.) If not, suspects in order: the `0xe6` size hint, the
   `0x04` field, codes >122 in the table, run splitting, the empty-row/EOR
   conventions, the hint bits.
2. Meaning of the glyph-record spacing hints (s8 at byte 1, u16 bits 15..4)
   and of `0xda`. Only matters for spacing polish.
3. Exact border/shadow geometry (ours is symmetric; the originals' border is
   one row thinner at the bottom) and whether the device recolors layer 2 as
   one color or distinguishes border from shadow some other way.
4. Whether `0xd8`/`0xf8`/`0xfe` affect on-screen line layout or are only
   informational.
5. Whether the MAXINE's FTP server accepts the app's commands (`LIST -a`, `SIZE`,
   passive mode) and which folder holds the fonts; any cleaner capture than a
   phone photo.

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
