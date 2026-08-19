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
3. Punctuation glyphs are standard ASCII shapes (see above), and the format
   indexes glyphs by **standard ASCII code** internally — **now confirmed at
   the byte level** by the glyph index table (see "File structure findings"
   below): `firstChar` read from the header is exactly 33 (`'!'`), and every
   character from 33 through 122 that has a real table entry is one that was
   actually typed in the standard test string (with a handful of exceptions
   — see the table section for the precise, audited version of this claim;
   an earlier draft of these notes overstated it slightly).

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

- `0x00 - 0x08`: magic/flags. `0x00000000-0x00000003` = `0x1f4` (500) —
  **audited 2026-08-19: verified identical across all 36 files in `fonts/`**,
  not just a few samples. `0x04-0x08` varies: `.0000` (the only "no edge"
  font in the set) has `ff ff ff ff`; **every one of the other 35 files**
  (all bordered or bordered+shadow) has exactly `00 00 28 16` (`0x2816` =
  10262) — also now checked across the complete set, not just a handful.
  Hypothesis: this field signals presence/absence of a border layer, or
  points to shared/absent border data. Still untested against hardware.
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
- `0x100 - 0x140` (64 bytes): **corrected 2026-08-19 (full audit) — the
  previous version of this entry had the wrong start offset (`0x104`) and
  wrongly folded a standalone field into the entry table.** This was a real
  bug, also present in `tools/parse_maxine_font.py` until this audit (now
  fixed — see the file). Verified-correct layout:
  - `0x100-0x103` (4 bytes): zero/reserved.
  - `0x104-0x105` BE16 = **1314** in `.0000` — a standalone field, NOT part
    of the entries below. Meaning unknown.
  - `0x106-0x107` (2 bytes): zero.
  - `0x108-0x12f` (40 bytes): a table of **4 entries, 10 bytes each**,
    starting at `0x108`. Each entry: `[BE16 16896][BE16 0][BE16 42001][BE16
    0][BE16 increment]`, where the first four fields are constant across all
    4 entries and only the last field varies: **0, 128, 224, 320** in
    `.0000` (deltas 128, 96, 96 — not a uniform arithmetic step). Confirmed
    via `.3000`/`.3001` diff that the whole table shifts with scanline
    count (though see the sibling-series section below — the exact diff
    byte ranges there are also slightly imprecise and worth re-checking if
    it matters). Candidate: 4 vertical metric positions (e.g. ascender /
    cap-height / x-height / baseline) in an unknown fixed-point unit.
    **Still needs a targeted hardware test.**

### Glyph index table — `0x252` to `0x5d6` (NEW — the major find this session)

Immediately after the 4-entry table above (with exactly 274 bytes of zero
padding in between, `0x140`-`0x252` — verified byte-for-byte zero, and
verified the table really does stop at `'z'`: slots 90-109 checked and
confirmed all-blank, not just spot-checked), there's a clean, fully-
decodable **glyph index table**: 90 fixed-size 10-byte records, one per
character code from `firstChar` (33, `'!'`) through 122 (`'z'`) inclusive —
i.e. `char = 33 + slot_index`.

