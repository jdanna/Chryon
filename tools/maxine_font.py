#!/usr/bin/env python3
"""
Chyron MAXINE / iNFiNiT! "Machine Font" (.NNNN) reader, writer and renderer.

Format summary (big-endian throughout; see CLAUDE.md for the full spec):

  0x000  u32   500 (constant)
  0x004  u32   0xffffffff (no-edge) / 0x00002816 (edge fonts)   -- purpose unknown
  0x008  60B   font name, NUL padded
  0x044  64B   two NUL-terminated strings: "  46 scanlines No edge " and " 4 lines "
  0x084  4B    zero
  0x088  60B   font name again
  0x0c0  14B   junk / zero
  0x0ce  8B    ASCII digits: 4-digit master font id + the file's own 4-digit code
  0x0d6  u16   total cell rows  (= nominal scanlines + 2*edge lines)
  0x0d8  u16   ascent rows      (baseline row = ascent + 0xfe)
  0x0da  u16   widest advance in the master font (informational)
  0x0e6  u32   size hint (= file length - 136 in edge fonts; not that in .0000)
  0x0ea  u32   byte length of the glyph data block
  0x0ee  u16   byte length of the kerning table
  0x0f0  u16   38 (constant)
  0x0f8  u16   descent rows
  0x0fa  u16   descent rows (again)
  0x0fe  u16   baseline offset (baseline row = ascent + this)
  0x104  u16   1317 (1314 in .0000) -- probably a tool version
  0x108  192 x 10-byte glyph records, indexed by character code (0..191):
           u8  0x42 (0x46 when the font has a shadow)
           s8  spacing hint (0 for most glyphs)
           u16 bits 15..10: left-overhang hint (px*?), bits 7..4: spacing hint,
               bits 1..0: high bits of top
           u8  top row * 4   (so top = (u16<<8|u8) >> 2 ... i.e. a 10-bit row)
           u8  advance width in pixels
           u32 offset of the glyph's run data from 0x888
         Codes 0..3 are underline tiles, 33.. are ASCII.  A blank record = undefined.
  0x888  glyph data: per glyph, rows of 4-byte run records, then 00 00 00 00.
           record = [layer u16][intensity u8][count u8]
             count: bits 7..3 = 32 - run length (1..32), bits 2..0 = type
             type&3: 0 = blank run, 1 = solid 0xff run, 2 = gray run, 3 = end of row
             bit 2 of type is set in edge fonts, clear in no-edge fonts.
             layer: 1 = face, 2 = edge (border+shadow), 0 = blank/EOR in edge fonts
                    0x8002 = edge pixel *under* the following 1-px face record
                    (an overlay; it does not advance x).
  then   kerning table: 4-byte records [left char][right char][s16 kern px]
  then   6036-byte footer: 64 zero bytes, a fixed 704-byte table, a 10-byte header
         (66,66,30,30) and a 66x79 8-bit "Aa" preview thumbnail (0xee = background).
"""
import struct, sys, os, re, argparse
from dataclasses import dataclass, field
from typing import List, Tuple, Dict, Optional

BULK_BASE = 0x888
TABLE_OFF = 0x108
NSLOTS = 192
FOOTER_LEN = 6036
THUMB_W, THUMB_H = 66, 79
THUMB_OFF = 0x30a  # inside footer

# ---------------------------------------------------------------- data model

@dataclass
class Run:
    layer: int      # 0,1,2 or 0x8002
    value: int      # intensity 0..255
    n: int          # run length 1..32
    typ: int        # raw 3-bit type

    @property
    def overlay(self): return bool(self.layer & 0x8000)

@dataclass
class Glyph:
    code: int
    top: int                 # first row of the bitmap (cell row index)
    advance: int
    rows: List[List[Run]]    # decoded rows (may begin with empty rows)
    tag_lo: int = 0          # signed spacing hint
    hint: int = 0            # the 14 bits above top (bits 15..2 of the u16)
    offset: int = 0

    def width(self):
        return max((sum(r.n for r in row if not r.overlay) for row in self.rows), default=0)

    def raster(self):
        """-> (face, edge, W, H): two lists of rows of ints 0..255."""
        W, H = self.width(), len(self.rows)
        face = [[0] * W for _ in range(H)]
        edge = [[0] * W for _ in range(H)]
        for y, row in enumerate(self.rows):
            x = 0
            for r in row:
                tgt = face if r.layer == 1 else edge if (r.layer & 0x7fff) == 2 else None
                if tgt is not None and r.value:
                    for i in range(r.n):
                        tgt[y][x + i] = r.value
                if not r.overlay:
                    x += r.n
        return face, edge, W, H

