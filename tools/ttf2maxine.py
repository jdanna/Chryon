#!/usr/bin/env python3
"""
TTF/OTF -> Chyron MAXINE machine font (.NNNN) converter.

    python3 tools/ttf2maxine.py "/System/Library/Fonts/Supplemental/Arial Bold.ttf" \
        --scanlines 46 --code 9100 --out experiments/ --preview

Produces experiments/.9100 (the 4-digit dotfile name is what the MAXINE expects).

Options of note:
  --edge none|border|shadow   edge style (shadow = border + lower-left drop shadow)
  --lines N                   edge thickness in scanlines (default 3)
  --aspect R                  horizontal pixels per vertical row (default 1.17,
                              measured from the original Swiss 721 Bold file)
  --spacing F                 advance-width multiplier (default 0.95; originals are
                              tighter than the Bitstream metrics)
  --chars "..."               characters to include (default: ASCII 33..126)
  --no-kern                   don't copy pair kerning from the TTF (kern/GPOS)
  --preview                   also write a PNG specimen rendered *from the output file*

Load the result on the MAXINE and photograph it (see CLAUDE.md).  Stop and
report if the unit fails to load it.
"""
import argparse, math, os, string, sys, unicodedata
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont
from fontTools.ttLib import TTFont

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import maxine_font as mx

SS = 4  # supersampling factor for rasterization / edge generation
# The hardware test string (see CLAUDE.md), so a specimen can be held up against a CRT
# photo, plus a last line for the remaining punctuation.
SPECIMEN = ["ABCDEFGHIJKLM", "NOPQRSTUVWXYZ", "abcdefghijklm", "nopqrstuv", "wxyz", "1234567890",
            "!$%'&*(),-/", ".:;<>?@#+=[]{}|~\"\\^_`"]


def dilate_ellipse(mask: np.ndarray, rx: int, ry: int) -> np.ndarray:
    """Binary dilation of a bool HxW array with an ellipse of radii rx (cols), ry (rows)."""
    H, W = mask.shape
    pad = ry + 1
    m = np.zeros((H + 2 * pad, W), bool); m[pad:pad + H] = mask
    cs = np.zeros((m.shape[0] + 1, W), np.int32); cs[1:] = np.cumsum(m, axis=0)
    out = np.zeros_like(mask)
    for dx in range(-rx, rx + 1):
        h = int(math.floor(ry * math.sqrt(max(0.0, 1 - (dx / rx) ** 2)))) if rx else ry
        ys = np.arange(H) + pad
        col = (cs[ys + h + 1] - cs[ys - h]) > 0      # any ink within +-h rows
        if dx >= 0:
            out[:, dx:] |= col[:, :W - dx] if dx else col
        else:
            out[:, :W + dx] |= col[:, -dx:]
    return out


