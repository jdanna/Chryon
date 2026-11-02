#!/usr/bin/env python3
"""
Generates the window layout and the matching key table, so the clickable panel and the driver
can't disagree. Writes artwork/maxine/default.lay and src/mame/chyron/maxine_keys.h.

Each key: name lines, MAXINE key code, host keys separated by spaces or None, and where it sits on the panel in
(cluster, column, row[, width, height]) or None if it has no panel key. The panel has the keys
with no obvious host key, in a compact arrangement of the real keyboard's blocks.
"""
from pathlib import Path
from xml.sax.saxutils import escape

HERE = Path(__file__).resolve().parent

SHIFT_CHAR, SHIFT_PAGE, SHIFT_ROW, POINTER_SWITCH = 0x100, 0x101, 0x102, 0x103

KEYS = [
    # Mode
    (("MODE", "SLCT"), 0xff, None, ("mode", 0, 0)),
    (("ESC",), 0xfe, None, ("mode", 0, 1)),
    *[((str(i + 1),), 0xa0 + i, None, ("font", i, 0)) for i in range(8)],
    (("RED",), 0xa8, None, ("font", 0, 1)),
    (("MGTA",), 0xa9, None, ("font", 1, 1)),
    (("BLUE",), 0xaa, None, ("font", 2, 1)),
    (("CYAN",), 0xab, None, ("font", 3, 1)),
    (("YEL",), 0xac, None, ("font", 4, 1)),
    (("GRN",), 0xad, None, ("font", 5, 1)),
    (("WHT",), 0xae, None, ("font", 6, 1)),
    (("BLCK",), 0xaf, None, ("font", 7, 1)),
    (("DEL", "ROW"), 0xda, None, ("edit", 0, 0)),
    (("INS", "ROW"), 0xdb, None, ("edit", 1, 0)),
    (("CNTR", "ROW"), 0xdc, None, ("edit", 2, 0)),
    (("DEL", "CHAR"), 0xdd, None, ("edit", 0, 1)),
    (("INS", "CHAR"), 0xde, None, ("edit", 1, 1)),
    (("CNTR", "PAGE"), 0xdf, None, ("edit", 2, 1)),
    (("ERASE",), 0xcd, "DEL", ("edit", 0, 2)),
    (("DEL", "MSG"), 0xf0, None, ("edit", 1, 2)),
    (("RCD",), 0xf1, "PLUS_PAD", ("keypad", 3, 2)),
    # Function block
    (("F1",), 0xd0, "F1", ("font", 0, 2)),
    (("F2",), 0xd1, "F2", ("font", 1, 2)),
    (("F3",), 0xd2, "F3", ("font", 2, 2)),
    (("F4",), 0xd3, "F4", ("font", 3, 2)),
    (("F5",), 0xd4, "F5", ("font", 4, 2)),
    (("CNVRT",), 0xd6, None, ("font", 0, 3)),
    (("CRAWL",), 0xd8, "F11", ("font", 1, 3)),
    (("ROLL",), 0xd9, "F12", ("font", 2, 3)),
    (("SET-UP",), 0xea, None, ("font", 3, 3)),
    (("MIX",), 0xe9, None, None),
    # Cursor block
    (("HOME",), 0xcb, "HOME", ("font", 5, 2)),
    (("COLOR", "FONT"), 0xcc, None, ("font", 7, 2)),
    (("CURSOR", "UP"), 0x8f, "UP", None),
    (("CURSOR", "LEFT"), 0x8c, "LEFT", None),
    (("CURSOR", "RIGHT"), 0x8d, "RIGHT", None),
    (("CURSOR", "DOWN"), 0x8e, "DOWN", None),
    (("SHIFT", "CHAR"), SHIFT_CHAR, None, ("font", 5, 3)),
    (("SHIFT", "PAGE"), SHIFT_PAGE, None, ("font", 6, 3)),
    (("SHIFT", "ROW"), SHIFT_ROW, None, ("font", 7, 3)),
    # Keypad
    (("CNTL",), 0xd5, "LCONTROL", ("edit", 0, 3)),
    (("XFER",), 0xf9, "INSERT", ("edit", 1, 3)),
    (("CHNG",), 0xf7, "PGDN", ("edit", 2, 3)),
    (("SLOW", "REVL"), 0xf5, None, None),
    (("7",), 0xc7, "7_PAD", ("keypad", 0, 0)),
    (("8",), 0xc8, "8_PAD", ("keypad", 1, 0)),
    (("9",), 0xc9, "9_PAD", ("keypad", 2, 0)),
    (("DO",), 0xf3, None, ("keypad", 3, 0)),
    (("4",), 0xc4, "4_PAD", ("keypad", 0, 1)),
    (("5",), 0xc5, "5_PAD", ("keypad", 1, 1)),
    (("6",), 0xc6, "6_PAD", ("keypad", 2, 1)),
    (("READ", "NEXT"), 0xf6, "END", ("keypad", 3, 1)),
    (("1",), 0xc1, "1_PAD", ("keypad", 0, 2)),
    (("2",), 0xc2, "2_PAD", ("keypad", 1, 2)),
    (("3",), 0xc3, "3_PAD", ("keypad", 2, 2)),
    (("READ",), 0xf8, "PGUP ENTER_PAD", ("keypad", 3, 3)),
    (("0",), 0xc0, "0_PAD", ("keypad", 0, 3, 2, 1)),
    (("CLR",), 0xca, None, ("keypad", 2, 3)),
    # On the host keyboard only
    (("ALT",), 0xcf, "LALT", None),
    *[((f"F{i + 6}",), 0xe0 + i, f"F{i + 6}", None) for i in range(5)],
    # Emulator only: what the host pointer drives
    (("MOUSE",), POINTER_SWITCH, None, ("mode", 0, 2)),
]