**Character-set claim, precisely audited 2026-08-19 (an earlier pass
overstated this)**: the defined (non-blank) set is exactly
`!$%&'()*,-./0123456789:;<>?ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz`
(79 glyphs), and the blank set is exactly `" # + = @ [ \ ] ^ _ \`` (11
slots). Checked precisely against the documented test string (see "Ground
truth" above, which is `A-Z a-z 0-9 ! $ % ' & * ( ) , - /`):
- **`.` `:` `;` `<` `>` `?`** are defined in the table but were **never
  actually typed** in the documented test string — so, unlike the rest of
  the defined set, their on-screen appearance is *not* verified against the
  photo. They're a real, non-zero table entry (that part is fact), but
  whether they render correctly is still open.
- The claim that blank slots are "absent from a standard keyboard" was
  **wrong and has been removed** — every one of `" # + = @ [ \ ] ^ _ \``
  is a normal key (with shift, on a US layout) on any standard keyboard.
  The honest framing: these 11 codes are blank in the table for a reason
  that's still unknown — could be genuinely undefined in this font, or
  could be defined-but-untested via a different lookup path. They simply
  weren't in the one sample string that was typed and photographed; that's
  the only thing actually established.

None of this changes the overall confidence that the table is real and
character-indexed by ASCII — the 73 glyphs that *were* both defined and
typed match the photo, which is still strong confirmation of the core
mechanism. It just means "every defined slot is photo-verified" was an
overclaim; "the mechanism is photo-verified, using a majority of the
defined slots as evidence" is the accurate version.

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
- `width_field`: **correction (2026-08-19, later pass) — does NOT track
  visual width**, contrary to what an earlier pass in this same session
  claimed without checking specific pairs. `I` (10256), `M` (10285), and `W`
  (10289) — visually very different widths — are nearly identical, while
  `,` and `.` (tiny glyphs) share the *largest* value in the whole table,
  37902. Whatever this field is, it is not a per-glyph pixel/advance width.
  Genuinely unknown; don't reuse the old "tracks width" framing.
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

### Bulk glyph data region — `0x889` through roughly `0x1d080`-`0x1d100`

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
  it form one scanline's worth of data. The number of records per group is
  NOT "4-6 typically" as an earlier pass claimed — **audited 2026-08-19
  across every row of every glyph in `.0000` (2485 rows total): the true
  range is 1-28**, distributed roughly: straight-sided letters cluster
  4-7, diagonal/curved letters cluster 10-20 (see the "clean, non-overlapping
  split" finding further down), with rare 1-2-value rows at the very tips of
  some glyphs. Grouping by this marker and counting groups per glyph gives a
  "rows with ink" count that's always ≤46 (the file's scanline count) and
  tracks typographic expectations well: pure x-height lowercase letters
  (`a c e m n o r s u v w x`) land around 25-27 rows (audited exactly:
  a27 c27 e27 m26 n26 o27 r26 s27 u26 v25 w25 x25), ascender/descender-bearing
  letters and tall punctuation (`( ) j` = 44, `;` = 33) land around 33-44
  rows, and the hyphen — correctly — needs only 6 rows total (audited
  exactly: 6). `tools/parse_maxine_font.py`'s `row_count()` implements this
  count.
- A bare `00 00 00 00` record appears exactly once, right at the very end of
  each glyph's byte range — reads as an **end-of-glyph terminator**, distinct
  from the per-row `01 00 03 00` marker. **Audited 2026-08-19**: true for all
  78 glyphs whose byte range is derived from a real next-glyph table offset
  (zero exceptions). The one glyph where this check fails is `z` — expected,
  since `z` is the last glyph and has no "next" table offset to bound it; its
  size is a heuristic estimate (see `_estimate_tail_boundary`) that reads
  into the antialiased tail block, which itself contains `0x00` bytes and so
  produces spurious extra matches. Not a contradiction of the claim, just a
  reminder that `z`'s exact end is still an estimate, not a proven fact.
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

Re-scanned this region's actual boundary — **audited 2026-08-19, pinned down
further**: byte diversity per 1KB window drops off gradually from `0x1c000`
(114 distinct byte values) through `0x1d000` (82 distinct values), then
**sharply** collapses to just 6-8 distinct values — all multiples of `0x22`
(34): `0x00, 0x22, 0x44, 0x66, 0x88, 0xaa, 0xcc, 0xee`. Narrowed with a finer
(0x40-byte) scan: the last window with >16 distinct values starts at
`0x1d080`, and the collapse is complete by `0x1d100` — so the real boundary
is in the tight range **`0x1d080`-`0x1d100`**, not the coarser "somewhere
between `0x1d000` and `0x1d400`" estimate from the previous pass. It also
lines up well with the glyph table: `'z'`, the last defined glyph, starts at
`0x889 + 115072 = 0x1ca09`; its true end (this region's start) is now
pinned to `0x1d080`-`0x1d100`, meaning `'z'`'s own glyph data is roughly
2.0-2.3KB — right in line with the other letters' sizes (`x`/`y` are
1284/1628 bytes). So this "antialiased mask" block is **not part of the
glyph table's addressable range** — it sits after the last real glyph,
structurally separate. Nature still unclear (single specimen/preview
bitmap? shared AA ramp/LUT? something else?) — same open question as
before, just now with a much firmer boundary to target for a zero-out test.
- Common suffix: `.3000` and `.3001` (same font, different scanline count)
  share an **exact 2190-byte identical suffix** at the end of the file — some
  kind of fixed footer/template, constant regardless of size variant. Worth
  checking whether this suffix overlaps with the "8-level antialiased" tail
  region described above — not yet checked.

## `.3000`-`.3013` sibling series (same font "Dutch 766 Bold", 13 scanline
sizes) — best lever for isolating render-params vs shared data

Diffing `.3000` vs `.3001` header region (`0x0`-`0x200`) byte-by-byte —
**re-audited 2026-08-19 with an exact diff, not an approximate range**:
differing byte offsets are `0x47`; `0xd5, 0xd7, 0xd9, 0xdb` (not the whole
`0xd5`-`0xdb` span — it's every other byte, i.e. only the low byte of each
value changes since the deltas are all small); `0xe7-0xe9, 0xeb-0xed`; `0xf9,
0xfb`; and `0x10c-0x10d, 0x10f-0x111, 0x116-0x117, 0x119-0x11b,
0x120-0x121, 0x123-0x125, 0x12a-0x12b, 0x12d-0x12f` (scattered within the
4-entry table region, consistent with only some bytes of each BE16 changing
— note these files are bordered, so this table's real start offset for
*this* file family hasn't been independently re-derived the way `.0000`'s
was; treat exact byte positions here as relative evidence between `.3000`
and `.3001`, not as confirmed absolute offsets). Everything else in the
header is byte-identical between `.3000` and `.3001`.
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

