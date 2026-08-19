# Chyron MAXINE font format reverse engineering

## Goal

Reverse engineer the proprietary font file format used by a vintage Chyron
MAXINE character generator (broadcast lower-thirds/titling hardware), well
enough to write a **TTF → MAXINE font converter**. Target fidelity: best-effort
visual match, not byte-exact replication of the internal encoding.

## Assets

- `fonts/` — 36 original font files pulled from the MAXINE unit, named as
  dotfiles with 4-digit codes (`.0000`, `.0111`, `.1111`, `.2222`, `.3000`-
  `.3013`, `.3333`, `.5000`-`.5016`). **The 4-digit dotfile naming convention
  appears required** for the device to recognize a file as a font — use it
  for any new test files too.
- `experiments/` — synthetic test files (byte-mutated copies of originals)
  used for differential/black-box testing against the real hardware. See
  `experiments/MANIFEST.md` for the current batch.

## Ground truth / test loop (IMPORTANT — we have real hardware)

The user has the **actual MAXINE unit** (not just files), connected to a Sony
CRT for output. This is a huge advantage — use it aggressively.

- **File transfer**: MAXINE is reachable over the network via a standard file
  share (FTP/SMB/NFS — exact protocol/host not yet gathered from user, ask
  again if it becomes worth automating). For now, transfer is **manual**: the
  user copies test files onto the unit themselves.
- **Feedback loop**: also manual for now. The user loads a font, types a
  sample string, and **photographs the CRT screen**, then shares the photo in
  chat. There is no automated capture/video grab set up yet.
- Confirmed: typing a **crafted byte-mutated file that fails to load** is a
  live risk to test for — ask the user to stop and report immediately if a
  test file fails to load, hangs, or crashes the unit, rather than pushing
  through. (No crash has occurred yet as of this writing, but only ~6 test
  files have been tried and results not yet reported back.)
- Standard test string for baseline comparisons (typed with the user's own
  line breaks to fit the screen):
  ```
  ABCDEFGHIJKLM
  NOPQRSTUVWXYZ
  abcdefghijklm
  nopqrstuv
  wxyz
  1234567890
  !$%'&*(),-/
  ```
  Note: the punctuation the user actually typed was "whatever punctuation
  keys were on the keyboard, in keyboard order" — NOT the literal ASCII
  sequence originally requested. Shapes were correlated visually and found to
  be standard ASCII-shaped glyphs (`! $ % ' & * ( ) , - /`). Treat any
  trailing box/rectangle glyph in a photo as the **text cursor**, not a real
  character — confirmed by user, not an "undefined glyph" placeholder as
  originally hypothesized.

## Confirmed findings

1. **Font display name is real and correctly parsed**: loading `.0000` on the
   device shows "Swiss 721 Bold(TM)" — matches the string parsed from the
   file header. Header layout confirmed for this field.
2. **Visual rendering of `.0000`**: proportionally-spaced (variable width),
   bold, sans-serif — consistent with a Helvetica-Bold-alike, no visible
   border/shadow — consistent with header text "No edge".
3. Punctuation glyphs are standard ASCII shapes (see above) — working
   assumption is the format indexes glyphs by **standard ASCII code**
   internally, not a custom/keyboard-scancode order. Not yet proven by a
   byte-level test, just inferred from shapes rendering correctly.

## File structure findings (from static analysis, not yet hardware-validated
byte-by-byte)

All offsets below are for `.0000` (124750 bytes / 0x1e74e) unless noted.
Multi-byte numeric fields observed appear **big-endian**.

- `0x00 - 0x08`: magic/flags. `00 00 01 f4` then 4 bytes that vary — `.0000`
  (a "no edge" font) has `ff ff ff ff` here; every other sampled file (which
  all have borders/shadows) has `00 00 28 16` (`0x2816` = 10262). Hypothesis:
  this field signals presence/absence of a border layer, or points to
  shared/absent border data. Untested.
- `0x08 - 0x44` (60 bytes): **font name string**, null-padded
  (e.g. `"Swiss 721 Bold(TM)"`). CONFIRMED correct via hardware test.
