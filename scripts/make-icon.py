#!/usr/bin/env python3
"""
Draws the app icon, the red "!" from the MAXINE! badge on Luminary's dark gradient
tile, and writes resources/icon.png, icon.ico and icon.icns. Only needs rerunning
if the design changes; icon.icns needs macOS's iconutil. With --web it writes only the
web page's versions instead, in Retrograde's teal and blue: the 256 px page icon, plus the
PNGs and favicon.ico that link unfurlers (Slack and the like) look for, and the 512 px og:image.

    python3 scripts/make-icon.py [--web]
"""
import os, subprocess, sys, tempfile
import numpy as np
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SIZE = 1024
AA = 4                # edges are drawn this much larger, then reduced
CORNER = 230          # same tile as Luminary's icon
BAR = [(432, 192), (592, 192), (578, 576), (446, 576)]   # the badge's tapered stem
DOT = (442, 661, 582, 831)
DESKTOP = ("#f0402f", "#c8301f", [(0, "#d0322a", 0.42), (0.55, "#8a2420", 0.16), (1, "#060e17", 0)])
WEB = ("#14e0bc", "#1484dc", [(0, "#00d4aa", 0.30), (0.55, "#0a6a9a", 0.16), (1, "#060e17", 0)])
WEB_SIZE = 256


def rgb(color):
    return np.array([int(color[i:i + 2], 16) for i in (1, 3, 5)], np.float64)


def ramp(t, stops):
    """Color and opacity along `t`, from (offset, color, opacity) stops."""
    offsets = [s[0] for s in stops]
    colors = np.stack([rgb(s[1]) for s in stops])
    channels = [np.interp(t, offsets, colors[:, i]) for i in range(3)]
    return np.stack(channels, axis=-1), np.interp(t, offsets, [s[2] for s in stops])


def over(base, color, alpha):
    return base * (1 - alpha[..., None]) + color * alpha[..., None]


def radial(base, cx, cy, r, stops):
    y, x = np.mgrid[0:SIZE, 0:SIZE] + 0.5
    t = np.hypot(x / SIZE - cx, y / SIZE - cy) / r
    return over(base, *ramp(np.clip(t, 0, 1), stops))


def shape_mask(draw):
    img = Image.new("L", (SIZE * AA, SIZE * AA), 0)
    draw(ImageDraw.Draw(img))
    return np.asarray(img.resize((SIZE, SIZE), Image.BOX), np.float64) / 255


def mark(base, top, bottom, mask, first, last):
    """One part of the "!", with the colour ramp running over that part's own height."""
    t = np.clip((np.arange(SIZE) + 0.5 - top) / (bottom - top), 0, 1)
    colors = np.outer(1 - t, rgb(first)) + np.outer(t, rgb(last))
    return over(base, np.repeat(colors[:, None, :], SIZE, axis=1), mask)


def draw_icon(first, last, glow):
    y, x = np.mgrid[0:SIZE, 0:SIZE] + 0.5
    img, _ = ramp((x + y) / (2 * SIZE), [(0, "#202e3b", 1), (0.42, "#14222f", 1), (1, "#060e17", 1)])
    img = radial(img, 0.42, 0.50, 0.58, [(0, "#1a4a7a", 0.55), (1, "#060e17", 0)])
    img = radial(img, 0.50, 0.50, 0.44, glow)

    scaled = lambda points: [(px * AA, py * AA) for px, py in points]
    img = mark(img, BAR[0][1], BAR[2][1], shape_mask(lambda d: d.polygon(scaled(BAR), fill=255)), first, last)
    img = mark(img, DOT[1], DOT[3], shape_mask(lambda d: d.rectangle([v * AA for v in DOT], fill=255)), first, last)

    tile = shape_mask(lambda d: d.rounded_rectangle((0, 0, SIZE * AA - 1, SIZE * AA - 1), CORNER * AA, fill=255))
    rgba = np.dstack((img, tile * 255))
    return Image.fromarray(np.clip(np.rint(rgba), 0, 255).astype(np.uint8))


def main():
    if "--web" in sys.argv:
        full = draw_icon(*WEB)
        web = os.path.join(ROOT, "src", "web")
        full.resize((WEB_SIZE, WEB_SIZE), Image.LANCZOS).save(os.path.join(web, "assets", "icon.png"))
        full.resize((32, 32), Image.LANCZOS).save(os.path.join(web, "assets", "icon-32.png"))
        # Apple's icon is opaque and square, because iOS rounds the corners itself
        full.convert("RGB").resize((180, 180), Image.LANCZOS).save(os.path.join(web, "assets", "apple-touch-icon.png"))
        # public/ is copied to the site's root unhashed, where unfurlers ask for /favicon.ico
        os.makedirs(os.path.join(web, "public"), exist_ok=True)
        full.save(os.path.join(web, "public", "favicon.ico"), sizes=[(16, 16), (32, 32), (48, 48)])
        full.resize((512, 512), Image.LANCZOS).save(os.path.join(web, "public", "icon-512.png"))
        return

    out = draw_icon(*DESKTOP)
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