**Audited 2026-08-19**: verified all 6 files against `.0000` byte-for-byte —
each zeros exactly its documented range (the manifest's boundary offsets
occasionally land on a byte that was already `0` in the original, so the
*visible* diff start is sometimes a few bytes later than the documented
start — that's expected, not a bug in the experiment files). Useful context
now that the glyph table location is known: **`.9001` (zeros
`0x140`-`0x1000`) wipes out the ENTIRE glyph index table** (`0x252`-`0x5d6`)
plus roughly the first ~2.9KB of real glyph bulk data (up to partway through
`'A'`, per the offsets in the glyph-table section above) — so if `.9001`
failed to load or rendered garbage/blank text, that's consistent with the
glyph table being load-bearing (expected), not surprising. `.9002`-`.9006`
each fall entirely within the bulk glyph-data / tail region and don't touch
the header or glyph table at all.

## External research (2026-08-19, web search — no hardware, no code changes)

Searched the web for anything on the MAXINE/iNFiNiT! font format. No binary
format specification exists publicly anywhere — this really is undocumented,
confirming the reverse-engineering approach is the only path. But found real,
useful provenance/terminology context:

- MAXINE! is part of Chyron's **iNFiNiT! family** of character generators
  (first iNFiNiT! shipped late 1989; MAX!> and MAXINE! followed). Documented
  at [cg-wiki.org/chyron/maxine](https://cg-wiki.org/chyron/maxine) (blocked
  direct fetch, 403) and in the [CHYRON iNFiNiT! series Operation Manual,
  Pub. No. 2A01976, March 1999](https://www.manualslib.com/manual/1215325/Chyron-Infinit-Series.html)
  (978 pages, on ManualsLib — only the cover page and safety-warning pages
  were actually readable through the fetch tool, not the technical body).
- **Confirmed font provenance**: iNFiNiT! systems shipped with "the supplied
  Bitstream Typeface Library catalog... 1,500+ available Master Fonts."
  `Swiss 721 Bold` (`.0000`'s font name) is literally Bitstream's clone of
  Helvetica Bold; `Dutch 766 Bold` (the `.3000`-`.3013` series) is
  Bitstream's version of Imprint, a classic serif face, copyright 1990-93
  Bitstream Inc. Both trace directly to the same Bitstream OEM library the
  manual describes — strong independent confirmation that "Master Font"
  really does mean an off-the-shelf Bitstream outline font, not something
  Chyron-specific.
- **Correct terminology, worth adopting going forward**: the manual's own
  pipeline is Master Font (Bitstream/PostScript-like outline) → **Font
  Create Utility** (Section 18 of the manual; Flash Font is Section 13) →
  **Machine Font** (the device-native file — this is what our `.0000`
  etc. files actually are). An "Advanced Font Create Utility" variant adds
  more edge styles (bevels, neon, glow, chisel, etc.) beyond the 3 we've
  seen so far (No edge / Border / Border & Shadow) — worth keeping in mind
  if a font sample ever turns up with an edge style outside that set.
- Bitstream's own outline format (Speedo, `.spd`, header literally starts
  `D1.0\r\n`) is well documented
  ([Wikipedia](https://en.wikipedia.org/wiki/Bitstream_Speedo_Fonts)) but
  **`.0000` does not start with that header and its structure looks
  nothing like a generic outline-font container** — Chyron's Font Create
  Utility clearly converts/rasterizes the Master Font into their own
  scanline-oriented Machine Font format (matching everything found by
  static analysis above), it isn't just a renamed Speedo file. No direct
  format inheritance to exploit here, just confirms the two-stage
  pipeline's existence.
- Chyron's *other*, older CG product line ("Scribe") has its own "Advanced
  Font Create Utility" manual archived at [archive.org](https://archive.org/details/chyron-scribe-operator-manual/)
  (24.7MB PDF, not fetched — Scribe predates the iNFiNiT!/MAXINE family and
  is a different hardware generation, so its font format is likely
  unrelated; flagged here only in case a future session wants to rule that
  in/out directly rather than re-discover the link).

Sources:
- [Chyron MAXINE! – Character Generator Wiki](https://cg-wiki.org/chyron/maxine)
- [CHYRON iNFiNiT! Series Operation Manual – ManualsLib](https://www.manualslib.com/manual/1215325/Chyron-Infinit-Series.html)
- [Chyron Scribe Manual Set – Internet Archive](https://archive.org/details/chyron-scribe-operator-manual/)
- [Dutch 766 Font family – Fonts In Use](https://fontsinuse.com/typefaces/254/dutch-766)
- [Bitstream Speedo Fonts – Wikipedia](https://en.wikipedia.org/wiki/Bitstream_Speedo_Fonts)
- [Chyron Corporation – Wikipedia](https://en.wikipedia.org/wiki/Chyron_Corporation)

## Comparison against real Helvetica Bold (2026-08-19, still offline)

Can't legally acquire the actual Bitstream Swiss 721 Bold font (commercial,
copyrighted), but Bitstream explicitly designed it as Helvetica's
metric/shape twin, and macOS ships a properly-licensed system Helvetica
(`/System/Library/Fonts/Helvetica.ttc`, face index 1 = Bold) — a legitimate
stand-in for structural comparison. Extracted real metrics/outlines via
fontTools (numbers only, not redistributing the font):

- **Vertical metrics — strong match.** Real Helvetica Bold: baseline sits
  at 77.0% of the way from ascender-top to descender-bottom; x-height-top
  at 23.8% (from `hhea`/`OS/2`: ascender=1577, descender=-471,
  capHeight=1474, xHeight=1090, unitsPerEm=2048, and ascender-descender
  spans exactly 1 em in this font). Our row model — derived purely from
  internal byte structure (the ascender-adds-8/descender-adds-9 finding),
  with zero reference to any real font — put baseline at 76.1% (row 35/46)
  and x-height-top at 21.7% (row 10/46). Near-exact match on baseline
  position specifically. Good independent confirmation the vertical
  placement derivation is basically right.
- **Raw crossing-count magnitude — real mismatch, now quantified.** True
  geometric edge-crossings per scanline in real Helvetica Bold (computed
  by scan-converting actual outlines at the same 46-row resolution):
  straight letters (`I l 1 T E F L`) average 2.0 crossings/row; `M`/`W`
  average 6.4-6.9; other diagonal/curved letters (`X A K Y V N O C S o c
  e`) cluster 2.6-4.8. Our decoded per-row *value* counts were 4-7 for
  straight and 10-20 for diagonal/curved — roughly 2-5x inflated versus
  true geometry. So the straight-vs-diagonal categorical split found
  earlier is real and directionally correct, but the raw numbers are NOT
  literal edge-crossing counts — there must be multiple stored
  samples/values per true edge (consistent with antialiasing/sub-sampling,
  and with `byte2` mostly tagging "auxiliary" records rather than real
  edges).
- **`H`-specific confirmation.** Real Helvetica Bold's `H` averages 3.6
  crossings/row specifically because most rows (away from the crossbar)
  show 4 crossings (both stems' inner+outer edges) while the crossbar row
  itself shows only 2 (one connected span). The fixed `H` decode (see
  "mirrored-duplicate segments" above) produces exactly 2 nested slivers
  per non-crossbar row = 4 edges, matching real geometry's non-crossbar
  count exactly. Independent check on that specific fix, not just a visual
  read.
- **Advance-width magnitude — confirms the earlier retraction, now
  quantified.** Real Helvetica Bold: `M` is 3.0x wider than `I` (1706 vs
  569 units), `W` is 3.4x wider (1933 vs 569). Our shared-scale byte1
  span estimate from earlier in this session only showed `M` ~1.4x wider
  than `I` (223.0 vs 156.6). So the *ranking* (I/l narrower than M/W),
  independently checked against the CRT photo earlier, was correct — but
  the *magnitude* is significantly compressed relative to reality. Fits
  with `width_field` already being ruled out as a usable width metric and
  the coordinate scale/mapping not being uniform the way `--scale 128`
  assumes.

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
3. **Test the antialiased tail region** boundary now located precisely at
   `0x1d080`-`0x1d100` through EOF (see "Tail region" above): zero it out
   (distinct from the original broad `.9001`-`.9006` cuts, which used a much
   cruder boundary estimate and also happen to have zeroed the entire glyph
   table, per the audit below) and see whether anything visibly changes — if
   nothing changes, that's evidence it's a preview/specimen artifact
   unrelated to normal rendering; if text goes missing or garbles, it's
   load-bearing.
4. **Confirm `width_field`** (3rd field of each glyph-table record):
   deliberately edit it for one glyph (e.g. double it) without touching that
   glyph's bulk data, reload, and see if the character's advance
   width/spacing changes on screen without its shape changing — would
   confirm it's a spacing metric independent of the outline data itself.

As always: use unused `.9xxx` codes, and stop immediately and report back if
anything fails to load, hangs, or crashes the unit.

## Visual test renderer (added 2026-08-19, still offline/no hardware)

`tools/render_font_specimen.py` decodes every defined glyph's rows (per the
bulk-data structure above) and renders a best-effort PNG specimen sheet, to
visually test the coordinate-encoding hypothesis without touching hardware.
Two modes: `--mode dots` (scatter-plot each row's raw coordinate values,
least assumption-laden) and `--mode spans` (sort each row's values and fill
between consecutive pairs, testing an even-odd/scanline-fill hypothesis).
Both assume a Q15-style ±32768 fixed-point scale (`--scale` to override) and
top-align each glyph's decoded rows in its tile (baseline position within
the 46-scanline box is NOT known, so vertical alignment across glyphs in the
sheet is not meaningful yet — only each tile's internal shape is).

**Result on `.0000` — retracted.** The first pass through this section
claimed the `dots` render showed recognizable structure (a `t` silhouette,
plausible `H` stems, etc.). On a closer, skeptical re-look (prompted by
the user, correctly, saying the images look nothing like fonts) that was
apophenia — pattern-matching a scatter plot, not a real signal. Don't trust
that framing.

**What's actually verified (2026-08-19, later pass) — the record's middle
two bytes are NOT one 16-bit coordinate.** Statistical check across the
whole bulk region of `.0000`: the record's 3rd byte (`byte2` in
`[0x01][byte1][byte2][0x00]`) is a single constant value (`0xfa`) 58.2% of
the time, with almost all the remainder sitting on a tight, evenly-stepped
ramp (`0xf8, 0xf0, 0xe8, 0xe0, 0xd8, 0xd0, 0xc8, 0xc0...` — descending by
exactly 8 each step). A real coordinate wouldn't cluster like that. This
byte is much more likely some kind of per-record weight/coverage/type value
than part of a position. `byte1` alone (signed, -128..127) varies far more
freely and is the better candidate for "the actual coordinate," but
plotting it alone hasn't been tried yet in a real render — hand-inspection
of the tiny `-`/`.`/`'` glyphs' row values (byte1 only) shows plausible-
looking small integer sequences but nothing conclusively shape-like by eye
either.

**Honest state of this thread**: the row-terminator grouping (`01 00 03 00`)
remains solid — it's backed by a real row-count-vs-typography comparison,
not a visual read. But the exact per-record value semantics (which byte(s),
what scale, what geometric meaning) are not solved, and two visual/
statistical misreads in one session is a sign that further guessing from
static analysis alone has hit diminishing returns. The `render_font_specimen.py`
tool's output should be treated as **inconclusive**, not a lead — don't cite
its images as evidence of anything without independently re-deriving the
decode first.

**A real, checkable win (2026-08-19, same later pass)** — prompted by the
user pointing out we already have real ground truth (the hardware photo
from the "Confirmed findings" section) and should check hypotheses against
it directly rather than just guessing further. Counted the average number
of `byte1` values per row (i.e. per-row record count, excluding the `01 00
03 00` terminator) for every defined letter, using `byte1` = the 2nd byte of
each `[0x01][byte1][byte2][0x00]` record (signed, -128..127; NOT the
2-byte-combined value, which the byte2 statistics above already ruled out).
Result is a **clean, non-overlapping split**:
- Straight-sided letters (`I` 5.0, `l` 6.0, `1` 5.2, `-` 4.3, `T` 6.8, `E`
  7.3, `F` 7.1, `L` 6.9): **4-7 values/row**.
- Diagonal/curved letters (`M` 18.1, `W` 19.6, `X` 12.5, `A` 10.9, `K` 13.3,
  `Y` 10.3, `V` 11.9, `N` 14.1, `%` 19.0, `O` 13.3, `C` 11.4, `S` 12.0, `o`
  12.9, `c` 11.4, `e` 11.4): **10-20 values/row**.

This lines up exactly with what's visible in the hardware photo: the first
group is straight vertical/horizontal strokes (crosses a scanline at most 2
places, occasionally more for `H`/`T`/`E`/`F` which have a crossbar), the
second group has diagonals or curves that cross a single scanline many more
times as the outline curls back and forth. Unlike the specimen-render
attempt, this doesn't depend on guessing the right coordinate scale or byte
pairing — it's just a record count, and it matches real visual ground truth
with no overlap between the groups. This is genuine evidence that `byte1`
per record corresponds to real edge-crossing structure, even though the
exact scale/meaning of the *value* itself (not just the count) is still
unconfirmed.

### `byte1` mirror-symmetry structure (same 2026-08-19 offline session,
continued after the user asked to keep digging on `.0000` alone rather than
wait for hardware)

Took the modal (most frequently repeated) row per glyph, and noticed a
`(0, -1)` pair recurs across a huge fraction of glyphs' modal rows,
independent of the glyph's shape — this looks like a **fixed structural
marker embedded once per row**, not geometry. After stripping exactly one
`0` and one `-1` from each modal row (when both present), sorting the
remainder, and pairing mirror-wise (1st with last, 2nd with 2nd-to-last,
etc.), the pair sums come out **exactly equal, to the integer, across
different glyphs that plausibly share the same stem width or advance-width
class**:

```
sums=(-33, -33):                 ! L P T c z
sums=(-49, -49):                 , . E F Y
sums=(31, 31):                   b f k p
sums=(47, 47):                   i j l r
sums=(47, 47, 47, 47, -1):       h n u
sums=(-33, -33, -33, -33, -1):   H U
sums=(-17, -17):                 C Z
sums=(63, 63):                   ( /
sums=(78,):                      : ;
sums=(15, 15, 15, 15, -1):       < > D
sums=(-17, -33, -33, -17, -1):   O Q R
```

`ijlr` (thin single-stroke letters), `bfkp` (stem+bowl/spur letters), and
`HU` (twin-vertical-stem letters) group in ways that make clear typographic
sense as shared-stem-width families. `hnu` sharing the exact same value as
`ijlr` (47) but with *more* repetitions of it fits too (h/n/u have an arch
in addition to the same-width stem). Others (`!LPTcz`, `,.EFY`, `OQR`, `CZ`)
don't obviously share stem shape, so this is more likely a shared
**advance-width or reference-box class** (small number of quantized width
buckets reused across glyphs) than literally "same stroke".

**What this proves**: `byte1` values are real, principled per-glyph
geometry — a symmetric structure around a per-glyph (or per-width-class)
center, not noise, and not something that could plausibly fall out of
random/garbage bytes. **What it doesn't prove yet**: which of the mirrored
values are the true ink edges vs. a reference/advance-width box, what the
absolute coordinate scale is (pixels? em-units? something else?), or how Y
position (which of the 46 scanlines a row corresponds to) is determined —
so this still isn't enough to produce a trustworthy rendered preview. The
`(0, -1)` marker's exact purpose is also still unknown (row-type flag?
literal degenerate zero-width edge?).

## Row order and vertical placement — SOLVED via structural pair comparison
(2026-08-19, "work as hard as you can" session, still fully offline)

Pushed further on the two blockers left at the end of the previous pass
(row order, vertical placement) using a technique that doesn't require
guessing the coordinate scale at all: compare **structurally related letter
pairs** where one letter is "the other plus an ascender/descender", and see
where the extra data lands in the byte sequence.

- `h` vs `n` (`h` = `n` + an ascender stem): `h` has **8 extra rows of a
  constant value PREPENDED** before a sequence that closely matches `n`'s
  arch-and-stem shape (matches from position 9 in `h` to the end, nearly
  exactly, off by rounding in only the very first matched value).
- `b` vs `o`, `d` vs `c`: same pattern, **exactly 8 extra rows prepended**
  in both cases.
- `p` vs `o`, `q` vs `c` (`p`/`q` = `o`/`c` + a descender): **9 extra rows
  of a near-constant value APPENDED** at the end in both cases.

Three independent confirmations of "+8 rows for an ascender, prepended" and
two of "+9 rows for a descender, appended" is not coincidence. **Conclusion:
rows are stored top-to-bottom.** Ascender extension is extra data at the
START of a glyph's byte sequence (makes sense: ascenders are the topmost
ink); descender extension is extra data at the END (descenders are the
bottommost ink).

This, plus the observed row-count-per-glyph data (x-height letters 25-27,
ascender/cap letters 34-35, descender letters 35-36, full-span punctuation
like `( ) j` at 44, out of 46 total scanlines), gives a complete vertical
model:

```
row 2:  ascender / cap top
row 10: x-height top
row 35: baseline
row 44: descender bottom
```

(Derived, not measured: baseline = ascender-top + 34ish avg ascender
row-count; x-height-top = baseline - 26ish avg x-height row-count; these
land within 1 row of each other across every pair checked, which is the
basis for picking these specific row numbers. Real-world overshoot on round
letters — `C G O Q S` all running 1-2 rows taller than flat-sided caps like
`E`/`F`/`H` — matches expected optical-correction conventions in real type
design, which is corroborating evidence this model is roughly right, not
proof it's exactly right.)

Each glyph is vertically placed by manual classification (ordinary
typographic knowledge, not derived from bytes): `g j p q y , ;` bottom-align
to descender-bottom (row 44); `( ) $ /` top-align to ascender-top (row 2)
and span the full height; everything else bottom-aligns to baseline (row
35).

### `byte2` re-examined as a record-type tag, not noise to discard

Filtering each row's records down to just those where `byte2 == 0xfa` (the
single dominant value, 58% of all records — see the byte2 statistics
above) and discarding the rest turned out to matter a lot: it removes what
looks like a per-row "header" record (always `byte1 = 0`, with a byte2 that
varies glyph-to-glyph — candidate row-descriptor, not a coordinate) and
leaves a cleaner list of what are probably the real edge-crossing records.

### The renderer — real progress, still not a match

`tools/render_font_specimen.py`, updated with all of the above (top-to-
bottom row order, the vertical model, `byte2`-filtering by default, plus
`--edge-mode {pairs,outer,midpoint}` to compare fill strategies), produces
a specimen sheet laid out exactly like the CRT test-string photo for direct
comparison. Honest assessment of the result:

- **The overall page-level structure looks right**: glyph tiles are
  correctly sized relative to each other, ascenders/descenders/x-height
  letters are vertically staggered in a plausible way, and simple glyphs
  render essentially correctly — `I` is a clean solid bar, `1` shows a
  recognizable flag/serif at top, `/` is a clean diagonal stroke, `-` is a
  short horizontal mark at mid-height. This is real, checkable progress
  over the previous session's output, which showed no structure at all.
- **Curved and diagonal letters (`o e a c s`, `M W X` etc.) still render as
  dense noise/hatching**, not clean shapes. Tried four different
  within-row fill strategies (even-odd on all values; outer min/max only;
  mirror-pair midpoints only; `byte2`-filtered even-odd) — all four were
  actually rendered and inspected, not just reasoned about. `byte2`-
  filtered even-odd is the best of the four (keeps the clean simple-glyph
  results from "outer" while doing less damage elsewhere), but even it
  doesn't crack curves: a filtered row for `o` still has ~10 edge-tagged
  values, not the ~4 a simple "2 strokes, inner+outer edge each" model
  would predict, and even-odd-filling 10 values produces multiple thin
  alternating stripes rather than a clean ring.
- **Assessment (superseded — see below)**: at this point curved letters
  still looked like noise. Kept pushing per explicit user request ("keep
  guessing and checking until we find a good rendering of at least one
  letter") rather than stopping here, and cracked it — see next section.

## BREAKTHROUGH: `byte1 == 0` records are segment separators, not
coordinates — curved and multi-counter letters now render correctly
(2026-08-19, same session, continued after user said to keep pushing)

The dense "static" noise on curved letters turned out to have a specific,
fixable cause. Dumped every row of `o` in full (all values, not just the
modal row) and noticed **`byte1 == 0` records occur multiple times within
a single row**, not just as a start/end bookend — e.g. one row (`o`, row
10) reads `[0, 0, 120, -9, -1, -33, 96, 0, 80, -49, -1, -121, 8]`, with a
`0` appearing both at the start AND in the middle.

**Splitting each row into segments at every `0` reveals real structure**:
for `o`'s middle rows, this gives exactly 2 segments, and critically their
spans share the **same center but different widths** — e.g. row 12 gives
spans `(-107, 48)` and `(-97, 38)`, both centered at exactly -29.5. That is
not what two spatially-separate strokes (like a left/right pair) would
look like; it's what an **outer boundary and an inner/counter boundary**
of a single ring look like. The correct fill rule: sort a row's segments by
width, then draw them widest-to-narrowest with **alternating black/white**
("ring" fill) — the widest span is painted black (ink), the next-widest is
painted white on top of it (carving out the counter), and so on for
letters with more nested structure.

Implemented as `--edge-mode ring` (now the default) in
`tools/render_font_specimen.py`. Result, checked by rendering each letter
individually at large scale, not just glancing at the small full-sheet
tiles:

- `o e a c s` (lowercase) and `O Q S B` (uppercase) all render as genuine
  hollow/nested shapes matching their real structure: `O` is a clean solid
  ring with an unambiguous white hollow center; `Q` is the same ring shape
  with an extra dark flourish at the bottom-right, exactly where `Q`'s tail
  belongs; `S` shows two separate hollow regions positioned diagonally
  opposite each other, matching `S`'s two counters (upper bowl open-left,
  lower bowl open-right); `B` shows a solid left stem with two separate
  hollow bowls stacked vertically on the right, exactly `B`'s real
  structure. These are not cherry-picked best cases — every curved/hollow
  letter tested this way came out structurally correct.
- Multi-segment letters generalize correctly too: `m`/`w`/`M`/`W` naturally
  produce 3-4 segments per row (matching their multiple strokes/humps),
  `B`/`8` naturally cap at 2 (matching one bowl visible per row), with zero
  glyph-specific tuning needed — the segment count falls directly out of
  the `0`-splitting rule.

### Two follow-on bugs found and fixed by testing systematically, not
reasoning abstractly

1. **Mirrored-duplicate segments** (`H` and similar twin-stem letters):
   `H`'s crossbar-less rows produce 2 segments that are **exact reversed
   duplicates of each other** (e.g. `[32,-97,-1,-65,64]` and
   `[64,-65,-1,-97,32]` — literally the same values in reverse order), not
   an outer/inner pair. Comparing them by width and alternating fill drew
   the identical span twice (black, then white on top erasing it) —
   rendering `H` as almost nothing. Fix: detect when 2 segments have
   near-identical spans (`_spans_close`, tolerance 4 units); when true,
   deduplicate to one segment's unique values and do **nested pairing
   within it** (sort, pair outermost-in, alternate fill) instead of
   comparing segment-to-segment. This correctly splits `[-97,-65,-1,32,64]`
   into two disjoint slivers `(-97,-65)` and `(32,64)` — `H`'s two stems
   with the gap between them. Verified before/after: `H` went from a
   nearly-blank tile to an unambiguous, correctly-proportioned H (two
   stems, connected crossbar, right height) — screenshotted and visually
   confirmed, not just inferred from the code.
   - Tried generalizing this by also treating `byte1 == -1` (tagged with a
     non-default `byte2`) as an additional separator, reasoning it might be
     a "legs cross here" marker for diagonal letters. **This regressed
     `O`** (broke the clean ring back into noise) and was reverted
     immediately — recorded here so it isn't retried blind next time.
   - Also tried applying nested-pairing to every single-segment row
     unconditionally (to try to fix `A`'s diagonal legs, which don't
     produce a natural `0`-separator). **This also regressed `O`** (its
     smoothly-varying top/bottom curve rows got spuriously split into
     extra alternating bands) and was reverted.
2. **Dominant-gap cluster split** (`A`/`N`/`K` and other diagonal-stroke
   letters): these often have exactly ONE segment (no natural `0` inside
   the row) even where there visually should be two disjoint diagonal leg
   cross-sections — e.g. `A` row 1's values (marker-stripped)
   `[-124,-107,-5,8,22]` have gaps `17, 102, 13, 14` between consecutive
   sorted values: one gap (102) dominates completely. Fix, narrower and
   safer than the two reverted attempts above: for a single segment with 4+
   values, check whether the single largest gap is at least 3x every other
   gap; if so, split into two clusters there and render each as its own
   solid span, instead of one solid span across the whole (wrong, too-wide)
   range. Threshold of 3x was chosen specifically because it improves `A`
   (now shows a real triangular gap in its middle rows) while leaving `O`
   unaffected (its curve-sample gaps are all comparable in size, so the 3x
   threshold never fires) — verified by rendering both before/after this
   change, not assumed from the logic alone. `N`/`K`/other diagonal letters
   did not visibly regress but also did not become clean — still an open
   problem, see below.

### Diagonal letters (`K M N W X Y V Z`) — three more approaches tried and
rejected, recorded so a future session doesn't repeat them

After the cluster-split fix helped `A`, pushed further on `K` specifically.
Found that `K`'s stem segment (`[32,-97,-1,-65,64]`, present unchanged
across ~10 consecutive rows) has the exact same mirror-pair-sum signature
(`-33`) as the `H`/`U` "stem width class" found much earlier in this
session — strong evidence `K` reuses the same stem-encoding template as
`H`, but `K` only has one real stem where `H` has two, so nested-pairing
that segment produces a spurious second sliver. Tried three fixes, all
verified by actually rendering `K` (or the specific glyph in question) AND
re-checking `O` for regression, not reasoned about abstractly:

1. Treat `byte1 == -1` (with non-default `byte2`) as an additional segment
   separator, on the theory it marks "legs cross here" for diagonals.
   **Broke `O`** (the clean ring became noise again). Reverted.
2. Apply nested-pairing unconditionally to every single-segment row
   (not just ones with a dominant gap). **Broke `O`** (its smoothly-varying
   top/bottom curve rows, which have no real internal structure, got
   spuriously split into extra alternating bands). Reverted.
3. For rows with 2+ segments of *differing* spans (the non-mirrored case),
   nest-pair each segment independently and let all of them contribute ink
   (instead of comparing segments to each other by width). **Broke both
   `K` (turned into a bowtie/hourglass blob) and `O` (turned into an
   irregular blob)**. Reverted.

None of these are correct. The `K` stem-template-reuse observation is real
and worth returning to, but the fix isn't a blanket rule — it likely needs
something that can tell "this sliver from the stem template is real ink"
from "this sliver is a template artifact that shouldn't render", which
isn't visible in anything tried this session. This is where hardware
ground truth (per "Suggested next hardware tests") would help most:
loading a real `K` and comparing exactly which pixels are lit would settle
which sliver is real.

### Honest current state (this is now the actual default renderer output)

Rendering the full test-string-layout sheet again with all of the above:
**`H` `I` `J` `L` `U` `O` `Q` `S` `B` are now structurally correct or very
close** (checked individually, not just glanced at in the small grid).
`A` improved (visible gap now, though not a crisp triangle) without
regressing anything else. **Diagonal-heavy letters remain the weak point**:
`M` `W` `K` `N` `X` `Y` `V` `Z` still don't resolve into clean shapes —
their rows often have 3-4 segments (correctly reflecting multiple diagonal
strokes) but the width-rank-based black/white assignment doesn't seem to
correctly identify which segment is genuinely "outer" for a criss-crossing
diagonal shape the way it does for concentric curves. This remains open.
The renderer script and its default output should now be considered a
genuine best-effort decoder for round/vertical-stroke letters, not just a
structural skeleton — but diagonal letters still need work, and none of
this is hardware-validated.