@dataclass
class MaxineFont:
    name: str = ""
    desc1: str = ""          # e.g. "  46 scanlines No edge "
    desc2: str = ""          # e.g. " 4 lines "
    digits: str = "00000000"
    cell_rows: int = 0
    ascent: int = 0
    max_advance: int = 0
    descent: int = 0
    baseline_off: int = 0
    size_hint: int = 0
    version: int = 1317
    magic4: bytes = b"\xff\xff\xff\xff"
    glyphs: Dict[int, Glyph] = field(default_factory=dict)
    kerning: List[Tuple[int, int, int]] = field(default_factory=list)
    footer: bytes = b""
    raw: bytes = b""

    @property
    def nominal_scanlines(self):
        m = re.search(r"(\d+)\s*scanlines", self.desc1)
        return int(m.group(1)) if m else self.cell_rows

    @property
    def edge_lines(self):
        if "edge" in self.desc1.lower() and "no edge" in self.desc1.lower():
            return 0
        m = re.search(r"(\d+)\s*lines", self.desc2)
        return int(m.group(1)) if m else 0

    @property
    def has_edge(self):
        return any(r.layer & 0x7fff == 2 for g in self.glyphs.values() for row in g.rows for r in row)

    @property
    def baseline_row(self):
        return self.ascent + self.baseline_off

# ---------------------------------------------------------------- decoding

def decode_runs(d: bytes, k: int):
    """Decode glyph run data at d[k:]. Returns (rows, end_index)."""
    rows, row = [], []
    while k + 4 <= len(d):
        layer = (d[k] << 8) | d[k + 1]; v = d[k + 2]; c = d[k + 3]; k += 4
        if layer == 0 and v == 0 and c == 0:
            break
        n = 32 - (c >> 3); t = c & 7
        if t & 3 == 3:
            rows.append(row); row = []
            continue
        row.append(Run(layer, v, n, t))
    if row:
        rows.append(row)
    return rows, k

def load(path) -> MaxineFont:
    d = open(path, "rb").read()
    f = MaxineFont(raw=d)
    f.magic4 = d[4:8]
    f.name = d[0x08:0x44].split(b"\0")[0].decode("latin-1")
    parts = d[0x44:0x84].split(b"\0")
    f.desc1 = parts[0].decode("latin-1")
    f.desc2 = parts[1].decode("latin-1") if len(parts) > 1 else ""
    f.digits = d[0xce:0xd6].decode("latin-1")
    u16 = lambda o: struct.unpack(">H", d[o:o + 2])[0]
    u32 = lambda o: struct.unpack(">I", d[o:o + 4])[0]
    f.cell_rows, f.ascent, f.max_advance = u16(0xd6), u16(0xd8), u16(0xda)
    f.size_hint, data_len, kern_len = u32(0xe6), u32(0xea), u16(0xee)
    f.descent, f.baseline_off, f.version = u16(0xf8), u16(0xfe), u16(0x104)
    for i in range(NSLOTS):
        rec = d[TABLE_OFF + i * 10: TABLE_OFF + i * 10 + 10]
        if rec == b"\0" * 10:
            continue
        tag, hint16, topb, adv, off = struct.unpack(">HHBBI", rec)
        rows, _ = decode_runs(d, BULK_BASE + off)
        top = ((hint16 & 3) << 8 | topb) >> 2
        tl = tag & 0xff
        f.glyphs[i] = Glyph(i, top, adv, rows, tl - 256 if tl > 127 else tl, hint16 >> 2, off)
        f.glyphs[i].tag_hi = tag >> 8
    k0 = BULK_BASE + data_len
    for k in range(k0, k0 + kern_len, 4):
        f.kerning.append((d[k], d[k + 1], struct.unpack(">h", d[k + 2:k + 4])[0]))
    f.footer = d[k0 + kern_len:]
    return f

# ---------------------------------------------------------------- encoding

def _count_byte(n, typ):
    assert 1 <= n <= 32
    return ((32 - n) << 3) | typ

