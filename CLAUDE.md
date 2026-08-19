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
Multi-byte numeric fields observed appear **big-endian**. A parser
implementing everything below lives at `tools/parse_maxine_font.py` — run
`python3 tools/parse_maxine_font.py fonts/.0000 --dump-glyph 'A'` to explore.
It is unvalidated against hardware, same caveat as everything here.

**2026-08-19 offline session**: did a from-scratch static re-analysis of
`.0000` (no hardware access this session — see summary at the bottom of this
section). Corrected several offsets/values from earlier notes (verify against
hex, not the old prose, if the two ever disagree) and found the glyph index
table, which earlier passes had missed entirely. That table is the single
biggest structural finding so far.

- `0x00 - 0x08`: magic/flags. `00 00 01 f4` then 4 bytes that vary — `.0000`
  (a "no edge" font) has `ff ff ff ff` here; every other sampled file (which
  all have borders/shadows) has `00 00 28 16` (`0x2816` = 10262). Hypothesis:
  this field signals presence/absence of a border layer, or points to
  shared/absent border data. Untested.
- `0x08 - 0x44` (60 bytes): **font name string**, null-padded
  (e.g. `"Swiss 721 Bold(TM)"`). CONFIRMED correct via hardware test.
- `0x44 - 0x84` (64 bytes): **two null-terminated strings back to back**, not
  one descriptive blob as originally logged. In `.0000`: string 1 =
  `"  46 scanlines No edge "`, string 2 (starts right after string 1's null)
  = `" 4 lines "`, then zero padding to fill the 64 bytes. Bordered fonts show
  things like `"  36 scanlines Border "` / `"  2 lines"` — string 2 appears to
  be a **line-count field independent of edge treatment** (`.0000` has no
  border yet still carries a "4 lines" second string), so it's probably not
  "border line count" as first guessed — possibly text line spacing/leading.
  Unconfirmed. Human-readable, presumably for a file-browser UI on the device.
- `0x84 - 0xc0` (60 bytes): name string repeated a second time. Corrected
  layout: **4 zero bytes, then the name string**, not 8 as originally noted
  — verify against hex if adapting the parser to other files. Purpose of the
  duplication still unclear.
- `0xc0 - 0x100` (64 bytes): numeric metrics block. Byte-exact sub-fields
  (corrected/tightened from earlier pass):
  - `0xc0-0xcd` (14 bytes): zero/reserved.
  - `0xce-0xd5` (8 bytes): ASCII digit string, e.g. `"50050000"` — meaning
    still unknown (product/catalog code? serial?).
  - `0xd6-0xd7` BE16 = **46** (scanline count, redundant with description
    text).
  - `0xd8-0xd9` BE16 = **33** = ASCII `'!'` = **CONFIRMED `firstChar`** — see
    glyph table below, which starts exactly at char 33 and its contents match
    the photographed hardware output character-for-character.
  - `0xda-0xdb` BE16 = **51**, still unresolved. Given the glyph table (below)
    now shows the *real* character range is 33-122 (90 slots), 51 is almost
    certainly not `lastChar`/count. Open guess: unrelated numeric code, or a
    kerning-table size, or something not yet located.
  - `0xdc-0xe5` (10 bytes): zero/reserved.
  - `0xe6-0xe9` BE32 = 118760.
  - `0xea-0xed` BE32 = 115944 (earlier notes said 116456 — that was a hand
    hex-parsing error; 115944 is the byte-exact value, verify via the parser
    script if it matters). Diff from the previous field: 2816 = `0xb00`.
  - `0xee-0xef` BE16 = 588 (previously undocumented).
  - `0xf0-0xf1` BE16 = 38 (previously undocumented; close to but not equal
    to the 46-scanline count — candidate x-height/ascender-ish metric).
  - `0xf2-0xf7` (6 bytes): zero/reserved.
  - `0xf8-0xf9` BE16 = 9, `0xfa-0xfb` BE16 = 9, `0xfc-0xfd` zero,
    `0xfe-0xff` BE16 = 11. (Matches earlier "9, 9, 11" note, now with exact
    offsets.) All four of these small metrics + the 588/38 pair are
    candidates for generic typographic metrics (underline
    position/thickness, ascender/descender, etc.) rather than border-specific
    values, since they're present and nonzero even in `.0000` which has no
    border/shadow. Unconfirmed.
- `0x100 - 0x140` (64 bytes): a table of **4 entries, 10 bytes each**,
  starting at `0x104` (`0x100-0x103` is a zero/reserved prefix). Each entry:
  `[BE16 16896][BE16 0][BE16 42001][BE16 0][BE16 increment]`, where the first
  four fields are constant across all 4 entries and only the last field
  varies: **0, 128, 224, 320** in `.0000` (deltas 128, 96, 96 — not a uniform
  arithmetic step, corrects the "consistent delta" framing in the original
  note, which was about deltas *between sibling files*, not between the 4
  entries within one file). Confirmed via `.3000`/`.3001` diff that the whole
  table shifts with scanline count. Candidate: 4 vertical metric positions
  (e.g. ascender / cap-height / x-height / baseline) in an unknown
  fixed-point unit. **Still needs a targeted hardware test.**

### Glyph index table — `0x252` to `0x5d6` (NEW — the major find this session)

Immediately after the 4-entry table above (with ~300 bytes of zero padding
in between, `0x140`-`0x252`), there's a clean, fully-decodable **glyph index
table**: 90 fixed-size 10-byte records, one per character code from
`firstChar` (33, `'!'`) through 122 (`'z'`) inclusive — i.e. `char = 33 +
slot_index`. Confirmed by the fact that decoding it this way reproduces
*exactly* the character set visible in the hardware photo (see "Confirmed
findings" above): every ASCII code that has a real (non-zero) record is a
character that was actually typed and rendered on screen, and every blank
record is a character that's absent from a standard keyboard / wasn't
tested: `" # + = @ [ \ ] ^ _ \``. This is about as strong a static-only
confirmation as you can get without touching hardware.

Record layout (5 big-endian 16-bit fields, 10 bytes):

```
[ tag:BE16 ][ flags:BE16 ][ width_field:BE16 ][ offset_hi:BE16 ][ offset_lo:BE16 ]
```

- `tag`: constant `0x4200` (16896) for almost all glyphs. A handful of
  glyphs perturb the low byte by a small signed-looking amount (e.g. `0x4201`,
  `0x4206`, `0x4208`, `0x42fb` = 0x4200-5, `0x42fa` = 0x4200-6) — candidate
  per-glyph adjustment (kerning? left-bearing correction?), unconfirmed, and
  doesn't obviously correlate with anything visible yet.
- `flags`: 0 for most glyphs; small values `0x10`, `0x20`, `0x420` seen on
  others — candidate bitfield flags, unconfirmed.
- `width_field`: loosely tracks visual width (bigger for `W`/`M`/`%`,
  smaller for `I`/`l`/punctuation) but has many exact duplicate values across
  differently-shaped glyphs (e.g. `,` and `.` share the identical value
  37902), so it is not a clean per-glyph pixel width — likely a coarser
  quantized class or a different unit than pixels. Unconfirmed.
- `offset_hi`/`offset_lo`: together form a **BE32 cumulative byte offset**
  into the bulk glyph-data region (see below). **Confirmed monotonically
  increasing across every one of the 79 non-blank glyphs in `.0000`**, with
  no exceptions — this is a real offset table, not noise. (The two 16-bit
  halves genuinely behave as one 32-bit value: `offset_hi` increments by 1
  exactly when `offset_lo` would wrap past 65535, e.g. `'S'` has `offset_hi=0,
  offset_lo=64916` and `'T'` has `offset_hi=1, offset_lo=1256` →
  65536+1256=66792 > 64916, consistent, not a coincidence.)

**Bulk data base address**: empirically, the first non-zero byte after the
glyph table's trailing zero-padding, which for `.0000` is **`0x889`**. A
glyph's byte range in the file is `[0x889 + offset, 0x889 + next_offset)`
where `next_offset` is the offset of the next *defined* glyph in cumulative
order (blank slots contribute no bytes, i.e. they're just skipped, not
zero-length placeholders). This has NOT been shown to derive from a header
field yet — for `.0000` it just happens to be where the padding ends. If
adapting this to other files, verify it the same way (scan for the padding
boundary) rather than assuming `0x889` is a fixed constant.

Per-glyph byte sizes computed this way range from 132 bytes (`-`, hyphen) up
to 2804 bytes (`W`), and **strongly correlate with visual complexity/width**:
thin marks (`-`, `.`, `'`, `:`) are consistently under ~500 bytes, wide
capitals (`W`, `M`, `%`) are consistently over ~2500 bytes. This is a good
independent sanity check that the offset table is being decoded correctly.

### Bulk glyph data region — `0x889` through roughly `0x1d000`-`0x1d400`

This corrects the original "high-entropy noise, not raster, not obviously
vector either" framing. Byte-level inspection (not just statistics) shows the
region is **highly structured**, not noise:

- It's built from **4-byte records**: `[0x01][hibyte][lobyte][0x00]`. The
  first byte is (so far, always observed) `0x01`; the last byte is `0x00` in
  the overwhelming majority of records. The middle two bytes read naturally
  as a **signed BE16 value** — most cluster near 0 or near the extremes of
  the 16-bit range, consistent with a normalized fixed-point coordinate
  (e.g. Q15-style, roughly -1.0..+1.0 scaled to ±32768) rather than raw pixel
  positions. This is what the original entropy/byte-parity analysis was
  actually picking up on — it wasn't wrong that there's structure, it just
  hadn't found the record boundaries yet.
- A specific record, `01 00 03 00`, recurs constantly and behaves like an
  **end-of-row marker**: the records between two consecutive occurrences of
  it form one scanline's worth of data, and the number of records per group
  varies (4-6 typically) rather than being fixed. Grouping by this marker and
  counting groups per glyph gives a "rows with ink" count that's always ≤46
  (the file's scanline count) and tracks typographic expectations well: pure
  x-height lowercase letters (`a c e m n o r s u v w x`) land around 25-27
  rows, ascender/descender-bearing letters and tall punctuation (`( ) ; j`)
  land around 33-44 rows, and the hyphen — correctly — needs only 6 rows
  total (it's a short bar spanging just a few scanlines at mid-height).
  `tools/parse_maxine_font.py`'s `row_count()` implements this count.
- A bare `00 00 00 00` record appears exactly once, right at the very end of
  each glyph's byte range — reads as an **end-of-glyph terminator**, distinct
  from the per-row `01 00 03 00` marker.
- Net effect: this **confirms the original delta/outline hypothesis** at a
  much more specific level than before. It is NOT raw bitmap/pixel data (that
  was already ruled out by the earlier width-guessing image renders, and
  still holds). It looks like **per-scanline lists of signed fixed-point
  X-coordinates** (candidate: edge crossings, possibly paired for
  antialiasing inner/outer boundaries — a flat-sided glyph like `I` shows the
  same 5-coordinate group repeating across ~20 consecutive rows, which fits
  "left edge, right edge, plus a couple of AA-adjacent values, unchanging
  while the outline is straight"). The exact geometric meaning of each
  coordinate slot (which one is left/right/AA-inner/AA-outer, what the fixed-
  point scale is, whether Y is implicit-by-position or also encoded) is
  **still unconfirmed and would benefit enormously from a hardware test** —
  e.g. rendering a hand-decoded guess of one simple glyph (`-` or `.`, both
  under 200 bytes) as an actual raster and eyeballing it, or better,
  synthesizing a deliberately-modified glyph and loading it on the unit to
  see what changes.
- **`bulk_base` and the glyph table together account for essentially the
  entire "large bulk region" the original notes described starting at
  `0x140`** — that starting offset was wrong; `0x140`-`0x252` is mostly zero
  padding, `0x252`-`0x5d6` is the glyph table (see above), and the true bulk
  payload doesn't start until `0x889`.

### Tail region — the ~7KB antialiased mask block

Re-scanned this region's actual boundary more precisely than before: byte
diversity per 1KB window drops off gradually from `0x1c000` (114 distinct
byte values) through `0x1d000` (82 distinct values), then **sharply**
collapses to just 6-8 distinct values — all multiples of `0x22` (34):
`0x00, 0x22, 0x44, 0x66, 0x88, 0xaa, 0xcc, 0xee` — somewhere between
`0x1d000` and `0x1d400`. That's a tighter localization than the original
"~0x1cc00/0x1d000" estimate. It also now lines up much better with the glyph
table: `'z'`, the last defined glyph, starts at `0x889 + 115072 = 0x1ca09`;
its true end (this region's start) is somewhere in the `0x1d000`-`0x1d400`
range, meaning `'z'`'s own glyph data is roughly 1.5-2.5KB — right in line
with the other letters' sizes (`x`/`y` are 1284/1628 bytes). So this
"antialiased mask" block is **not part of the glyph table's addressable
range** — it sits after the last real glyph, structurally separate. Nature
still unclear (single specimen/preview bitmap? shared AA ramp/LUT?
something else?) — same open question as before, just now with a firmer
boundary to target for a zero-out test.
- Common suffix: `.3000` and `.3001` (same font, different scanline count)
  share an **exact 2190-byte identical suffix** at the end of the file — some
  kind of fixed footer/template, constant regardless of size variant. Worth
  checking whether this suffix overlaps with the "8-level antialiased" tail
  region described above — not yet checked.

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

## Suggested next hardware tests (added 2026-08-19, once `.9001`-`.9006`
results are in)

Now that the glyph table (`0x252`-`0x5d6`) and per-glyph byte ranges within
the bulk region (base `0x889`, see above) are known precisely, much more
surgical tests are possible than the earlier broad zero-range experiment:

1. **Isolate one glyph's coordinate semantics.** Take `.0000`, corrupt only
   the byte range for a single simple glyph — `-` (`0x3cfd`-`0x3d81`, 132
   bytes) is the smallest and simplest — by flipping one coordinate value in
   one row record (e.g. change one of the `01 xx yy 00` middle-byte pairs),
   reload, retype a string containing `-`, and photograph. If the hyphen's
   shape/position visibly changes in a way that matches a signed-coordinate
   hypothesis (e.g. making a value more negative shifts an edge left), that
   confirms the coordinate encoding directly.
2. **Test the 4-entry global metrics table** (`0x100`-`0x12f`, candidate
   ascender/cap-height/x-height/baseline positions): zero out just this
   table (leaving the glyph table and bulk data untouched) and see whether
   overall vertical positioning/spacing changes, or whether it breaks
   loading entirely.
3. **Test the antialiased tail region** boundary now located more precisely
   at `0x1d000`-`0x1d400` through EOF: zero it out (distinct from the
   original broad `.9001`-`.9006` cuts, which likely used a cruder boundary
   estimate) and see whether anything visibly changes — if nothing changes,
   that's evidence it's a preview/specimen artifact unrelated to normal
   rendering; if text goes missing or garbles, it's load-bearing.
4. **Confirm `width_field`** (3rd field of each glyph-table record):
   deliberately edit it for one glyph (e.g. double it) without touching that
   glyph's bulk data, reload, and see if the character's advance
   width/spacing changes on screen without its shape changing — would
   confirm it's a spacing metric independent of the outline data itself.

As always: use unused `.9xxx` codes, and stop immediately and report back if
anything fails to load, hangs, or crashes the unit.
