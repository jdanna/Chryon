#!/usr/bin/env python3
"""
TTF/OTF -> Chyron MAXINE master font (/SYSTEM/MASTER/.NNNN), the scalable outline a
machine font names at 0xce and Flash Font cuts characters from at any size.

    python3 tools/ttf2master.py Helvetica-Bold.ttf --master-id 9000 --out experiments --preview

Outlines are rescaled to 8640 units per em and every curve becomes a chain of circular
arcs, since that's all the format holds: each Bezier is split until a piece turns less
than ARC_TURN degrees, and the circle through the piece's ends and midpoint stands in for
it. A piece whose centre can't be encoded (it must sit no further left or below than
the glyph's bounding box, and within 16383 units of it) is drawn as short lines instead.
See maxine_master.py for the file layout.
"""
import math, os, sys, argparse, datetime
from typing import List, Tuple, Optional, Dict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import maxine_master as mm
from ttf2maxine import font_cmap, ttf_kerning

from fontTools.ttLib import TTFont
from fontTools.pens.basePen import BasePen

ARC_TURN = 22.5        # degrees of turning per arc
LINE_TURN = 6.0        # degrees per line segment when arcs can't be used
MAX_REL = 16383        # 14-bit relative coordinates
SAGITTA_MIN = 2.0      # arcs flatter than this (units) become lines

# Master char id -> candidate characters, best first. The ids follow the Bitstream
# master order seen in the stock fonts (maxine_master.py renders them for checking).
MASTER_CHARS: Dict[int, str] = {}
for _i, _c in enumerate("ABCDEFGHIJKLMNOPQRSTUVWXYZ"):
    MASTER_CHARS[_i] = _c
MASTER_CHARS[26] = "&"
for _i, _c in enumerate("abcdefghijklmnopqrstuvwxyz"):
    MASTER_CHARS[27 + _i] = _c
MASTER_CHARS[53] = "ﬁ"; MASTER_CHARS[54] = "ﬂ"
for _i, _c in enumerate("1234567890"):
    MASTER_CHARS[55 + _i] = _c
MASTER_CHARS.update({
    65: "£", 66: "$", 67: "¢", 68: "ƒ", 69: "%", 70: "‰", 71: "⁄/",
    72: "·∙•", 73: ".", 74: ",", 75: ":", 76: ";",
    77: "‘'", 78: "“\"", 79: "’'", 80: "”\"", 81: "‚,", 82: "„\"",
    83: "?", 84: "!", 85: "/", 86: "(", 87: ")", 88: "[", 89: "]", 90: "*",
    91: "†", 92: "‡", 93: "§", 94: "-", 95: "–-", 96: "—–-",
})


class SegmentPen(BasePen):
    """Collects each contour as a list of ('line', p1) / ('q', c, p1) / ('c', c1, c2, p1)
    after a start point, in font units."""

    def __init__(self, glyphSet):
        super().__init__(glyphSet)
        self.contours: List[list] = []

    def _moveTo(self, p):
        self.contours.append([("move", p)])

    def _lineTo(self, p):
        self.contours[-1].append(("line", p))

    def _qCurveToOne(self, c, p):
        self.contours[-1].append(("q", c, p))

    def _curveToOne(self, c1, c2, p):
        self.contours[-1].append(("c", c1, c2, p))

    def _closePath(self):
        pass

    def _endPath(self):
        pass


def _bez(seg, p0, t):
    if seg[0] == "q":
        c, p1 = seg[1], seg[2]
        u = 1 - t
        return (u * u * p0[0] + 2 * u * t * c[0] + t * t * p1[0],
                u * u * p0[1] + 2 * u * t * c[1] + t * t * p1[1])
    c1, c2, p1 = seg[1], seg[2], seg[3]
    u = 1 - t
    return (u ** 3 * p0[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t ** 3 * p1[0],
            u ** 3 * p0[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t ** 3 * p1[1])


def _turning(seg, p0, samples=16) -> float:
    """Total absolute turning of a Bezier in degrees, from sampled chords."""
    pts = [_bez(seg, p0, i / samples) for i in range(samples + 1)]
    angs = []
    for a, b in zip(pts, pts[1:]):
        if (b[0] - a[0], b[1] - a[1]) != (0, 0):
            angs.append(math.atan2(b[1] - a[1], b[0] - a[0]))
    return sum(abs((b - a + math.pi) % (2 * math.pi) - math.pi) for a, b in zip(angs, angs[1:])) * 180 / math.pi


def circle_through(p0, pm, p1) -> Optional[Tuple[float, float, float]]:
    """Centre and radius of the circle through three points, or None if collinear."""
    ax, ay = p0; bx, by = pm; cx, cy = p1
    d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by))
    if abs(d) < 1e-9:
        return None
    a2, b2, c2 = ax * ax + ay * ay, bx * bx + by * by, cx * cx + cy * cy
    ux = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d
    uy = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d
    return ux, uy, math.hypot(ax - ux, ay - uy)