def encode_row_noedge(face_row: List[int], pad_to: int) -> bytes:
    """.0000-style row: layer 1 records, types 0/1/2, padded with blank to pad_to."""
    out = bytearray()
    px = list(face_row) + [0] * (pad_to - len(face_row))
    i = 0
    while i < len(px):
        v = px[i]; j = i
        while j < len(px) and px[j] == v and j - i < 32:
            j += 1
        typ = 0 if v == 0 else 1 if v == 255 else 2
        out += struct.pack(">HBB", 1, v, _count_byte(j - i, typ))
        i = j
    out += struct.pack(">HBB", 1, 0, 0x03)      # end of row
    return bytes(out)

def encode_row_edge(face_row: List[int], edge_row: List[int]) -> bytes:
    """Edge-font row: layers 0/1/2 + overlays, trailing blanks trimmed."""
    out = bytearray()
    W = len(face_row)
    last = -1
    for x in range(W):
        if face_row[x] or edge_row[x]:
            last = x
    x = 0
    while x <= last:
        f, b = face_row[x], edge_row[x]
        if f == 255 and b == 255 or (f == 255 and b == 0):
            j = x
            while j <= last and face_row[j] == 255 and edge_row[j] == b and j - x < 32:
                j += 1
            out += struct.pack(">HBB", 1, 255, _count_byte(j - x, 5)); x = j
        elif f > 0:
            if b > 0:
                out += struct.pack(">HBB", 0x8002, b, _count_byte(1, 5 if b == 255 else 6))
            out += struct.pack(">HBB", 1, f, _count_byte(1, 5 if f == 255 else 6)); x += 1
        elif b > 0:
            j = x
            while j <= last and face_row[j] == 0 and edge_row[j] == b and j - x < 32:
                j += 1
            out += struct.pack(">HBB", 2, b, _count_byte(j - x, 5 if b == 255 else 6)); x = j
        else:
            j = x
            while j <= last and face_row[j] == 0 and edge_row[j] == 0 and j - x < 32:
                j += 1
            out += struct.pack(">HBB", 0, 0, _count_byte(j - x, 4)); x = j
    out += struct.pack(">HBB", 0, 0, 0xff)      # end of row
    return bytes(out)

def encode_glyph(face, edge, has_edge: bool, lead_rows: int = 0) -> bytes:
    """face/edge: lists of rows (ints). Returns run data incl. terminator."""
    out = bytearray()
    W = max((len(r) for r in face), default=0)
    if has_edge:
        # Edge fonts: each row ends with the 0000 00ff marker except the last
        # one (the glyph terminator doubles as its end).  The originals usually
        # start with 1-2 empty rows (lead_rows).
        rows = [struct.pack(">HBB", 0, 0, 0xff)] * lead_rows
        for fr, er in zip(face, edge):
            rows.append(encode_row_edge(list(fr) + [0] * (W - len(fr)), list(er) + [0] * (W - len(er))))
        if rows:
            rows[-1] = rows[-1][:-4]
        out += b"".join(rows)
    else:
        for fr in face:
            out += encode_row_noedge(fr, W)
    out += b"\0\0\0\0"
    return bytes(out)

def _fixstr(s: str, n: int) -> bytes:
    b = s.encode("latin-1")[:n]
    return b + b"\0" * (n - len(b))