def box_down(a: np.ndarray, fx: float, fy: int) -> np.ndarray:
    """Downsample float array (0..1) by integer fy vertically and float fx horizontally."""
    H, W = a.shape
    img = Image.fromarray((a * 255).astype(np.uint8))
    out = img.resize((max(1, int(round(W / fx))), H // fy), Image.BOX)
    return np.asarray(out, dtype=np.float32) / 255.0


def quant8(a: np.ndarray) -> np.ndarray:
    return np.clip(np.rint(a * 255), 0, 255).astype(np.uint8)


def font_cmap(tt):
    """(code -> glyph name, PIL encoding, code offset for drawing).  Symbol fonts like Wingdings keep
    their glyphs on the ASCII keys in a Mac Roman or Microsoft Symbol (0xF0xx) table, not in Unicode."""
    best = tt.getBestCmap() or {}
    if any(33 <= c < 127 for c in best):
        return best, "", 0
    mac = tt["cmap"].getcmap(1, 0)
    if mac and any(33 <= c < 127 for c in mac.cmap):
        return dict(mac.cmap), "armn", 0
    sym = tt["cmap"].getcmap(3, 0)
    keyed = {c & 0xFF: g for c, g in sym.cmap.items() if c & 0xFF00 == 0xF000} if sym else {}
    if keyed:
        return keyed, "symb", 0xF000
    return best, "", 0


class Rasterizer:
    def __init__(self, path, scanlines, aspect, edge, lines, spacing, index=0):
        self.tt = TTFont(path, fontNumber=index)
        if "head" not in self.tt or not ("glyf" in self.tt or "CFF " in self.tt):
            raise ValueError("This font has no scalable outlines, it may be bitmap-only.")
        self.upm = self.tt["head"].unitsPerEm
        self.cmap, self.encoding, self.code_offset = font_cmap(self.tt)
        self.hmtx = self.tt["hmtx"]
        self.S = scanlines; self.aspect = aspect; self.edge = edge; self.lines = lines
        self.spacing = spacing
        try:
            self.px = ImageFont.truetype(path, scanlines * SS, index=index, encoding=self.encoding)
            self.px.getbbox("A")         # loads a glyph, which is what fails on broken hinting
        except OSError as e:
            raise ValueError(f"FreeType can't render this font ({e}).")
        self.sx = scanlines * aspect / self.upm      # output px per font unit (x)
        self.sy = scanlines / self.upm               # output rows per font unit (y)
        self.rx_ss = int(round(lines * aspect * SS)) if edge != "none" else 0
        self.ry_ss = int(round(lines * SS)) if edge != "none" else 0
        if edge == "shadow":
            self.rx_ss = max(SS, self.rx_ss // 2); self.ry_ss = max(SS, self.ry_ss // 2)
            self.sh_dx = -int(round(lines * aspect * SS)); self.sh_dy = int(round(lines * SS))

    def glyph_name(self, ch):
        return self.cmap.get(ord(ch))

    def draw_char(self, ch):
        """The character to hand PIL for `ch`, under this font's encoding."""
        return chr(ord(ch) + self.code_offset)

    def ascii_count(self):
        return sum(1 for c in range(33, 127) if c in self.cmap)

    def letter_count(self):
        return sum(1 for c in map(ord, string.ascii_letters) if c in self.cmap)

    def bounds(self, ch):
        """(xMin, yMin, xMax, yMax) in font units, or None."""
        gn = self.glyph_name(ch)
        if gn is None:
            return None
        if "glyf" in self.tt:
            g = self.tt["glyf"][gn]
            if g.numberOfContours == 0:
                return None
            g.recalcBounds(self.tt["glyf"])
            return g.xMin, g.yMin, g.xMax, g.yMax
        # CFF: use the bounds from the charstring
        cs = self.tt["CFF "].cff.topDictIndex[0].CharStrings[gn]
        b = cs.calcBounds(None)
        return b

    def advance(self, ch):
        gn = self.glyph_name(ch)
        return self.hmtx[gn][0] if gn else 0

    def render(self, ch, baseline_row):
        """Rasterize one glyph.  Returns (face, edge, top, advance_px) where face/edge
        are uint8 HxW arrays cropped to the glyph's rows, top is the first row."""
        b = self.bounds(ch)
        adv_px = int(round(self.advance(ch) * self.sx * self.spacing))
        if b is None:
            return None, None, 0, adv_px
        xMin, yMin, xMax, yMax = b
        # supersampled canvas: pen x at column OX, baseline at row OY
        margin = max(self.rx_ss, self.ry_ss) + SS * 2
        left_units = min(0, xMin)                     # ink left of the pen
        OXss = margin + int(math.ceil(-left_units * self.sx * SS))
        Wss = OXss + int(math.ceil(xMax * self.sx * SS)) + margin + SS
        # make the output width an integer multiple relationship: Wout = Wss / (SS) ... we
        # already folded aspect into sx, so the horizontal downsample factor is exactly SS.
        Wss = int(math.ceil(Wss / SS) * SS)
        rows_total = baseline_row + int(math.ceil(-yMin * self.sy)) + self.lines + 4
        Hss = rows_total * SS
        OYss = baseline_row * SS
        img = Image.new("L", (Wss, Hss), 0)
        # PIL renders with square pixels; stretch horizontally by `aspect` afterwards.
        d = ImageDraw.Draw(img)
        d.text((0, OYss), self.draw_char(ch), font=self.px, fill=255, anchor="ls")
        a = np.asarray(img, dtype=np.float32) / 255.0
        # horizontal stretch: resample width by aspect, then shift so the pen lands on OXss
        if abs(self.aspect - 1.0) > 1e-6:
            stretched = Image.fromarray((a * 255).astype(np.uint8)).resize(
                (int(round(Wss * self.aspect)), Hss), Image.BILINEAR)
            a2 = np.zeros((Hss, Wss), np.float32)
            s = np.asarray(stretched, dtype=np.float32) / 255.0
            w = min(Wss - OXss, s.shape[1])
            a2[:, OXss:OXss + w] = s[:, :w]
            a = a2
        else:
            a = np.roll(a, OXss, axis=1)
        face_ss = a
        if self.edge != "none":
            binm = face_ss > 0.5
            edge_ss = dilate_ellipse(binm, self.rx_ss, self.ry_ss)
            if self.edge == "shadow":
                sh = np.zeros_like(edge_ss)
                dx, dy = self.sh_dx, self.sh_dy
                src = edge_ss | binm
                sh[dy:, :] = src[:-dy, :] if dy else src
                if dx < 0:
                    sh2 = np.zeros_like(sh); sh2[:, :dx] = sh[:, -dx:]; sh = sh2
                edge_ss = edge_ss | sh
            edge = box_down(edge_ss.astype(np.float32), SS, SS)
        face = box_down(face_ss, SS, SS)
        face = quant8(face)
        edge = quant8(edge) if self.edge != "none" else np.zeros_like(face)
        if self.edge != "none":
            edge = np.maximum(edge, (face > 0).astype(np.uint8) * 255)  # edge under face
        # crop rows
        any_row = np.where((face > 0).any(axis=1) | (edge > 0).any(axis=1))[0]
        if len(any_row) == 0:
            return None, None, 0, adv_px
        top, bot = int(any_row[0]), int(any_row[-1])
        # crop columns: start at the pen (or at the ink if it overhangs left); keep width to last ink
        OX = OXss // SS
        any_col = np.where((face > 0).any(axis=0) | (edge > 0).any(axis=0))[0]
        x0 = min(OX, int(any_col[0])); x1 = int(any_col[-1]) + 1
        if x0 < OX:        # ink left of the pen: shift the glyph right instead (no negative lsb)
            adv_px += OX - x0
        face = face[top:bot + 1, x0:x1]; edge = edge[top:bot + 1, x0:x1]
        return face, edge, top, max(1, adv_px)


def underline_tiles(S, baseline_row, edge, lines, aspect):
    """The four underline tiles stored at codes 0..3 (scaled from .0000)."""
    adv = max(2, int(round(17 * S / 46 * aspect / 1.17)))
    lead = int(round(5 * S / 46)); ramp = 2
    n_full = max(1, int(round(3 * S / 46)))
    out = {}
    for code in range(4):
        left_soft = code in (0, 2); right_soft = code in (0, 1)
        W = lead + adv + ramp * 2
        rows = []
        for r in range(n_full + 2):
            row = [0] * W
            if r == n_full + 1:
                rows.append(row); continue
            half = (r == 0)
            x = lead
            seq = ([0x30, 0xaf] if left_soft else []) + [0xff] * (adv + ramp * 2 - (ramp if left_soft else 0) - (ramp if right_soft else 0)) + ([0x8f, 0x10] if right_soft else [])
            for v in seq:
                if x < W:
                    row[x] = v // 2 if half else v
                x += 1
            rows.append(row)
        face = np.array(rows, np.uint8)
        if edge != "none":
            top = baseline_row + lines + 1
        else:
            top = baseline_row - n_full
        ed = np.zeros_like(face)
        if edge != "none":
            ed = np.maximum((face > 0).astype(np.uint8) * 255, 0)
        out[code] = (face, ed, top, adv)
    return out


def ttf_kerning(tt, chars, scale, cmap):
    """Pair kerning in output px for the given characters, from kern + GPOS PairPos."""
    name2code = {}
    for ch in chars:
        gn = cmap.get(ord(ch))
        if gn:
            name2code.setdefault(gn, ord(ch))
    pairs = {}
    if "kern" in tt:
        for st in tt["kern"].kernTables:
            for (l, r), v in getattr(st, "kernTable", {}).items():
                if l in name2code and r in name2code:
                    pairs[(name2code[l], name2code[r])] = v
    if "GPOS" in tt:
        gpos = tt["GPOS"].table
        lookups = gpos.LookupList.Lookup if gpos.LookupList else []
        for lk in lookups:
            for st in lk.SubTable:
                if lk.LookupType == 9:
                    st = st.ExtSubTable
                if getattr(st, "LookupType", lk.LookupType if lk.LookupType != 9 else 2) != 2:
                    continue
                cov = st.Coverage.glyphs
                if st.Format == 1:
                    for gi, ps in enumerate(st.PairSet):
                        l = cov[gi]
                        for pv in ps.PairValueRecord:
                            r = pv.SecondGlyph
                            v = getattr(pv.Value1, "XAdvance", 0) if pv.Value1 else 0
                            if v and l in name2code and r in name2code:
                                pairs.setdefault((name2code[l], name2code[r]), v)
                elif st.Format == 2:
                    c1 = st.ClassDef1.classDefs; c2 = st.ClassDef2.classDefs
                    for l in cov:
                        if l not in name2code:
                            continue
                        k1 = c1.get(l, 0)
                        for r, rc in name2code.items():
                            k2 = c2.get(r, 0)
                            try:
                                rec = st.Class1Record[k1].Class2Record[k2]
                            except IndexError:
                                continue
                            v = getattr(rec.Value1, "XAdvance", 0) if rec.Value1 else 0
                            if v:
                                pairs.setdefault((name2code[l], rc), v)
    out = []
    for (l, r), v in sorted(pairs.items()):
        k = int(round(v * scale))
        if k and -32768 <= k <= 32767:
            out.append((l, r, k))
    return out


def aa_image(rz, path, index, edge, size, em, baseline):
    """A size×size "Aa" at `em` px with its baseline on `baseline`, left-aligned and clipped
    on the right like the originals. Background 0xee, face 0x00, edge gray, in 0x22 steps."""
    img = Image.new("L", (size * 4, size * 4), 0)
    f = ImageFont.truetype(path, em * 4, index=index, encoding=rz.encoding)
    ImageDraw.Draw(img).text((2 * 4, baseline * 4), rz.draw_char("A") + rz.draw_char("a"), font=f, fill=255, anchor="ls")
    a = np.asarray(img.resize((size, size), Image.BOX), dtype=np.float32) / 255.0
    if edge != "none":
        e = np.asarray(img.filter(ImageFilter.MaxFilter(9)).resize((size, size), Image.BOX), dtype=np.float32) / 255.0
        v = 0xee * (1 - e) + 0x88 * (e - a) + 0x00 * a
    else:
        v = 0xee * (1 - a)
    return np.clip(np.rint(v / 0x22) * 0x22, 0, 0xee).astype(np.uint8).tolist()


def make_thumbnail(rz, path, index, edge):
    """(66x66 thumbnail, 30x30 browser icon), laid out like the originals' footers."""
    return (aa_image(rz, path, index, edge, mx.THUMB, 44, 48),
            aa_image(rz, path, index, edge, mx.ICON, 20, 22))


def vertical_metrics(rz, chars, edge, lines, baseline_off=None, log=print):
    """(ascent, descent, baseline offset) in rows, with `lines` already 0 for a no-edge font."""
    # ascent = height of h/H/l, descent = depth of p/g
    def h_of(ch, which):
        b = rz.bounds(ch)
        return b[which] if b else None
    letter_tops = [v for v in (h_of("h", 3), h_of("H", 3), h_of("l", 3)) if v is not None]
    asc_units = max(letter_tops) if letter_tops else rz.tt["hhea"].ascent
    desc_units = -min(v for v in (h_of("p", 1), h_of("g", 1), -abs(rz.tt["hhea"].descent)) if v is not None)
    ascent = int(round(asc_units * rz.sy)); descent = int(round(abs(desc_units) * rz.sy))
    baseline_off = baseline_off if baseline_off is not None else (11 if edge == "none" else 5)
    baseline_off = max(baseline_off, lines + 2)
    # make sure the tallest glyph (plus edge and the leading empty row) fits above row 0
    lead_rows = 1 if edge != "none" else 0
    tallest = max((rz.bounds(c)[3] for c in chars if rz.bounds(c)), default=asc_units)
    need = int(math.ceil(tallest * rz.sy)) + lines + lead_rows + 1
    if ascent + baseline_off < need:
        log(f"raising baseline offset {baseline_off} -> {need - ascent} so tall glyphs fit")
        baseline_off = need - ascent
    return ascent, descent, baseline_off


def specimen(has):
    """SPECIMEN without the lines a font would leave blank; `has` tests one character."""
    return [line for line in SPECIMEN if any(has(c) for c in line)]


def sample_text(rz, per_line=13, rows=8):
    """For a font with no Latin letters: lines of its own script, then whatever ASCII it does have."""
    typed = specimen(rz.glyph_name)
    def visible(c):      # private-use counts: some fonts have nothing else
        cat = unicodedata.category(chr(c))
        return c > 126 and cat[0] not in "MZ" and cat not in ("Cc", "Cf", "Cs")
    codes = sorted(filter(visible, rz.cmap), key=lambda c: (unicodedata.category(chr(c))[0] != "L", c))
    codes = codes[:per_line * max(1, rows - len(typed))]
    return ["".join(map(chr, codes[i:i + per_line])) for i in range(0, len(codes), per_line)] + typed


def source_sheet(ttf, out, scanlines=46, aspect=1.17, spacing=0.95, kern=True, edge="none", lines=3,
                 index=0, font=None, scale=3):
    """Specimen of the source outlines, laid out like mx.render_sheet so the two can be compared
    glyph for glyph.  `font` is the converted file; without one the layout comes from the metrics
    convert() would use, which makes this the preview before converting.  `out` is a path or stream.
    Returns how many of the 94 printable ASCII characters and 52 letters the font has; with no
    letters, the preview shows its own script too."""
    lines = lines if edge != "none" else 0
    rz = Rasterizer(ttf, scanlines, aspect, edge, lines, spacing, index)
    if font is not None:
        text = specimen(lambda c: ord(c) in font.glyphs)
        advance = {c: g.advance for c, g in font.glyphs.items()}
        kmap = {(a, b): k for a, b, k in font.kerning}
        baseline_row = font.baseline_row
        LH, width = mx.sheet_size(font, text)
    else:
        text = specimen(rz.glyph_name) if rz.letter_count() else sample_text(rz)
        chars = sorted(set("".join(text)))
        advance = {ord(c): int(round(rz.advance(c) * rz.sx * spacing)) for c in chars if rz.glyph_name(c)}
        if not advance:
            raise ValueError("This font has no characters to preview.")
        kmap = {(a, b): k for a, b, k in ttf_kerning(rz.tt, chars, rz.sx * spacing, rz.cmap)} if kern else {}
        ascent, _, baseline_off = vertical_metrics(rz, [chr(c) for c in range(33, 127)] + chars, edge, lines, log=lambda m: None)
        baseline_row = ascent + baseline_off
        depth = max((-rz.bounds(chr(c))[1] for c in advance if rz.bounds(chr(c))), default=0)
        LH = baseline_row + int(math.ceil(depth * rz.sy)) + lines + 5
        width = max(sum(advance.get(ord(ch), 0) for ch in line) for line in text) + 40
    W, H = width, LH * len(text) + 10
    canvas = Image.new("L", (W * SS, H * SS), 0)
    for li, line in enumerate(text):
        x0 = 10; prev = None
        for ch in line:
            c = ord(ch)
            if c not in advance:
                continue
            if prev is not None:
                x0 += kmap.get((prev, c), 0)
            l, t, r, b = rz.px.getbbox(rz.draw_char(ch), anchor="ls")
            if r > l and b > t:
                img = Image.new("L", (r - l + 2, b - t + 2), 0)
                ImageDraw.Draw(img).text((1 - l, 1 - t), rz.draw_char(ch), font=rz.px, fill=255, anchor="ls")
                img = img.resize((int(round(img.width * aspect)), img.height), Image.BILINEAR)
                canvas.paste(255, (x0 * SS + int(round((l - 1) * aspect)), (li * LH + baseline_row) * SS + t - 1), img)
            x0 += advance[c]; prev = c
    mask = canvas.resize((W * scale, H * scale), Image.BOX)
    sheet = Image.new("RGB", mask.size, (30, 30, 30))
    sheet.paste((255, 255, 255), (0, 0), mask)
    sheet.save(out, "PNG")
    return rz.ascii_count(), rz.letter_count()


def convert(ttf, scanlines=46, code="9100", master_id="9000", name=None, edge="none", lines=3,
            aspect=1.17, spacing=0.95, baseline_off=None, chars=None, kern=True, out="experiments",
            preview=False, index=0, log=print):
    """Convert one TTF/OTF face to a MAXINE font file. Returns (font_path, preview_png_or_None)."""
    if not (len(code) == 4 and code.isdigit()):
        raise ValueError("code must be 4 digits")
    if chars is None:
        chars = "".join(chr(c) for c in range(33, 127))
    chars = [c for c in chars if 33 <= ord(c) < mx.NSLOTS]
    rz = Rasterizer(ttf, scanlines, aspect, edge, lines if edge != "none" else 0, spacing, index)
    if not any(rz.glyph_name(c) for c in chars):
        raise ValueError("This font has none of those characters, so there is nothing to convert.")
    S = scanlines
    lines = lines if edge != "none" else 0
    ascent, descent, baseline_off = vertical_metrics(rz, chars, edge, lines, baseline_off, log)
    baseline_row = ascent + baseline_off

    font = mx.MaxineFont()
    name = name or rz.tt["name"].getDebugName(4) or os.path.basename(ttf)
    font.name = name[:59]
    if edge == "none":
        font.desc1 = f"  {S} scanlines No edge "; font.desc2 = " 4 lines "
    elif edge == "border":
        font.desc1 = f"  {S} scanlines Border    {lines} lines            "; font.desc2 = ""
    else:
        font.desc1 = f"  {S} scanlines Border & Shdw    {lines} lines lower left"; font.desc2 = ""
    font.digits = master_id[:4].ljust(4, "0")
    font.cell_rows = S + 2 * lines
    font.ascent = ascent; font.descent = descent; font.baseline_off = baseline_off
    font.version = 1317

    blobs = {}
    has_edge = edge != "none"
    lead = 1 if has_edge else 0
    max_adv = 0
    for ch in chars:
        face, ed, top, adv = rz.render(ch, baseline_row)
        max_adv = max(max_adv, adv)
        if face is None:
            continue
        if top - lead < 0:
            raise ValueError(f"glyph {ch!r} would start above row 0 (top={top}); raise baseline_off")
        g = mx.Glyph(ord(ch), top - lead, adv, [])
        blobs[ord(ch)] = (g, mx.encode_glyph(face.tolist(), ed.tolist(), has_edge, lead))
    for c, (face, ed, top, adv) in underline_tiles(S, baseline_row, edge, lines, aspect).items():
        g = mx.Glyph(c, max(0, top - lead), adv, [])
        blobs[c] = (g, mx.encode_glyph(face.tolist(), ed.tolist(), has_edge, lead))
    font.max_advance = max_adv
    if kern:
        font.kerning = ttf_kerning(rz.tt, chars, rz.sx * spacing, rz.cmap)
    font.footer = mx.set_thumbnail(mx.default_footer(), *make_thumbnail(rz, ttf, index, edge))

    data = mx.build(font, blobs, code, has_edge, edge == "shadow")
    os.makedirs(out, exist_ok=True)
    out_path = os.path.join(out, "." + code)
    open(out_path, "wb").write(data)
    log(f"wrote {out_path}: {len(data)} bytes, {len(blobs)} glyphs, {len(font.kerning)} kern pairs, "
        f"cell_rows={font.cell_rows} ascent={ascent} descent={descent} baseline_row={baseline_row}")
    png = None
    if preview:
        png = out_path + ".png"
        mx.render_sheet(mx.load(out_path), png)
        log("preview: " + png)
    return out_path, png


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("ttf")
    ap.add_argument("--index", type=int, default=0, help="face index inside a .ttc")
    ap.add_argument("--scanlines", type=int, default=46)
    ap.add_argument("--code", default="9100", help="4-digit output code (file is named .CODE)")
    ap.add_argument("--master-id", default="9000", help="4-digit master font id written at 0xce")
    ap.add_argument("--name", default=None, help="font display name (default from the TTF)")
    ap.add_argument("--edge", choices=["none", "border", "shadow"], default="none")
    ap.add_argument("--lines", type=int, default=3, help="edge thickness / shadow offset in lines")
    ap.add_argument("--aspect", type=float, default=1.17)
    ap.add_argument("--spacing", type=float, default=0.95)
    ap.add_argument("--baseline-off", type=int, default=None, help="rows between ascent and baseline (0xfe); default 11 no-edge / 5 edge")
    ap.add_argument("--chars", default=None)
    ap.add_argument("--no-kern", action="store_true")
    ap.add_argument("--out", default="experiments")
    ap.add_argument("--preview", action="store_true")
    a = ap.parse_args(argv)
    try:
        convert(a.ttf, a.scanlines, a.code, a.master_id, a.name, a.edge, a.lines, a.aspect, a.spacing,
                a.baseline_off, a.chars, not a.no_kern, a.out, a.preview, a.index)
    except ValueError as e:
        ap.error(str(e))


if __name__ == "__main__":
    main()
