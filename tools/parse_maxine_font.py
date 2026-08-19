#!/usr/bin/env python3
"""
Parser / dumper for the Chyron MAXINE font file format, as reverse-engineered
offline from static analysis of fonts/.0000 ("Swiss 721 Bold(TM)", no edge,
46 scanlines). See CLAUDE.md for the full narrative writeup and confidence
levels. NOTHING in this parser has been validated against real hardware yet
-- treat its output as a structural map, not proven-correct semantics.

Usage:
    python3 tools/parse_maxine_font.py fonts/.0000
    python3 tools/parse_maxine_font.py fonts/.0000 --dump-glyph 'A'
"""
import struct
import sys
import argparse


def be16(data, o):
    return struct.unpack_from('>H', data, o)[0]


def be32(data, o):
    return struct.unpack_from('>I', data, o)[0]


class MaxineFont:
    GLYPH_TABLE_OFFSET = 0x252
    GLYPH_TABLE_STRIDE = 10
    FIRST_CHAR = 33  # '!' -- confirmed for .0000; NOT yet confirmed constant
                      # across other files, check header fields if adapting.
    MAX_SLOTS = 90    # covers '!' (33) .. 'z' (122) for .0000

    def __init__(self, path):
        self.path = path
        self.data = open(path, 'rb').read()
        self._parse_header()
        self._parse_glyph_table()

    def _parse_header(self):
        d = self.data
        self.flags_a = be32(d, 0x00)          # 0x1f4=500 in .0000
        self.flags_b = be32(d, 0x04)          # 0xffffffff (no-edge) or
                                                # 0x00002816 (bordered) in samples so far
        self.name1 = d[0x08:0x44].split(b'\0')[0].decode('latin-1')
        desc_raw = d[0x44:0x84]
        desc_parts = desc_raw.split(b'\0')
        self.desc_line1 = desc_parts[0].decode('latin-1') if desc_parts else ''
        self.desc_line2 = desc_parts[1].decode('latin-1') if len(desc_parts) > 1 else ''
        self.name2 = d[0x88:0xc0].split(b'\0')[0].decode('latin-1')  # 4 zero bytes then name
        self.digit_code = d[0xce:0xd6].decode('latin-1')  # 8-digit ASCII code, meaning unknown
        self.scanlines = be16(d, 0xd6)
        self.first_char = be16(d, 0xd8)
        self.unk_0xda = be16(d, 0xda)     # unresolved third value (51 in .0000)
        self.metric_a = be32(d, 0xe6)     # 118760 in .0000
        self.metric_b = be32(d, 0xea)     # 115944 in .0000
        self.unk_0xee = be16(d, 0xee)     # 588 in .0000
        self.unk_0xf0 = be16(d, 0xf0)     # 38 in .0000
        self.unk_0xf8 = be16(d, 0xf8)     # 9 in .0000
        self.unk_0xfa = be16(d, 0xfa)     # 9 in .0000
        self.unk_0xfe = be16(d, 0xfe)     # 11 in .0000
        # 4-entry / 10-byte-each global metrics table at 0x100-0x12f.
        # Constant part (0x4200, 0x0000, 0xa411, 0x0000) + one increasing
        # BE16 per entry (0, 128, 224, 320 in .0000). Candidate: vertical
        # metric positions (ascender/cap-height/x-height/baseline?) in an
        # unknown fixed-point unit. UNCONFIRMED.
        self.global_metrics_table = []
        for i in range(4):
            o = 0x104 + i * 10
            vals = struct.unpack_from('>5H', d, o)
            self.global_metrics_table.append(vals)

    def _parse_glyph_table(self):
        d = self.data
        self.glyphs = {}  # char -> dict(defined, tag, flags, width_field, offset)
        o = self.GLYPH_TABLE_OFFSET
        for i in range(self.MAX_SLOTS):
            f0, f1, f2, f3, f4 = struct.unpack_from('>5H', d, o)
            ch = chr(self.FIRST_CHAR + i)
            defined = (f0, f1, f2, f3, f4) != (0, 0, 0, 0, 0)
            self.glyphs[ch] = {
                'defined': defined,
                'tag': f0,          # ~0x4200 constant; low byte sometimes
                                     # perturbed (+1/+6/+8/-5/-6) -- candidate
                                     # per-glyph signed adjustment, unconfirmed
                'flags': f1,        # 0, 0x10, 0x20, 0x420 seen -- candidate
                                     # flags bitfield, unconfirmed
                'width_field': f2,  # loosely correlates with visual width but
                                     # has many exact duplicates across
                                     # differently-shaped glyphs -- meaning
                                     # not fully pinned down
                'offset': (f3 << 16) | f4,  # BE32 cumulative offset from
                                             # bulk-data base, CONFIRMED
                                             # monotonic across all glyphs
            }
            o += self.GLYPH_TABLE_STRIDE

        # Bulk glyph data base address. Empirically the first nonzero byte
        # after the glyph table's trailing zero padding. For .0000 this is
        # 0x889. NOT yet confirmed to be computed from a header field rather
        # than simply "wherever the table's padding ends" -- may need
        # adjustment for files with different scanline counts / char ranges.
        o = self.GLYPH_TABLE_OFFSET + self.MAX_SLOTS * self.GLYPH_TABLE_STRIDE
        while o < len(d) and d[o] == 0:
            o += 1
        self.bulk_base = o

        # compute per-glyph byte size = delta to next defined glyph's offset
        defined_chars = [c for c, g in self.glyphs.items() if g['defined']]
        defined_chars.sort(key=lambda c: self.glyphs[c]['offset'])
        for idx, ch in enumerate(defined_chars):
            g = self.glyphs[ch]
            if idx + 1 < len(defined_chars):
                nxt = self.glyphs[defined_chars[idx + 1]]['offset']
                g['size'] = nxt - g['offset']
            else:
                g['size'] = None  # last glyph -- true end unknown, see
                                   # CLAUDE.md note on the ~7KB antialiased
                                   # tail region boundary (~0x1d000-0x1d400
                                   # in .0000, NOT a fixed formula yet)
            g['file_offset'] = self.bulk_base + g['offset']

    def glyph_bytes(self, ch):
        g = self.glyphs.get(ch)
        if not g or not g['defined']:
            return b''
        start = g['file_offset']
        if g['size'] is None:
            return self.data[start:]  # unknown true end
        return self.data[start:start + g['size']]

    def row_count(self, ch):
        """Count of '01 00 03 00' end-of-row terminator records within a
        glyph's byte range. Candidate proxy for 'number of scanlines with
        ink', which lines up well with x-height vs full-height letters.
        UNCONFIRMED against hardware."""
        return self.glyph_bytes(ch).count(b'\x01\x00\x03\x00')

    def summary(self):
        lines = []
        lines.append(f"file: {self.path}  ({len(self.data)} bytes)")
        lines.append(f"name: {self.name1!r}")
        lines.append(f"description: {self.desc_line1!r} / {self.desc_line2!r}")
        lines.append(f"scanlines={self.scanlines} first_char={self.first_char!r} "
                      f"unk_0xda={self.unk_0xda}")
        lines.append(f"metric_a={self.metric_a} metric_b={self.metric_b} "
                      f"unk_0xee={self.unk_0xee} unk_0xf0={self.unk_0xf0} "
                      f"unk_0xf8={self.unk_0xf8} unk_0xfa={self.unk_0xfa} "
                      f"unk_0xfe={self.unk_0xfe}")
        lines.append(f"bulk data base: {hex(self.bulk_base)}")
        defined = [c for c, g in self.glyphs.items() if g['defined']]
        blank = [c for c, g in self.glyphs.items() if not g['defined']]
        lines.append(f"defined glyphs ({len(defined)}): {''.join(defined)}")
        lines.append(f"blank slots ({len(blank)}): {''.join(blank)!r}")
        return '\n'.join(lines)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('font_path')
    ap.add_argument('--dump-glyph', help='print hex + row count for one character')
    args = ap.parse_args()

    font = MaxineFont(args.font_path)
    print(font.summary())

    if args.dump_glyph:
        ch = args.dump_glyph
        g = font.glyphs.get(ch)
        if not g or not g['defined']:
            print(f"\n{ch!r} is not defined in this font")
            return
        b = font.glyph_bytes(ch)
        print(f"\nglyph {ch!r}: file_offset={hex(g['file_offset'])} size={g['size']} "
              f"width_field={g['width_field']} tag={hex(g['tag'])} flags={g['flags']} "
              f"row_terminators={font.row_count(ch)}")
        for off in range(0, len(b), 16):
            chunk = b[off:off + 16]
            hexs = ' '.join(f'{x:02x}' for x in chunk)
            print(f'  +{off:04x}  {hexs}')


if __name__ == '__main__':
    main()