assert len(KEYS) <= 96

# Screens, in layout units. Both are as tall as each other and show the visible areas in maxine.cpp
# in their true shape: Prompts has square pixels, and Color Edit's 720x486 are 0.9 as wide as tall.
PROMPTS_W, EDIT_W, SCREEN_H, GAP = 520, 603, 452, 8
WIDTH = PROMPTS_W + GAP + EDIT_W
KEY_W, KEY_H, PITCH_X, PITCH_Y = 52, 30, 56, 33
PANEL_Y = SCREEN_H + GAP
PANEL_H = 4 * PITCH_Y + 7
HEIGHT = PANEL_Y + PANEL_H

PANEL_LEFT = (WIDTH - 1024) // 2
CLUSTERS = {
    "mode": (PANEL_LEFT, PANEL_Y + 5),
    "font": (PANEL_LEFT + 80, PANEL_Y + 5),
    "edit": (PANEL_LEFT + 556, PANEL_Y + 5),
    "keypad": (PANEL_LEFT + 804, PANEL_Y + 5),
}


def text(string, x, y, w, h, color):
    return (f'<text string="{escape(string)}"><bounds x="{x}" y="{y}" width="{w}" height="{h}"/>'
            f'<color {color}/></text>')


def key_element(index, lines, tall, lit_name=None):
    ink = 'red="0.93" green="0.93" blue="0.9"'
    parts = [f'<element name="key{index}">',
             '<rect state="0"><color red="0.3" green="0.3" blue="0.32"/></rect>',
             '<rect state="1"><color red="0.75" green="0.6" blue="0.2"/></rect>']
    if lit_name:
        parts.append(text(lines[0], 0.08, 0.28, 0.84, 0.44, ink).replace('<text ', '<text state="0" '))
        parts.append(text(lit_name, 0.08, 0.28, 0.84, 0.44, ink).replace('<text ', '<text state="1" '))
    elif len(lines) == 1 and tall:
        parts.append(text(lines[0], 0.08, 0.38, 0.84, 0.24, ink))
    elif len(lines) == 1:
        parts.append(text(lines[0], 0.08, 0.28, 0.84, 0.44, ink))
    else:
        parts.append(text(lines[0], 0.08, 0.1, 0.84, 0.38, ink))
        parts.append(text(lines[1], 0.08, 0.52, 0.84, 0.38, ink))
    parts.append('</element>')
    return ''.join(parts)


def layout():
    out = ['<?xml version="1.0"?>', '<!-- Generated by make_layout.py -->', '<mamelayout version="2">']
    out.append('<element name="panel"><rect><color red="0.15" green="0.15" blue="0.16"/></rect></element>')
    items = []
    for index, (lines, code, host, place) in enumerate(KEYS):
        if place is None:
            continue
        out.append(key_element(index, lines, len(place) > 3 and place[4] > 1,
                               "TABLET" if code == POINTER_SWITCH else None))
        cluster, column, row = place[:3]
        wide, tall = (place[3], place[4]) if len(place) > 3 else (1, 1)
        x0, y0 = CLUSTERS[cluster]
        port, mask = f'PANEL{index // 32}', 1 << (index % 32)
        name = f' name="shift{code - SHIFT_CHAR}"' if code >= 0x100 else ''  # shift3 is the switch
        items.append(f'<element ref="key{index}"{name} inputtag="{port}" inputmask="0x{mask:08x}">'
                     f'<bounds x="{x0 + column * PITCH_X}" y="{y0 + row * PITCH_Y}" '
                     f'width="{KEY_W + (wide - 1) * PITCH_X}" height="{KEY_H + (tall - 1) * PITCH_Y}"/></element>')
    out.append(f'<view name="MAXINE" showpointers="no"><bounds x="0" y="0" width="{WIDTH}" height="{HEIGHT}"/>')
    out.append(f'<screen id="prompts" index="0"><bounds x="0" y="0" width="{PROMPTS_W}" height="{SCREEN_H}"/></screen>')
    out.append(f'<screen id="edit" index="1"><bounds x="{PROMPTS_W + GAP}" y="0" width="{EDIT_W}" height="{SCREEN_H}"/></screen>')
    out.append(f'<element ref="panel"><bounds x="0" y="{PANEL_Y}" width="{WIDTH}" height="{PANEL_H}"/></element>')
    out.extend(items)
    out.append('</view>')
    out.append(SCRIPT)
    out.append('</mamelayout>')
    return '\n'.join(out) + '\n'