- `0x44 - 0x84` (64 bytes): human-readable **description string**, e.g.
  `"  46 scanlines No edge   4 lines "` or (bordered fonts)
  `"  36 scanlines Border    2 lines"` / `"  22 scanlines Border & Shdw    4
  lines lower left"`. This is clearly meant for a human-facing file browser
  on the device, and encodes: scanline count (= point size proxy), edge
  treatment (No edge / Border / Border & Shdw), border line count, and for
  shadow fonts a shadow direction ("lower left" seen in `.5000`).
- `0x84 - 0xc0`: name string repeated a second time (padded differently —
  leading zero bytes then the name). Purpose of the duplication unclear
  (maybe distinguishes a "short name" vs "full name" field with different
  max lengths — need more samples to confirm).
- `0xc0 - 0x100`: numeric metrics block. Known sub-fields (see hex example
  below):
  - an 8-digit ASCII numeric string, e.g. `"50050000"` — meaning unknown,
    possibly a product/catalog code or serial number. Changes between sibling
    files (`.3000` has `"53403000"`, `.3001` has `"53403000"`... actually
    verify — see raw diff notes below).
  - three 16-bit big-endian values immediately after, e.g. `46, 33, 51` for
    `.0000`. `46` matches the "46 scanlines" in the description text. `33` =
    ASCII `'!'`, the first printable punctuation character — **hypothesis:
    this is `firstChar` of the font's defined character range**. Meaning of
    `51` unresolved (ASCII 51 = `'3'`, almost certainly coincidental, does
    NOT appear to be `lastChar` since the alphabet a-z clearly renders fine
    and 'z' = 122 >> 51).
  - two 32-bit big-endian values, e.g. `0x0001cfe8` (118760) and
    `0x0001c4e8` (116456) for `.0000`. Differ meaningfully between the
    `.3000`-`.3013` size series — likely per-size metrics (e.g. total bitmap
    data size, or ascent/descent in some fixed-point unit). Unconfirmed.
  - more small 16-bit values afterward (`9, 9, 11` in `.0000`) — unconfirmed.
- `0x100 - ~0x140`: a **small table of 4 entries, 10 bytes each**, that
  scales predictably with scanline count (confirmed via `.3000` vs `.3001`
  diff — every value in this table shifts by a consistent small delta when
  scanline count changes). Structure per entry (from `.0000`):
  `[8 bytes that look "constant" across the 4 entries][2-byte value that
  increments per entry]`. Likely per-size global metrics (e.g. ascent,
  descent, underline position, cap height) rather than per-glyph data — there
  are only 4 entries, far fewer than the character set size. **Needs a
  targeted hardware test to confirm what these control.**
- `0x140` (in `.0000`) **through end of file minus ~0x1cc00**: large "bulk"
  region, high entropy (~3.5 bits/byte), ~68% nonzero bytes, fairly uniform
  statistics throughout. **Not raw 1-bit or 1-byte-per-pixel bitmap data** —
  rendering it as a raw image at any tested pixel width (32 through 256)
  produces checkerboard/vertical-stripe noise, not letterforms. Byte-parity
  analysis (even vs odd byte position) shows a strong bimodal split: one
  "lane" is small values clustered near 0 (mostly even numbers), the other
  lane clusters near 0 or near 255 in a pattern consistent with **signed
  delta values** (e.g. 250=-6, 248=-8, 240=-16, 224=-32 as two's-complement
  bytes). Working hypothesis: **this is delta/differential-encoded vector
  outline data (spline or polygon control points), rasterized to the stated
  scanline count at load/render time** — NOT a pre-rendered bitmap. This
  would explain why header/description text encodes render parameters
  (scanline count, border width, shadow direction) rather than just being
  descriptive: the device may be scan-converting outlines on load using
  those parameters. **This is the single most important open hypothesis —
  has NOT been validated against hardware yet.**
- Roughly the **last ~7KB of `.0000`** (from about `0x1cc00`/`0x1d000` to
  end, `0x1e74e`): entropy drops sharply, and the byte values are
  **restricted to exactly 8 levels, all multiples of `0x22` (34)**: `0x00,
  0x22, 0x44, 0x66, 0x88, 0xaa, 0xcc, 0xee`. Background/fill value is `0xee`
  (238) with sparse dark blobs — this genuinely looks like **one real
  antialiased raster mask** (3-bit/8-level grayscale antialiasing), unlike
  the rest of the bulk region. Unclear if this is: a single specimen/preview
  glyph, a shared antialiasing ramp/LUT, or something else. Needs a targeted
  test (e.g. zero this specific range and see what visually changes, or
  doesn't).
- Common suffix: `.3000` and `.3001` (same font, different scanline count)
  share an **exact 2190-byte identical suffix** at the end of the file — some
  kind of fixed footer/template, constant regardless of size variant.

## `.3000`-`.3013` sibling series (same font "Dutch 766 Bold", 13 scanline
sizes) — best lever for isolating render-params vs shared data

