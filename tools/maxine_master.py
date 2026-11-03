#!/usr/bin/env python3
"""
Chyron MAXINE "Master Font" (/SYSTEM/MASTER/.NNNN) reader, writer and renderer.

A master font holds scalable outlines: the Flash Font feature in Message Compose and
the Font Compose program cut machine fonts from it at any size. Machine fonts name
their master in the first four digits at 0xce. Everything is big-endian.

  0x000  u32   400 (constant)
  0x004  u32   site id; 0xffffffff in every stock master (any site)
  0x008  128B  font name, space padded, NUL terminated
  0x088  u16   this master's own 4-digit id as a number (5340 for .5340)
  0x08a  2B    zero
  0x08c  60B   font name again, NUL padded
  0x0c8  10B   junk / zero
  0x0d2  8B    date string "11 01 90" / "23 10 91"
  0x0da  u32   byte length of the glyph data
  0x0de  u16   1-based 256-byte block of the kerning table, counting from 0x88: it starts
               at (this - 1) * 256 + 0x88, the first such address past the glyph data
  0x0e0  u16   byte length of the kerning table
  0x0e2  u16   unknown vertical metric (570..1087; 0 in the Pi font)
  0x0e4  u16   4320 = half the em: kerning values are in 4320ths of an em
  0x0e6  u16   same as 0xe2
  0x0e8  3xu16 zero (small values in three fonts)
  0x0ee  u16   the tallest glyph's ymax / 2 (0 in the Pi font)
  0x0f0  u16   1
  0x0f2  u16   unknown (0 in four fonts)
  0x186  400 x [u16 char id][u32 offset in 16-bit words from 0xae8], ascending by id,
               0xffff/0xffffffff when unused, then a 2-byte 0xffff.
  0xae8  glyph data, 16-bit words, 8640 units per em (the em dash is 8640 wide):
           s16 ordinal (position of the glyph in the data)
           s16 advance, s16 xmin, s16 xmax, s16 ymax, s16 ymin   (ymin may be negative)
           s16 number of 4-byte records that follow
           s16 number of contours
           u16 flags (1 on floating accents), s16 spacing hint, u16 0, u16 0
           records: [x u16][y u16], coordinates in the low 14 bits, relative to xmin/ymin:
             x bit 14 clear: start of a contour (bit 15 set = a hole);
             x bits 15,14 = 01: a point; 11: the centre of a circular arc joining the
             points on either side (equidistant from both; the minor arc is drawn).
             y bits 15,14: hints of unknown meaning, kept for round-tripping.
           Each contour ends by repeating its first point. All contours run clockwise.
  then   zero bytes up to the next address that is 0x88 mod 0x100, then the kerning
         table: 6-byte records [left id + 1][right id + 1][s16 kern, 4320/em], grouped
         by left; then zero padding.

Char ids: A-Z = 0-25, & = 26, a-z = 27-52, 1234567890 = 55-64, then punctuation
(see MASTER_IDS). Ids above 199 are accented letters and symbols.
"""
import struct, sys, math, argparse
from dataclasses import dataclass, field
from typing import List, Tuple, Dict, Optional

MAGIC = 400
EM = 8640
KERN_EM = 4320
INDEX_OFF = 0x186
NSLOTS = 400
DATA_OFF = 0xae8

# ASCII -> master char id, for the characters the MAXINE types. Letters, digits and
# the kerning pairs are confirmed against the Swiss 721 master and `.0000`; the
# punctuation comes from the storage order of the edge machine fonts and the glyph
# shapes in the master (see `render`).
MASTER_IDS: Dict[str, int] = {}
for _i, _c in enumerate("ABCDEFGHIJKLMNOPQRSTUVWXYZ"):
    MASTER_IDS[_c] = _i
MASTER_IDS["&"] = 26
for _i, _c in enumerate("abcdefghijklmnopqrstuvwxyz"):
    MASTER_IDS[_c] = 27 + _i
for _i, _c in enumerate("1234567890"):
    MASTER_IDS[_c] = 55 + _i
MASTER_IDS.update({"$": 65, "%": 72, ".": 73, ",": 74, ":": 75, ";": 76,
                   "<": 78, "'": 79, ">": 80, "?": 83, "!": 84, "/": 85,
                   "(": 86, ")": 87, "*": 90, "-": 94})