def fit_contour(contour: list, s: float) -> Tuple[List[Tuple[int, int]], List[Optional[Tuple[float, float]]], List[list]]:
    """-> (points, centres, fallback) in master units, closed (the last point repeats the
    first). centres[i] is the circle centre for the arc from points[i] to points[i+1] or
    None; fallback[i] holds the line points to use instead when that centre can't be
    encoded."""
    pts: List[Tuple[int, int]] = []
    centres: List[Optional[Tuple[float, float]]] = []
    fallback: List[list] = []
    cur = None

    def put(p):
        q = (int(round(p[0] * s)), int(round(p[1] * s)))
        if pts and pts[-1] == q:
            return False
        pts.append(q)
        return True

    for seg in contour:
        if seg[0] == "move":
            put(seg[1]); cur = seg[1]
            continue
        if seg[0] == "line":
            if put(seg[1]):
                centres.append(None); fallback.append([])
            cur = seg[1]
            continue
        p0 = cur
        n = max(1, int(math.ceil(_turning(seg, p0) / ARC_TURN)))
        for k in range(n):
            t0, t1 = k / n, (k + 1) / n
            a = _bez(seg, p0, t0); m = _bez(seg, p0, (t0 + t1) / 2); b = _bez(seg, p0, t1)
            start = len(pts)
            if not put(b):
                continue
            au, mu, bu = [(p[0] * s, p[1] * s) for p in (a, m, b)]
            circ = circle_through(au, mu, bu)
            chord = math.hypot(bu[0] - au[0], bu[1] - au[1])
            if circ is None or circ[2] > 4 * MAX_REL or circ[2] - math.sqrt(max(0.0, circ[2] ** 2 - chord * chord / 4)) < SAGITTA_MIN:
                centres.append(None); fallback.append([])
            else:
                centres.append((circ[0], circ[1]))
                steps = max(2, int(math.ceil(_turning(seg, p0) / n / LINE_TURN)))
                fallback.append([_bez(seg, p0, t0 + (t1 - t0) * j / steps) for j in range(1, steps)])
        cur = seg[-1]
    if len(pts) > 1 and pts[-1] != pts[0]:      # close with a line
        pts.append(pts[0]); centres.append(None); fallback.append([])
    return pts, centres, fallback


def _area(poly) -> float:
    return sum(x0 * y1 - x1 * y0 for (x0, y0), (x1, y1) in zip(poly, poly[1:] + poly[:1])) / 2


def _inside(pt, poly) -> bool:
    x, y = pt; n = len(poly); inside = False
    for i in range(n):
        (x0, y0), (x1, y1) = poly[i], poly[(i + 1) % n]
        if (y0 > y) != (y1 > y):
            if x < x0 + (y - y0) * (x1 - x0) / (y1 - y0):
                inside = not inside
    return inside


def build_glyph(tt, glyphset, gname: str, s: float, adv_units: int) -> Optional[mm.Glyph]:
    pen = SegmentPen(glyphset)
    glyphset[gname].draw(pen)
    fitted = [fit_contour(c, s) for c in pen.contours if len(c) > 2]
    fitted = [f for f in fitted if len(f[0]) >= 4]
    if not fitted:
        return None
    # Close every contour, orient it clockwise (negative area, y up) and flag holes.
    raw: List[mm.Contour] = []
    for pts, centres, fb in fitted:
        c = mm.Contour(list(pts), list(centres), False, [0] * len(pts), [2 if k else 0 for k in centres])
        c.fallback = fb        # type: ignore[attr-defined]
        if _area(c.polygon(4)) > 0:
            c.points.reverse(); c.centers.reverse(); c.cflags.reverse()
            c.fallback = [[p for p in reversed(f)] for f in reversed(fb)]    # type: ignore[attr-defined]
        raw.append(c)
    polys = [c.polygon(4) for c in raw]
    for i, c in enumerate(raw):
        c.hole = sum(_inside(c.points[0], p) for j, p in enumerate(polys) if j != i) % 2 == 1
    xs = [x for c in raw for x, y in c.polygon(2)]; ys = [y for c in raw for x, y in c.polygon(2)]
    xmin, xmax = int(math.floor(min(xs))), int(math.ceil(max(xs)))
    ymin, ymax = int(math.floor(min(ys))), int(math.ceil(max(ys)))
    if xmax - xmin > MAX_REL or ymax - ymin > MAX_REL:
        return None
    # Replace arcs whose centre can't be encoded by their line fallback, and round centres.
    contours: List[mm.Contour] = []
    for c in raw:
        pts: List[Tuple[int, int]] = [c.points[0]]
        centres: List[Optional[Tuple[int, int]]] = []
        for i in range(len(c.points) - 1):
            k = c.centers[i]
            if k is not None:
                kx, ky = int(round(k[0])), int(round(k[1]))
                if 0 <= kx - xmin <= MAX_REL and 0 <= ky - ymin <= MAX_REL:
                    centres.append((kx, ky)); pts.append(c.points[i + 1])
                    continue
                for p in c.fallback[i]:      # type: ignore[attr-defined]
                    q = (int(round(p[0] * s)), int(round(p[1] * s)))
                    if q != pts[-1]:
                        pts.append(q); centres.append(None)
            if c.points[i + 1] != pts[-1]:
                pts.append(c.points[i + 1]); centres.append(None)
        contours.append(mm.Contour(pts, centres, c.hole, [0] * len(pts), [2 if k else 0 for k in centres]))
    return mm.Glyph(0, adv_units, xmin, xmax, ymax, ymin, contours)


