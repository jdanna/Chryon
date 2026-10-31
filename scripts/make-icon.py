#!/usr/bin/env python3
"""
Draws the app icon from a real MAXINE glyph (the "M" of .0000, Swiss 721 Bold)
as a lit CRT tile, and writes resources/icon.png, icon.ico and icon.icns.
Only needs rerunning if the design changes; icon.icns needs macOS's iconutil.

    python3 scripts/make-icon.py
"""
import os, subprocess, sys, tempfile
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tools"))
import maxine_font as mx

SIZE = 1024
INSET = 100           # transparent margin, per the macOS icon grid
CORNER = 185
GLOW = (74, 158, 255)


def glyph_mask():
    face = mx.load(os.path.join(ROOT, "fonts", ".0000")).glyphs[ord("M")].raster()[0]
    a = np.array(face, np.uint8)
    rows, cols = np.where(a > 0)
    return Image.fromarray(a[rows.min():rows.max() + 1, cols.min():cols.max() + 1])


def main():
    tile = SIZE - 2 * INSET
    grad = np.linspace(0, 1, tile)[:, None, None]
    bg = (np.array((30, 34, 40)) * (1 - grad) + np.array((14, 16, 20)) * grad)
    img = Image.fromarray(np.repeat(bg, tile, axis=1).astype(np.uint8))

    # The glyph, enlarged with hard edges so its scanlines stay visible
    g = glyph_mask()
    w = int(tile * 0.66); h = int(w * g.height / g.width)
    g = g.resize((w, h), Image.NEAREST)
    pos = ((tile - w) // 2, (tile - h) // 2 - 16)
    ink = Image.new("L", (tile, tile), 0); ink.paste(g, pos)
    img.paste(Image.new("RGB", (tile, tile), GLOW), (0, 0), ink.filter(ImageFilter.GaussianBlur(26)).point(lambda v: v // 3))
    img.paste(Image.new("RGB", (tile, tile), (238, 244, 252)), (0, 0), ink)

    # CRT scanlines across the whole tile
    lines = Image.new("L", (tile, tile), 0); d = ImageDraw.Draw(lines)
    pitch = 12
    for y in range(0, tile, pitch):
        d.rectangle((0, y, tile, y + pitch // 3), fill=70)
    img.paste(Image.new("RGB", (tile, tile), (0, 0, 0)), (0, 0), lines)

    # The lower-third bar, the thing this hardware exists to draw
    bar = Image.new("L", (tile, tile), 0)
    ImageDraw.Draw(bar).rectangle((pos[0], pos[1] + h + 44, pos[0] + w, pos[1] + h + 74), fill=255)
    img.paste(Image.new("RGB", (tile, tile), GLOW), (0, 0), bar)

    mask = Image.new("L", (tile * 2, tile * 2), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, tile * 2 - 1, tile * 2 - 1), CORNER * 2, fill=255)
    out = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    out.paste(img, (INSET, INSET), mask.resize((tile, tile), Image.LANCZOS))

    res = os.path.join(ROOT, "resources")
    out.save(os.path.join(res, "icon.png"))
    out.save(os.path.join(res, "icon.ico"), sizes=[(s, s) for s in (16, 24, 32, 48, 64, 128, 256)])
    with tempfile.TemporaryDirectory(suffix=".iconset") as d:
        for s in (16, 32, 128, 256, 512):
            out.resize((s, s), Image.LANCZOS).save(os.path.join(d, f"icon_{s}x{s}.png"))
            out.resize((s * 2, s * 2), Image.LANCZOS).save(os.path.join(d, f"icon_{s}x{s}@2x.png"))
        subprocess.run(["iconutil", "-c", "icns", d, "-o", os.path.join(res, "icon.icns")], check=True)


if __name__ == "__main__":
    main()