Diffing `.3000` vs `.3001` header region (`0x0`-`0x200`) shows differences
ONLY at:
- `0x47`: description text scanline count digits (trivial, expected)
- `0xd5`-`0xdb`: part of the numeric metrics block (the ASCII digit string
  and/or the 3x16-bit values right after it)
- `0xe7`-`0xed`: the two 32-bit metrics values
- `0xf9`, `0xfb`: two more small values (`9`→`10`, `9`→`10`)
- `0x10c`-`0x12f`: the 4-entry/10-byte small table described above — ALL 4
  entries shift by consistent deltas

Everything else in the header is byte-identical between `.3000` and `.3001`.
This means **the header format itself is fully stable**; only the specific
numeric values are recomputed per scanline size. Still need to diff the bulk
body region between these two files (not done yet) — if the bulk region also
differs by a consistent pattern, that would strongly confirm the
outline/scan-conversion hypothesis (same outline data, re-rasterized) vs. if
large identical sub-blocks are found verbatim in both, that would suggest
literal shared/copied glyph data instead.

## In-flight experiment (as of this writing — check with user for results)

`experiments/.9001` through `.9006`: copies of `.0000` with different large
byte ranges zeroed out (see `experiments/MANIFEST.md` for exact ranges), to
be loaded one at a time on the real hardware and photographed, in order to
localize which byte ranges affect which on-screen characters. **Results not
yet received as of this file being written — check chat history / ask user
whether these were tested and what happened before doing more analysis.**

## Methodology notes / how to keep working on this

1. This is a **black-box reverse engineering project with real hardware
   ground truth available** — always prefer designing a hardware test over
   further speculation from static byte analysis alone. Static analysis is
   good for generating hypotheses and narrowing down *where* to test, not for
   confirming them.
2. Transfer and testing are **manual** (user copies files to the device and
   photographs the screen) — batch multiple test files/questions per round
   rather than asking for one test at a time, to reduce round-trips.
3. Keep test files named with the device's required 4-digit dotfile
   convention, in unused numeric ranges (currently using `.9xxx` for
   synthetic/experimental files to avoid colliding with real font codes).
4. Good techniques used so far / to keep using:
   - Diffing sibling files that vary in exactly one known parameter (e.g. the
     `.3000`-`.3013` scanline-size series, or `.0000` "no edge" vs bordered
     fonts) to isolate which fields encode which parameter.
   - Entropy/nonzero-byte scanning across a file to find boundaries between
     structured header data and bulk/payload data.
   - Rendering byte regions as raw images at various guessed pixel widths to
     check (by eye) for recognizable letterforms — useful for finding real
     bitmap/raster regions (worked for the last ~7KB of `.0000`), but
     produces obvious noise/checkerboard patterns when the region is NOT raw
     per-pixel data, which is itself informative (ruled out simple bitmap
     encoding for most of the file).
   - Byte-parity/statistical analysis (odd vs even position value
     distributions) to distinguish "raw bitmap" from "structured
     records/delta-encoded data".
   - Zeroing out byte ranges and observing what breaks on real hardware
     (current in-flight experiment) — the most direct way to localize
     regions to specific glyphs/features.
5. Once the glyph table / per-character data layout is understood, the
   converter pipeline will roughly be: parse TTF outlines (e.g. via
   fontTools) → for each target scanline size, sample/rasterize (or
   re-encode as whatever the native delta/outline format turns out to be) →
   pack into a `.NNNN` file matching this format → test-load on hardware →
   iterate.

## Open questions for the user (ask if picking this up fresh and these are
still unanswered)

- Results of the `.9001`-`.9006` zero-range experiment.
- Exact network protocol/host/credentials for MAXINE's file share, if we
  ever want to automate test-file transfer instead of manual copying.
- Whether there's any way to get a cleaner capture of the CRT output than a
  phone photo (e.g. a video capture card) — not required, but would reduce
  photo-artifact noise (moiré/color fringing from photographing a CRT) when
  reading fine glyph detail.