# The host pointer drives the firmware's arrow over Prompts, or the tablet over Color Edit. Coordinates
# over Prompts are its visible area in maxine.cpp, and over Color Edit are raster pixels with bit 30 set.
SCRIPT = '''<script><![CDATA[
local LEFT, TOP, WIDTH, HEIGHT = 92, 20, 520, 452
local EDIT_WIDTH, EDIT_HEIGHT, EDIT_FLAG = 720, 486, 0x40000000
local POINTER_PORT, NO_POINTER = 0x8210400c, 0xffffffff

file:set_resolve_tags_callback(function()
	local view = file.views["MAXINE"]
	local memory = machine.devices[":maincpu"].spaces["program"]
	local screen = view.items["prompts"]
	local edit = view.items["edit"]

	view:set_pointer_updated_callback(function(kind, id, device, x, y, buttons)
		local bounds = screen.bounds
		local u = (x - bounds.x0) / (bounds.x1 - bounds.x0)
		local v = (y - bounds.y0) / (bounds.y1 - bounds.y0)
		local e = edit.bounds
		local eu = (x - e.x0) / (e.x1 - e.x0)
		local ev = (y - e.y0) / (e.y1 - e.y0)
		if u >= 0 and u < 1 and v >= 0 and v < 1 then
			local px = LEFT + math.floor(u * WIDTH)
			local py = TOP + math.floor(v * HEIGHT)
			memory:write_u32(POINTER_PORT, (px << 16) | ((buttons & 3) << 12) | py)
		elseif eu >= 0 and eu < 1 and ev >= 0 and ev < 1 then
			local ex = math.floor(eu * EDIT_WIDTH)
			local ey = math.floor(ev * EDIT_HEIGHT)
			memory:write_u32(POINTER_PORT, EDIT_FLAG | (ex << 16) | ((buttons & 3) << 12) | ey)
		else
			memory:write_u32(POINTER_PORT, NO_POINTER)
		end
	end)
	view:set_pointer_left_callback(function()
		memory:write_u32(POINTER_PORT, NO_POINTER)
	end)
end)
]]></script>'''


def key_table():
    # Lua and the input menu both go by name, so the digit keys need telling apart
    def label(name, code):
        name = ' '.join(name)
        if name.isdigit():
            return f'FNT SEL {name}' if code < 0xc0 else f'KEYPAD {name}'
        return name

    # IPT_OTHER, because MAME locks out every keyboard but one and generic_keyboard is the one kept
    lines = ['// Generated by artwork/make_layout.py', '', '#ifndef MAME_CHYRON_MAXINE_KEYS_H',
             '#define MAME_CHYRON_MAXINE_KEYS_H', '', '#pragma once', '',
             '// MAXINE key code for each bit of PANEL0 to PANEL2. $100 up are the shift keys, then the mouse/tablet switch.',
             'static constexpr uint16_t PANEL_KEYS[] = {']
    for lines_, code, host, place in KEYS:
        lines.append(f'\t0x{code:03x}, // {" ".join(lines_)}')
    lines.append('};')
    lines.append('')
    for port in range(3):
        lines.append(f'#define MAXINE_PANEL{port}_BITS \\')
        for index, (name, code, host, place) in enumerate(KEYS):
            if index // 32 != port:
                continue
            code_part = ''.join(f' PORT_CODE(KEYCODE_{key})' for key in (host or '').split())
            lines.append(f'\tPORT_BIT(1U << {index % 32}, IP_ACTIVE_HIGH, IPT_OTHER) PORT_NAME("{label(name, code)}"){code_part} \\')
        lines.append('')
    lines.append('#endif // MAME_CHYRON_MAXINE_KEYS_H')
    return '\n'.join(lines) + '\n'


(HERE / 'maxine' / 'default.lay').write_text(layout(), encoding='utf-8')
(HERE.parent / 'src' / 'mame' / 'chyron' / 'maxine_keys.h').write_text(key_table())
print(f'{len(KEYS)} keys, view {WIDTH}x{HEIGHT}')
