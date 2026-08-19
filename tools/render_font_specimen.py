#!/usr/bin/env python3
"""
Best-effort visual test renderer for a MAXINE font file, producing a PNG
specimen sheet of every defined character, laid out to match the standard
CRT test-string photo (see CLAUDE.md "Ground truth") for direct comparison.

This is NOT a validated decoder -- see CLAUDE.md's "byte1 mirror-symmetry
structure" and "row order / vertical placement" sections for the full
derivation and confidence levels of every choice made here. Summary of the
model, and what's solid vs. guessed:

SOLID (derived from internal structural evidence, not just eyeballing):
  - Row grouping via the `01 00 03 00` terminator.
  - Row order is TOP-TO-BOTTOM: confirmed by comparing structurally related
    letter pairs (h=n+ascender, b=o+ascender, d=c+ascender all show 8 extra
    constant rows PREPENDED; p=o+descender, q=c+descender show 9 extra
    constant rows APPENDED).
  - `byte1` (2nd byte of each `[0x01][byte1][byte2][0x00]` record, signed
    -128..127) is the coordinate value; `byte2` is NOT part of it (it's
    dominated by one constant value + a small ramp -- see CLAUDE.md).
  - A `(0, -1)` pair recurs in most rows as a non-geometric marker; stripped
    here before rendering.

ESTIMATED (best-effort inference, not hardware-confirmed):
  - Vertical anchors within the 46-scanline canvas: ascender/cap top ~row 2,
    x-height top ~row 10, baseline ~row 35, descender bottom ~row 44.
    Derived from: ascender adds exactly 8 rows over x-height (confirmed 3
    ways), descender adds exactly 9 rows (confirmed 2 ways), and the
    longest glyphs use 44 of the 46 available scanlines.
  - Which glyphs get which vertical treatment (DESCENDER / FULL_SPAN /
    default-baseline) is manually classified below using ordinary
    typographic knowledge (g/j/p/q/y/,/; have descenders; parens/$/slash
    span the full height), not derived from the bytes.
  - Horizontal: a single SHARED linear scale (not auto-fit per glyph) maps
    byte1's -128..127 range to pixels, so relative widths between glyphs
    are preserved as literally encoded -- this ordering was independently
    checked against the photo (I/l narrower than M/W) before committing to
    it as the right call.
  - Each row's sorted remaining values are filled pairwise (even-odd rule).

Usage:
    python3 tools/render_font_specimen.py fonts/.0000 -o specimen.png
"""
import argparse
import struct
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, str(Path(__file__).parent))
from parse_maxine_font import MaxineFont  # noqa: E402

ROW_TERM = b'\x01\x00\x03\x00'
GLYPH_TERM = b'\x00\x00\x00\x00'

# Vertical anchors within the 46-scanline canvas (see module docstring).
ASCENDER_TOP = 2
XHEIGHT_TOP = 10
BASELINE = 35
DESCENDER_BOTTOM = 44

DESCENDER_CHARS = set('gjpqy,;')
FULL_SPAN_CHARS = set('()$/')

# Standard test-string layout (see CLAUDE.md "Ground truth") for direct
# side-by-side comparison with the CRT photo.
LAYOUT_LINES = [
    "ABCDEFGHIJKLM",
    "NOPQRSTUVWXYZ",
    "abcdefghijklm",
    "nopqrstuv",
    "wxyz",
    "1234567890",
    "!$%'&*(),-/",
]


EDGE_TAG_BYTE2 = 0xfa  # dominant byte2 value (58% of all records) -- filtering
                        # to just this value isolates real edge crossings
                        # from row-header/special records that use other
                        # byte2 values (see CLAUDE.md byte2 statistics)