@dataclass
class Contour:
    points: List[Tuple[int, int]]            # absolute units; last point repeats the first
    centers: List[Optional[Tuple[int, int]]]  # per segment i -> i+1, None for a line
    hole: bool = False
    pflags: List[int] = field(default_factory=list)   # y bits 15,14 per point
    cflags: List[int] = field(default_factory=list)   # y bits 15,14 per arc (0 for lines)

    def polygon(self, tol: float = 8.0) -> List[Tuple[float, float]]:
        """Flatten arcs into line segments (tol = max chord error in units)."""
        out: List[Tuple[float, float]] = []
        n = len(self.points)
        for i in range(n - 1):
            p0, p1 = self.points[i], self.points[i + 1]
            c = self.centers[i]
            out.append(p0)
            if c is None:
                continue
            r = math.hypot(p0[0] - c[0], p0[1] - c[1])
            a0 = math.atan2(p0[1] - c[1], p0[0] - c[0])
            a1 = math.atan2(p1[1] - c[1], p1[0] - c[0])
            da = (a1 - a0 + math.pi) % (2 * math.pi) - math.pi
            if r <= tol:
                continue
            steps = max(1, int(math.ceil(abs(da) / (2 * math.acos(max(0.0, 1 - tol / r))))))
            for k in range(1, steps):
                a = a0 + da * k / steps
                out.append((c[0] + r * math.cos(a), c[1] + r * math.sin(a)))
        out.append(self.points[-1])
        return out


@dataclass
class Glyph:
    id: int
    advance: int
    xmin: int
    xmax: int
    ymax: int
    ymin: int
    contours: List[Contour]
    flags: int = 0
    hint: int = 0
    ordinal: int = 0
    extra: Tuple[int, int] = (0, 0)

    @property
    def nrecords(self):
        return sum(len(c.points) + sum(1 for k in c.centers if k) for c in self.contours)


@dataclass
class MasterFont:
    name: str = ""
    master_id: int = 9000
    date: str = "01 01 90"
    site: int = 0xffffffff
    glyphs: Dict[int, Glyph] = field(default_factory=dict)
    kerning: List[Tuple[int, int, int]] = field(default_factory=list)  # 0-based ids, 4320/em
    vmetric: int = 814
    unk_e8: Tuple[int, int, int] = (0, 0, 0)
    unk_ee: int = 0x1040
    unk_f2: int = 0
    raw: bytes = b""

    @property
    def max_advance(self):
        return max((g.advance for g in self.glyphs.values()), default=0)


# ---------------------------------------------------------------- reading

def _cstr(b: bytes) -> str:
    return b.split(b"\0")[0].decode("latin-1").rstrip()


def parse_glyph(d: bytes, off: int) -> Glyph:
    p = DATA_OFF + 2 * off
    ordinal, adv, xmin, xmax, ymax, ymin, nrec, ncont = struct.unpack(">8h", d[p:p + 16])
    flags, hint, e0, e1 = struct.unpack(">HhHH", d[p + 16:p + 24])
    q = p + 24
    contours: List[Contour] = []
    cur: Optional[Contour] = None
    pending: Optional[Tuple[int, int]] = None
    pending_flag = 0
    for _ in range(nrec):
        xw, yw = struct.unpack(">HH", d[q:q + 4]); q += 4
        x, y, yf = (xw & 0x3fff) + xmin, (yw & 0x3fff) + ymin, yw >> 14
        if xw & 0xc000 == 0xc000:
            pending, pending_flag = (x, y), yf
            continue
        if not xw & 0x4000:
            cur = Contour([], [], hole=bool(xw & 0x8000))
            contours.append(cur)
            cur.points.append((x, y)); cur.pflags.append(yf)
            continue
        assert cur is not None, "point before any contour start"
        cur.centers.append(pending); cur.cflags.append(pending_flag if pending else 0)
        pending = None
        cur.points.append((x, y)); cur.pflags.append(yf)
    assert len(contours) == ncont, (ncont, len(contours))
    return Glyph(0, adv, xmin, xmax, ymax, ymin, contours, flags, hint, ordinal, (e0, e1))