def build(font: MaxineFont, glyph_blobs: Dict[int, Tuple[Glyph, bytes]], file_code: str,
          has_edge: bool, has_shadow: bool = False) -> bytes:
    """Assemble a complete .NNNN file.  glyph_blobs: code -> (Glyph meta, run bytes)."""
    data = bytearray(); table = bytearray(NSLOTS * 10)
    for code in sorted(glyph_blobs):
        g, blob = glyph_blobs[code]
        if not (0 <= code < NSLOTS):
            continue
        off = len(data); data += blob
        tag = ((0x46 if has_shadow else 0x42) << 8) | (g.tag_lo & 0xff)
        top4 = g.top * 4
        hint16 = ((g.hint & 0x3fff) << 2) | ((top4 >> 8) & 3)
        struct.pack_into(">HHBBI", table, code * 10, tag, hint16, top4 & 0xff, g.advance & 0xff, off)
    kern = b"".join(struct.pack(">BBh", a, b, k) for a, b, k in font.kerning)
    footer = font.footer if len(font.footer) in (FOOTER_LEN, FOOTER_LEN - 2) else default_footer()
    hdr = bytearray(BULK_BASE)
    struct.pack_into(">I", hdr, 0, 500)
    hdr[4:8] = b"\x00\x00\x28\x16" if has_edge else b"\xff\xff\xff\xff"
    hdr[0x08:0x44] = _fixstr(font.name, 60)
    d1 = font.desc1.encode("latin-1") + b"\0" + font.desc2.encode("latin-1") + b"\0"
    hdr[0x44:0x84] = d1[:64] + b"\0" * (64 - len(d1[:64]))
    hdr[0x88:0xc4] = _fixstr(font.name, 60)
    hdr[0xce:0xd6] = _fixstr((font.digits[:4] + file_code)[:8].ljust(8, "0"), 8)
    total = BULK_BASE + len(data) + len(kern) + len(footer)
    struct.pack_into(">HHH", hdr, 0xd6, font.cell_rows, font.ascent, font.max_advance)
    struct.pack_into(">II", hdr, 0xe6, total - 136, len(data))
    struct.pack_into(">HH", hdr, 0xee, len(kern), 38)
    struct.pack_into(">HHHH", hdr, 0xf8, font.descent, font.descent, 0, font.baseline_off)
    struct.pack_into(">H", hdr, 0x104, font.version or 1317)
    hdr[TABLE_OFF:TABLE_OFF + NSLOTS * 10] = table
    return bytes(hdr) + bytes(data) + kern + footer

def default_footer() -> bytes:
    here = os.path.dirname(os.path.abspath(__file__))
    p = os.path.join(here, "footer_template.bin")
    if os.path.exists(p):
        return open(p, "rb").read()
    raise FileNotFoundError("tools/footer_template.bin missing; run: maxine_font.py extract-footer fonts/.3000")

def set_thumbnail(footer: bytes, img_rows: List[List[int]]) -> bytes:
    """Replace the 66x79 preview thumbnail inside a footer. Values 0..255, 0xee = bg."""
    b = bytearray(footer)
    for y in range(THUMB_H):
        for x in range(THUMB_W):
            v = img_rows[y][x] if y < len(img_rows) and x < len(img_rows[y]) else 0xee
            b[THUMB_OFF + y * THUMB_W + x] = v
    return bytes(b)

# ---------------------------------------------------------------- rendering

LINES = ["ABCDEFGHIJKLM", "NOPQRSTUVWXYZ", "abcdefghijklm", "nopqrstuvwxyz",
         "1234567890", "!$%'&*(),-./:;<>?@#+=[]{}|~\"\\^_`"]

def render_sheet(font: MaxineFont, out_png: str, scale: int = 3, lines=LINES, kern=True):
    from PIL import Image
    kmap = {(a, b): k for a, b, k in font.kerning}
    rasters = {c: g.raster() for c, g in font.glyphs.items()}
    LH = max((g.top + len(g.rows) for g in font.glyphs.values()), default=10) + 4
    width = max(sum(font.glyphs[ord(ch)].advance for ch in line if ord(ch) in font.glyphs) for line in lines) + 40
    img = Image.new("RGB", (width, LH * len(lines) + 10), (30, 30, 30)); px = img.load()
    for li, line in enumerate(lines):
        x0 = 10; prev = None
        for ch in line:
            c = ord(ch)
            if c not in font.glyphs:
                continue
            if kern and prev is not None:
                x0 += kmap.get((prev, c), 0)
            g = font.glyphs[c]; face, edge, W, H = rasters[c]
            for y in range(H):
                for x in range(W):
                    f, e = face[y][x], edge[y][x]
                    if f or e:
                        X, Y = x0 + x, li * LH + g.top + y
                        if 0 <= X < img.width and 0 <= Y < img.height:
                            px[X, Y] = (min(255, e + f), f, f)
            x0 += g.advance; prev = c
    img = img.resize((img.width * scale, img.height * scale), Image.NEAREST)
    img.save(out_png)
    return out_png

def ascii_glyph(g: Glyph) -> str:
    face, edge, W, H = g.raster()
    lines = []
    for y in range(H):
        s = ""
        for x in range(W):
            f, e = face[y][x], edge[y][x]
            s += "#" if f == 255 else "+" if f else "o" if e == 255 else "." if e else " "
        lines.append(f"{g.top + y:3d} |{s}|")
    return "\n".join(lines)