def decode_rows(glyph_bytes, filter_byte2=False):
    """Split into rows by the 01 00 03 00 marker; decode byte1 (signed) per
    record, KEEPING zero values (they're segment separators, see
    split_segments). filter_byte2 kept only for the 'pairs'/'outer' legacy
    comparison modes -- the 'ring' mode (default) doesn't use it."""
    rows = []
    current = []
    for i in range(0, len(glyph_bytes) - 3, 4):
        rec = glyph_bytes[i:i + 4]
        if rec == GLYPH_TERM:
            break
        if rec == ROW_TERM:
            rows.append(current)
            current = []
            continue
        b1, b2 = rec[1], rec[2]
        if filter_byte2 and b2 != EDGE_TAG_BYTE2 and b1 != 0:
            continue
        current.append(b1 - 256 if b1 >= 128 else b1)
    if current:
        rows.append(current)
    return rows


def split_segments(row):
    """Split a row's values at each 0 -- discovered 2026-08-19 that byte1==0
    records are segment separators, not coordinates: a row with a hollow
    counter (e.g. 'o') stores TWO segments whose spans share the same
    center but different widths (outer boundary vs. inner/counter
    boundary), not two spatially-separate left/right spans. See CLAUDE.md."""
    segs, cur = [], []
    for v in row:
        if v == 0:
            if cur:
                segs.append(cur)
                cur = []
        else:
            cur.append(v)
    if cur:
        segs.append(cur)
    return segs


def _spans_close(a, b, tol=4):
    return abs(a[0] - b[0]) <= tol and abs(a[1] - b[1]) <= tol


def _cluster_split(vals):
    """For a single segment with no internal 0-separator (e.g. a diagonal
    stroke like A's legs, which don't happen to include a literal 0 in the
    data): look for one dominant gap in the sorted values and split there
    into two clusters. Only triggers when the biggest gap is >=3x every
    other gap, to avoid false-splitting smoothly-varying curve samples
    (this threshold was tuned by checking it doesn't regress 'O' -- see
    CLAUDE.md). Returns None if no clear split exists."""
    v = sorted(set(vals))
    if len(v) < 4:
        return None
    gaps = [(v[i + 1] - v[i], i) for i in range(len(v) - 1)]
    gaps.sort(reverse=True)
    maxgap, idx = gaps[0]
    rest = [g for g, _ in gaps[1:]]
    if not rest or maxgap < 3 * max(rest):
        return None
    left, right = v[:idx + 1], v[idx + 1:]
    if not left or not right:
        return None
    return [(min(left), max(left)), (min(right), max(right))]


def strip_marker(row):
    v = list(row)
    if 0 in v and -1 in v:
        v.remove(0)
        v.remove(-1)
    return v


def vertical_top(ch, n_rows):
    if ch in DESCENDER_CHARS:
        return DESCENDER_BOTTOM - n_rows + 1
    if ch in FULL_SPAN_CHARS:
        return ASCENDER_TOP
    return BASELINE - n_rows + 1


