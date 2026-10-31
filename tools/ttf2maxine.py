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

Nothing here is hardware-validated yet: load the result on the MAXINE and
photograph it (see CLAUDE.md).  Stop and report if the unit fails to load it.
"""
import argparse, math, os, sys
import numpy as np
from PIL import Image, ImageDraw, ImageFont
from fontTools.ttLib import TTFont

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import maxine_font as mx

SS = 4  # supersampling factor for rasterization / edge generation


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


class Rasterizer:
    def __init__(self, path, scanlines, aspect, edge, lines, spacing, index=0):
        self.tt = TTFont(path, fontNumber=index)
        self.upm = self.tt["head"].unitsPerEm
        self.cmap = self.tt.getBestCmap()
        self.hmtx = self.tt["hmtx"]
        self.S = scanlines; self.aspect = aspect; self.edge = edge; self.lines = lines
        self.spacing = spacing
        self.px = ImageFont.truetype(path, scanlines * SS, index=index)
        self.sx = scanlines * aspect / self.upm      # output px per font unit (x)
        self.sy = scanlines / self.upm               # output rows per font unit (y)
        self.rx_ss = int(round(lines * aspect * SS)) if edge != "none" else 0
        self.ry_ss = int(round(lines * SS)) if edge != "none" else 0
        if edge == "shadow":
            self.rx_ss = max(SS, self.rx_ss // 2); self.ry_ss = max(SS, self.ry_ss // 2)
            self.sh_dx = -int(round(lines * aspect * SS)); self.sh_dy = int(round(lines * SS))

    def glyph_name(self, ch):
        return self.cmap.get(ord(ch))

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
        d.text((0, OYss), ch, font=self.px, fill=255, anchor="ls")
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


def ttf_kerning(tt, chars, scale):
    """Pair kerning in output px for the given characters, from kern + GPOS PairPos."""
    cmap = tt.getBestCmap()
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


def make_thumbnail(path, index, edge):
    img = Image.new("L", (mx.THUMB_W * 4, mx.THUMB_H * 4), 0)
    f = ImageFont.truetype(path, 44 * 4, index=index)
    d = ImageDraw.Draw(img)
    d.text((mx.THUMB_W * 2, 52 * 4), "Aa", font=f, fill=255, anchor="ms")
    a = np.asarray(img.resize((mx.THUMB_W, mx.THUMB_H), Image.BOX), dtype=np.float32) / 255.0
    if edge != "none":
        e = np.asarray(img.filter(__import__("PIL.ImageFilter", fromlist=["MaxFilter"]).MaxFilter(9))
                       .resize((mx.THUMB_W, mx.THUMB_H), Image.BOX), dtype=np.float32) / 255.0
        v = 0xee * (1 - e) + 0x88 * (e - a) + 0x00 * a
    else:
        v = 0xee * (1 - a)
    q = np.clip(np.rint(v / 0x22) * 0x22, 0, 0xee).astype(np.uint8)
    return q.tolist()


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
    ap.add_argument("--chars", default="".join(chr(c) for c in range(33, 127)))
    ap.add_argument("--no-kern", action="store_true")
    ap.add_argument("--out", default="experiments")
    ap.add_argument("--preview", action="store_true")
    a = ap.parse_args(argv)

    if not (len(a.code) == 4 and a.code.isdigit()):
        ap.error("--code must be 4 digits")
    chars = [c for c in a.chars if 33 <= ord(c) < mx.NSLOTS]
    rz = Rasterizer(a.ttf, a.scanlines, a.aspect, a.edge, a.lines if a.edge != "none" else 0, a.spacing, a.index)
    S = a.scanlines
    # vertical metrics: ascent = height of 'h' (or cap height), descent = depth of 'p'
    def h_of(ch, which):
        b = rz.bounds(ch)
        return b[which] if b else None
    letter_tops = [v for v in (h_of("h", 3), h_of("H", 3), h_of("l", 3)) if v is not None]
    asc_units = max(letter_tops) if letter_tops else rz.tt["hhea"].ascent
    desc_units = -min(v for v in (h_of("p", 1), h_of("g", 1), -abs(rz.tt["hhea"].descent)) if v is not None)
    ascent = int(round(asc_units * rz.sy)); descent = int(round(abs(desc_units) * rz.sy))
    lines = a.lines if a.edge != "none" else 0
    baseline_off = a.baseline_off if a.baseline_off is not None else (11 if a.edge == "none" else 5)
    baseline_off = max(baseline_off, lines + 2)
    baseline_row = ascent + baseline_off

    font = mx.MaxineFont()
    name = a.name or rz.tt["name"].getDebugName(4) or os.path.basename(a.ttf)
    font.name = name[:59]
    if a.edge == "none":
        font.desc1 = f"  {S} scanlines No edge "; font.desc2 = " 4 lines "
    elif a.edge == "border":
        font.desc1 = f"  {S} scanlines Border    {lines} lines            "; font.desc2 = ""
    else:
        font.desc1 = f"  {S} scanlines Border & Shdw    {lines} lines lower left"; font.desc2 = ""
    font.digits = a.master_id[:4].ljust(4, "0")
    font.cell_rows = S + 2 * lines
    font.ascent = ascent; font.descent = descent; font.baseline_off = baseline_off
    font.version = 1317

    blobs = {}
    has_edge = a.edge != "none"
    lead = 1 if has_edge else 0
    max_adv = 0
    for ch in chars:
        face, edge, top, adv = rz.render(ch, baseline_row)
        max_adv = max(max_adv, adv)
        if face is None:
            continue
        if top - lead < 0:
            raise SystemExit(f"glyph {ch!r} would start above row 0 (top={top}); raise --baseline-off")
        g = mx.Glyph(ord(ch), top - lead, adv, [])
        blobs[ord(ch)] = (g, mx.encode_glyph(face.tolist(), edge.tolist(), has_edge, lead))
    for code, (face, edge, top, adv) in underline_tiles(S, baseline_row, a.edge, lines, a.aspect).items():
        g = mx.Glyph(code, max(0, top - lead), adv, [])
        blobs[code] = (g, mx.encode_glyph(face.tolist(), edge.tolist(), has_edge, lead))
    font.max_advance = max_adv
    if not a.no_kern:
        font.kerning = ttf_kerning(rz.tt, chars, rz.sx * a.spacing)
    font.footer = mx.set_thumbnail(mx.default_footer(), make_thumbnail(a.ttf, a.index, a.edge))

    data = mx.build(font, blobs, a.code, has_edge, a.edge == "shadow")
    os.makedirs(a.out, exist_ok=True)
    out_path = os.path.join(a.out, "." + a.code)
    open(out_path, "wb").write(data)
    print(f"wrote {out_path}: {len(data)} bytes, {len(blobs)} glyphs, {len(font.kerning)} kern pairs, "
          f"cell_rows={font.cell_rows} ascent={ascent} descent={descent} baseline_row={baseline_row}")
    if a.preview:
        png = out_path + ".png"
        mx.render_sheet(mx.load(out_path), png)
        print("preview:", png)


if __name__ == "__main__":
    main()