def load(path) -> MasterFont:
    d = open(path, "rb").read()
    assert struct.unpack(">I", d[:4])[0] == MAGIC, "not a master font"
    f = MasterFont(raw=d)
    f.site = struct.unpack(">I", d[4:8])[0]
    f.name = _cstr(d[8:0x88])
    f.master_id = struct.unpack(">H", d[0x88:0x8a])[0]
    f.date = d[0xd2:0xda].decode("latin-1").rstrip("\0")
    glen = struct.unpack(">I", d[0xda:0xde])[0]
    kblock, klen, f.vmetric = struct.unpack(">HHH", d[0xde:0xe4])
    assert kern_offset(DATA_OFF + glen) == (kblock - 1) * 0x100 + 0x88 or klen == 0
    f.unk_e8 = struct.unpack(">3H", d[0xe8:0xee])
    f.unk_ee, _, f.unk_f2 = struct.unpack(">3H", d[0xee:0xf4])
    for i in range(NSLOTS):
        cid, off = struct.unpack(">HI", d[INDEX_OFF + 6 * i:INDEX_OFF + 6 * i + 6])
        if off == 0xffffffff:
            continue
        g = parse_glyph(d, off)
        g.id = cid
        f.glyphs[cid] = g
    k0 = kern_offset(DATA_OFF + glen)
    for i in range(0, klen, 6):
        l, r, v = struct.unpack(">HHh", d[k0 + i:k0 + i + 6])
        f.kerning.append((l - 1, r - 1, v))
    return f