def render_glyph_tile(ch, rows, scale, tile_w, tile_h, edge_mode):
    img = Image.new('L', (tile_w, tile_h), color=255)
    draw = ImageDraw.Draw(img)

    def to_px(val):
        frac = max(-1.0, min(1.0, val / scale))
        return (frac + 1.0) / 2.0 * (tile_w - 1)

    top = vertical_top(ch, len(rows))
    for i, row_vals in enumerate(rows):
        y = top + i
        if y < 0 or y >= tile_h or not row_vals:
            continue

        if edge_mode == 'ring':
            segs = [s for s in split_segments(row_vals) if s]
            if not segs:
                continue

            if len(segs) == 1:
                cs = _cluster_split(segs[0])
                pairs = cs if cs is not None else [(min(segs[0]), max(segs[0]))]
                for rank, (lo, hi) in enumerate(pairs):
                    fill = 0 if rank % 2 == 0 else 255
                    draw.line([(to_px(lo), y), (to_px(hi), y)], fill=fill)
                continue

            spans = [(min(s), max(s)) for s in segs]

            if len(segs) == 2 and _spans_close(spans[0], spans[1]):
                # Mirrored-duplicate segments (e.g. H's twin stems: segment 2
                # is segment 1 reversed, same span) -- comparing them as
                # outer/inner would draw the same span twice and erase
                # itself. Instead merge to one segment's unique values and
                # nest-pair within it (see CLAUDE.md "mirrored-duplicate
                # segments" finding).
                vals = sorted(set(segs[0]))
                n = len(vals)
                pairs = [(vals[k], vals[n - 1 - k]) for k in range(n // 2)]
            else:
                # widest first (outer), alternating black/white inward
                spans.sort(key=lambda s: s[1] - s[0], reverse=True)
                pairs = spans

            for rank, (lo, hi) in enumerate(pairs):
                fill = 0 if rank % 2 == 0 else 255
                draw.line([(to_px(lo), y), (to_px(hi), y)], fill=fill)
            continue

        row_vals = strip_marker(row_vals)
        if not row_vals:
            continue
        xs = sorted(to_px(v) for v in row_vals)
        if edge_mode == 'outer':
            draw.line([(xs[0], y), (xs[-1], y)], fill=0)
        elif edge_mode == 'midpoint':
            n = len(xs)
            mids = sorted((xs[i] + xs[n - 1 - i]) / 2 for i in range(n // 2))
            for k in range(0, len(mids) - 1, 2):
                draw.line([(mids[k], y), (mids[k + 1], y)], fill=0)
        else:
            for k in range(0, len(xs) - 1, 2):
                draw.line([(xs[k], y), (xs[k + 1], y)], fill=0)
    return img


def build_specimen(font, scale, px_per_row, edge_mode):
    tile_h = font.scanlines
    tile_w = int(px_per_row * 16)  # generous per-glyph horizontal budget --
                                     # needs to be wide enough that inner/outer
                                     # ring boundaries (often only ~10-20 units
                                     # apart out of the 255-unit coordinate
                                     # range) don't alias away, see CLAUDE.md
    label_h = 11
    cell_w = tile_w + 4
    cell_h = tile_h * px_per_row // tile_h  # placeholder, recomputed below

    scale_y = 3  # vertical upscale so rows are visible
    tile_h_px = tile_h * scale_y
    cell_h_px = tile_h_px + label_h + 6

    sheet_w = max(len(line) for line in LAYOUT_LINES) * cell_w + 20
    sheet_h = len(LAYOUT_LINES) * cell_h_px + 40
    sheet = Image.new('L', (sheet_w, sheet_h), color=255)
    draw = ImageDraw.Draw(sheet)
    font_lbl = ImageFont.load_default()

    title = f"{font.name1}  ({font.scanlines} scanlines)  best-effort decode, NOT hardware-validated"
    draw.text((4, 4), title, fill=0, font=font_lbl)

    y0 = 24
    for line in LAYOUT_LINES:
        x0 = 10
        for ch in line:
            g = font.glyphs.get(ch)
            if not g or not g['defined']:
                x0 += cell_w
                continue
            raw = font.glyph_bytes(ch)
            rows = decode_rows(raw)
            tile = render_glyph_tile(ch, rows, scale, tile_w, tile_h, edge_mode)
            tile = tile.resize((tile_w, tile_h_px), Image.NEAREST)
            sheet.paste(tile, (x0, y0))
            x0 += cell_w
        y0 += cell_h_px

    return sheet


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('font_path')
    ap.add_argument('-o', '--output', default='specimen.png')
    ap.add_argument('--scale', type=float, default=128.0,
                     help='assumed fixed-point full-scale for byte1 coordinate '
                          'values (default 128, i.e. the natural signed-byte range)')
    ap.add_argument('--px-per-row', type=int, default=6)
    ap.add_argument('--edge-mode', choices=['ring', 'pairs', 'outer', 'midpoint'], default='ring',
                     help='ring = split each row at value-0 separators into segments, '
                          'fill widest-to-narrowest with alternating black/white (default, '
                          'see CLAUDE.md "ring segments" finding); '
                          'pairs = even-odd fill on all values; '
                          'outer = fill only from leftmost to rightmost value per row; '
                          'midpoint = collapse each mirror-symmetric pair to its midpoint, then even-odd fill')
    args = ap.parse_args()

    font = MaxineFont(args.font_path)
    print(font.summary())
    sheet = build_specimen(font, args.scale, args.px_per_row, args.edge_mode)
    sheet.save(args.output)
    print(f"\nwrote {args.output} ({sheet.width}x{sheet.height})")


if __name__ == '__main__':
    main()
