# Chyron MAXINE font tools

Reverse engineering of the "Machine Font" file format used by the Chyron
MAXINE! / iNFiNiT! family of broadcast character generators, and a
TTF/OTF → MAXINE converter, so new typefaces can be loaded onto these vintage
systems for preservation and restoration work.

> **Status: decoded offline, not yet tested on hardware.**
> The format description and the converter were derived entirely from static
> analysis of 36 original font files. The reader decodes every original to
> clean, correct letterforms and re-encodes them identically, but **no file
> produced by the converter has been loaded on a real MAXINE yet**. Treat the
> converter's output as experimental until `experiments/.9100` has been
> confirmed on the unit. See `experiments/MANIFEST.md` for the test plan.

## What's in the format

A MAXINE font is an 8-bit antialiased **bitmap** font (not outlines):

- a header with the font name, browser description strings, size metrics,
  and the file's own 4-digit code;
- a 192-entry glyph table indexed by character code (top row, advance width,
  data offset);
- run-length-encoded glyph rows with separate face and edge (border/shadow)
  layers;
- a pair-kerning table;
- a footer with a small "Aa" preview thumbnail.

The full byte-level spec is in [CLAUDE.md](CLAUDE.md).

## Tools

Requires Python 3 with Pillow, numpy and fontTools.

```sh
# inspect an original font
python3 tools/maxine_font.py info fonts/.0000
python3 tools/maxine_font.py glyph fonts/.0000 R          # ASCII-art one glyph
python3 tools/maxine_font.py render fonts/.3000 out.png   # specimen sheet (edge layer in red)
python3 tools/maxine_font.py kern fonts/.0000
python3 tools/maxine_font.py roundtrip fonts/.5000        # re-encode and compare

# convert a TTF
python3 tools/ttf2maxine.py "/path/to/Font.ttf" --scanlines 46 --code 9100 --out experiments --preview
python3 tools/ttf2maxine.py Font.ttf --scanlines 40 --code 9101 --edge border --lines 3 --out experiments
python3 tools/ttf2maxine.py Font.ttf --scanlines 30 --code 9102 --edge shadow --lines 4 --out experiments
```

The output is written as `.CODE` (the dotfile naming the device expects) and
`--preview` renders the finished file back through the decoder as a PNG so
you can see what the unit should display.

## Layout

- `fonts/` — the 36 original Machine Font files from the unit.
- `tools/` — reader/writer library and converter.
- `experiments/` — generated test fonts and the hardware test plan.
- `CLAUDE.md` — format specification, findings, open questions, history.

## Open questions

Only the hardware can answer these: whether converter output loads at all,
the meaning of two small per-glyph spacing-hint fields, the exact border
geometry, and whether a few header metrics affect on-screen layout. Details
in `CLAUDE.md`.