# ---------------------------------------------------------------- CLI

def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("info", help="print header fields and glyph table"); p.add_argument("file")
    p = sub.add_parser("glyph", help="ASCII-art one glyph"); p.add_argument("file"); p.add_argument("char")
    p = sub.add_parser("render", help="render a specimen sheet PNG"); p.add_argument("file"); p.add_argument("out"); p.add_argument("--scale", type=int, default=3)
    p = sub.add_parser("kern", help="print kerning pairs"); p.add_argument("file")
    p = sub.add_parser("thumb", help="save the preview thumbnail as PNG"); p.add_argument("file"); p.add_argument("out")
    p = sub.add_parser("extract-footer", help="save a file's footer as tools/footer_template.bin"); p.add_argument("file")
    p = sub.add_parser("roundtrip", help="re-encode every glyph and compare bytes with the original"); p.add_argument("file")
    a = ap.parse_args(argv)
    f = load(a.file)
    if a.cmd == "info":
        print(f"name={f.name!r} desc={f.desc1!r}/{f.desc2!r} digits={f.digits} cell_rows={f.cell_rows} "
              f"ascent={f.ascent} descent={f.descent} baseline_off={f.baseline_off} baseline_row={f.baseline_row} "
              f"max_adv={f.max_advance} version={f.version} glyphs={len(f.glyphs)} kern_pairs={len(f.kerning)} edge={f.has_edge}")
        for c, g in sorted(f.glyphs.items()):
            print(f"  {c:3d} {chr(c) if c > 32 else '?'} top={g.top:3d} rows={len(g.rows):3d} adv={g.advance:3d} bmw={g.width():3d} hint={g.hint:#x} tag_lo={g.tag_lo}")
    elif a.cmd == "glyph":
        print(ascii_glyph(f.glyphs[ord(a.char)]))
    elif a.cmd == "render":
        print("wrote", render_sheet(f, a.out, a.scale))
    elif a.cmd == "kern":
        for l, r, k in f.kerning:
            print(f"{chr(l)}{chr(r)} {k:+d}")
    elif a.cmd == "thumb":
        from PIL import Image
        im = Image.new("L", (THUMB_W, THUMB_H)); im.putdata(list(f.footer[THUMB_OFF:THUMB_OFF + THUMB_W * THUMB_H]))
        im.resize((THUMB_W * 4, THUMB_H * 4)).save(a.out); print("wrote", a.out)
    elif a.cmd == "extract-footer":
        p = os.path.join(os.path.dirname(os.path.abspath(__file__)), "footer_template.bin")
        open(p, "wb").write(f.footer); print("wrote", p, len(f.footer))
    elif a.cmd == "roundtrip":
        bad = 0; edge = f.has_edge
        def norm(blob):
            recs = []; k = 0
            while k + 4 <= len(blob):
                layer = (blob[k] << 8) | blob[k+1]; v = blob[k+2]; c = blob[k+3]; k += 4
                if layer == 0 and v == 0 and c == 0: break
                n = 32 - (c >> 3); t = c & 7
                if t & 3 == 3: recs.append(("EOR",)); continue
                if recs and recs[-1][0] != "EOR" and recs[-1][:2] == (layer, v) and recs[-1][3] == t and not layer & 0x8000:
                    recs[-1] = (layer, v, recs[-1][2] + n, t)
                else:
                    recs.append((layer, v, n, t))
            return recs
        for c, g in sorted(f.glyphs.items()):
            face, e, W, H = g.raster()
            lead = 0
            for row in g.rows:
                if row: break
                lead += 1
            blob = encode_glyph(face[lead:], e[lead:], edge, lead)
            _, end = decode_runs(f.raw, BULK_BASE + g.offset)
            orig = f.raw[BULK_BASE + g.offset:end]
            a_, b_ = norm(blob), norm(orig)
            if a_ != b_:
                bad += 1
                k = next((i for i in range(min(len(a_), len(b_))) if a_[i] != b_[i]), min(len(a_), len(b_)))
                print(f"  mismatch {c} {chr(c) if c > 32 else '?'}: at record {k}: mine={a_[k:k+4]} orig={b_[k:k+4]}")
        print(f"{a.file}: {len(f.glyphs) - bad}/{len(f.glyphs)} glyphs re-encode identically (modulo run splitting)")

if __name__ == "__main__":
    main()