def convert_master(ttf, master_id="9000", name=None, out="experiments", index=0, kern=True,
                   preview=False, log=print):
    """Write <out>/.<master_id> from a TTF/OTF face. Returns (path, preview_png_or_None)."""
    if not (len(master_id) == 4 and master_id.isdigit()):
        raise ValueError("master id must be 4 digits")
    tt = TTFont(ttf, fontNumber=index)
    if "head" not in tt or not ("glyf" in tt or "CFF " in tt):
        raise ValueError("This font has no scalable outlines, it may be bitmap-only.")
    cmap, _, _ = font_cmap(tt)
    glyphset = tt.getGlyphSet()
    hmtx = tt["hmtx"]
    s = mm.EM / tt["head"].unitsPerEm
    font = mm.MasterFont()
    font.name = (name or tt["name"].getDebugName(4) or os.path.basename(ttf))[:59]
    font.master_id = int(master_id)
    font.date = datetime.date.today().strftime("%d %m %y")
    chosen: Dict[int, str] = {}
    for cid, cands in MASTER_CHARS.items():
        for ch in cands:
            gname = cmap.get(ord(ch))
            if gname and gname in glyphset:
                chosen[cid] = ch
                break
    if not any(c.isalpha() or c.isdigit() for c in chosen.values()):
        raise ValueError("This font has none of the MAXINE's characters, so there is nothing to convert.")
    skipped = []
    for n, cid in enumerate(sorted(chosen)):
        ch = chosen[cid]; gname = cmap[ord(ch)]
        adv = int(round(hmtx[gname][0] * s))
        g = build_glyph(tt, glyphset, gname, s, adv)
        if g is None:
            skipped.append(ch)
            continue
        g.id = cid; g.ordinal = len(font.glyphs)
        font.glyphs[cid] = g
    if skipped:
        log("no outline for: " + " ".join(skipped))
    if kern:
        chars = list(chosen.values())
        ids = {ord(ch): cid for cid, ch in chosen.items()}
        pairs = ttf_kerning(tt, chars, mm.KERN_EM / tt["head"].unitsPerEm, cmap)
        font.kerning = sorted((ids[l], ids[r], v) for l, r, v in pairs if l in ids and r in ids)
    data = mm.build(font)
    os.makedirs(out, exist_ok=True)
    path = os.path.join(out, "." + master_id)
    open(path, "wb").write(data)
    arcs = sum(1 for g in font.glyphs.values() for c in g.contours for k in c.centers if k)
    recs = sum(g.nrecords for g in font.glyphs.values())
    log(f"wrote {path}: {len(data)} bytes, {len(font.glyphs)} glyphs, {arcs} arcs in {recs} records, "
        f"{len(font.kerning)} kern pairs")
    png = None
    if preview:
        png = path + ".png"
        mm.render_sheet(mm.load(path), png)
        log("preview: " + png)
    return path, png


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("ttf")
    ap.add_argument("--index", type=int, default=0, help="face index inside a .ttc")
    ap.add_argument("--master-id", default="9000", help="4-digit id: the file is named .ID")
    ap.add_argument("--name", default=None)
    ap.add_argument("--no-kern", action="store_true")
    ap.add_argument("--out", default="experiments")
    ap.add_argument("--preview", action="store_true")
    a = ap.parse_args(argv)
    try:
        convert_master(a.ttf, a.master_id, a.name, a.out, a.index, not a.no_kern, a.preview)
    except ValueError as e:
        ap.error(str(e))


if __name__ == "__main__":
    main()