def kern_offset(data_end: int) -> int:
    return -(-(data_end - 0x88) // 0x100) * 0x100 + 0x88


# ---------------------------------------------------------------- writing

def encode_glyph(g: Glyph) -> bytes:
    out = bytearray()
    for c in g.contours:
        for i, (x, y) in enumerate(c.points):
            if i:
                k = c.centers[i - 1]
                if k is not None:
                    out += struct.pack(">HH", 0xc000 | (k[0] - g.xmin), (c.cflags[i - 1] << 14) | (k[1] - g.ymin))
                xw = 0x4000
            else:
                xw = 0x8000 if c.hole else 0
            pf = c.pflags[i] if i < len(c.pflags) else 0
            out += struct.pack(">HH", xw | (x - g.xmin), (pf << 14) | (y - g.ymin))
    hdr = struct.pack(">8hHhHH", g.ordinal, g.advance, g.xmin, g.xmax, g.ymax, g.ymin,
                      len(out) // 4, len(g.contours), g.flags, g.hint, *g.extra)
    return hdr + bytes(out)


def build(f: MasterFont) -> bytes:
    ids = sorted(f.glyphs)
    assert len(ids) <= NSLOTS
    # Both the index and the glyph data are in ordinal order (the Bitstream order).
    data = bytearray()
    index = bytearray()
    for cid in sorted(ids, key=lambda c: (f.glyphs[c].ordinal, c)):
        index += struct.pack(">HI", cid, len(data) // 2)
        data += encode_glyph(f.glyphs[cid])
    index += b"\xff" * 6 * (NSLOTS - len(ids)) + b"\xff\xff"
    kern = b"".join(struct.pack(">HHh", l + 1, r + 1, v) for l, r, v in f.kerning)
    name = f.name.encode("latin-1")[:59]
    hdr = bytearray(INDEX_OFF)
    hdr[0:8] = struct.pack(">II", MAGIC, f.site)
    hdr[8:0x80] = (name + b"\0").ljust(0x78, b" ")
    hdr[0x88:0x8c] = struct.pack(">HH", f.master_id, 0)
    hdr[0x8c:0xc8] = name[:59].ljust(60, b"\0")
    hdr[0xd2:0xda] = f.date.encode("latin-1")[:8].ljust(8, b"\0")
    k0 = kern_offset(DATA_OFF + len(data))
    ymax = max((g.ymax for g in f.glyphs.values()), default=0)
    hdr[0xda:0xf4] = struct.pack(">IHHHHH3HHHH", len(data), (k0 - 0x88) // 0x100 + 1, len(kern), f.vmetric,
                                 KERN_EM, f.vmetric, *f.unk_e8, ymax // 2, 1, f.unk_f2)
    out = bytes(hdr) + bytes(index) + bytes(data)
    assert len(out) == DATA_OFF + len(data)
    out += b"\0" * (k0 - len(out)) + kern
    out += b"\0" * ((8 - len(out)) % 0x40)      # file length is 8 mod 64, like the data
    return out


# ---------------------------------------------------------------- rendering

def raster(g: Glyph, scale: float, aspect: float = 1.0, tol_units: float = 6.0):
    """-> (PIL 'L' image of the glyph, origin x, origin y) at `scale` px per unit."""
    from PIL import Image, ImageDraw, ImageChops
    SS = 4
    sx, sy = scale * aspect * SS, scale * SS
    x0, y0 = min(g.xmin, 0), g.ymin
    W = max(1, int(math.ceil((max(g.xmax, g.advance) - x0) * sx)) + 2)
    H = max(1, int(math.ceil((g.ymax - g.ymin) * sy)) + 2)
    img = Image.new("1", (W, H), 0)
    for c in g.contours:
        poly = [((x - x0) * sx + 1, (g.ymax - y) * sy + 1) for x, y in c.polygon(tol_units)]
        if len(poly) < 3:
            continue
        part = Image.new("1", (W, H), 0)
        ImageDraw.Draw(part).polygon(poly, fill=1)
        img = ImageChops.logical_xor(img, part)
    out = img.convert("L").resize((max(1, W // SS), max(1, H // SS)), Image.BOX)
    return out, -x0 * scale * aspect, g.ymax * scale


def render_sheet(f: MasterFont, out_png: str, px_per_em: int = 64, cols: int = 16, ids=None):
    from PIL import Image, ImageDraw
    ids = sorted(f.glyphs) if ids is None else [i for i in ids if i in f.glyphs]
    scale = px_per_em / EM
    cw, ch = int(px_per_em * 1.5), int(px_per_em * 1.6)
    rows = (len(ids) + cols - 1) // cols
    sheet = Image.new("L", (cols * cw, rows * ch), 255)
    dr = ImageDraw.Draw(sheet)
    for n, cid in enumerate(ids):
        g = f.glyphs[cid]
        im, ox, oy = raster(g, scale)
        cx, cy = (n % cols) * cw, (n // cols) * ch
        base = cy + int(px_per_em * 1.1)
        sheet.paste(0, (cx + 8 + int(g.xmin * scale) if g.xmin < 0 else cx + 8, base - int(oy)), im)
        dr.text((cx + 2, cy + 2), str(cid), fill=128)
    sheet.save(out_png)


# ---------------------------------------------------------------- CLI

def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("info"); p.add_argument("file")
    p = sub.add_parser("render"); p.add_argument("file"); p.add_argument("out")
    p.add_argument("--em", type=int, default=64); p.add_argument("--ids", default=None)
    p = sub.add_parser("roundtrip"); p.add_argument("files", nargs="+")
    p = sub.add_parser("glyph"); p.add_argument("file"); p.add_argument("id", type=int)
    a = ap.parse_args(argv)
    if a.cmd == "info":
        f = load(a.file)
        print(f"name {f.name!r} id {f.master_id} date {f.date!r} site {f.site:#x}")
        print(f"glyphs {len(f.glyphs)} max advance {f.max_advance} kern pairs {len(f.kerning)}")
        print(f"unknowns: vmetric={f.vmetric} e8={f.unk_e8} f2={f.unk_f2:#x}")
        print("ids:", " ".join(str(i) for i in sorted(f.glyphs)))
    elif a.cmd == "render":
        f = load(a.file)
        ids = [int(x) for x in a.ids.split(",")] if a.ids else None
        render_sheet(f, a.out, a.em, ids=ids)
    elif a.cmd == "glyph":
        f = load(a.file); g = f.glyphs[a.id]
        print(g.ordinal, g.advance, (g.xmin, g.xmax, g.ymin, g.ymax), "flags", g.flags, "hint", g.hint)
        for c in g.contours:
            print(" contour hole=%s %d points" % (c.hole, len(c.points)))
            for i, pt in enumerate(c.points):
                print("   ", pt, "pf", c.pflags[i], ("arc centre %s cf %d" % (c.centers[i], c.cflags[i])) if i < len(c.centers) and c.centers[i] else "")
    elif a.cmd == "roundtrip":
        for fn in a.files:
            f = load(fn); out = build(f); raw = f.raw
            n = min(len(out), len(raw))
            diff = [i for i in range(n) if out[i] != raw[i]]
            print(fn, "len", len(raw), "->", len(out), "first diff", hex(diff[0]) if diff else None, "ndiff", len(diff))


if __name__ == "__main__":
    main()
