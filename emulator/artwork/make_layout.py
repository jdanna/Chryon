#!/usr/bin/env python3
"""
Generates the window layout and the matching key table, so the clickable panel and the driver
can't disagree. Writes artwork/maxine/default.lay and src/mame/chyron/maxine_keys.h.

Each key: name lines, MAXINE key code, host keys separated by spaces or None, and where it sits on the panel in
(cluster, column, row[, width, height]) or None if it has no panel key. The panel's right side is laid out like a
PC keyboard's, with each key where its host key is, so the two are easy to match by position.
"""
from pathlib import Path
from xml.sax.saxutils import escape

HERE = Path(__file__).resolve().parent

SHIFT_CHAR, SHIFT_PAGE, SHIFT_ROW, POINTER_SWITCH, EXPORT_NATIVE, EXPORT_SQUARE, SECOND_SCREEN = range(0x100, 0x107)

KEYS = [
    # Mode
    (("MODE", "SLCT"), 0xff, None, ("main", 0, 3, 2, 1)),
    (("ESC",), 0xfe, None, ("main", 0, 4, 2, 1)),
    *[((str(i + 1),), 0xa0 + i, None, ("main", i, 0)) for i in range(8)],
    (("RED",), 0xa8, None, ("main", 0, 1)),
    (("MGTA",), 0xa9, None, ("main", 1, 1)),
    (("BLUE",), 0xaa, None, ("main", 2, 1)),
    (("CYAN",), 0xab, None, ("main", 3, 1)),
    (("YEL",), 0xac, None, ("main", 4, 1)),
    (("GRN",), 0xad, None, ("main", 5, 1)),
    (("WHT",), 0xae, None, ("main", 6, 1)),
    (("BLCK",), 0xaf, None, ("main", 7, 1)),
    (("DEL", "ROW"), 0xda, "PRTSCR", ("nav", 0, 0)),
    (("INS", "ROW"), 0xdb, "SCRLOCK", ("nav", 1, 0)),
    (("CNTR", "ROW"), 0xdc, "PAUSE", ("nav", 2, 0)),
    (("DEL", "CHAR"), 0xdd, "INSERT", ("nav", 0, 1)),
    (("INS", "CHAR"), 0xde, "HOME", ("nav", 1, 1)),
    (("CNTR", "PAGE"), 0xdf, "PGUP", ("nav", 2, 1)),
    (("ERASE",), 0xcd, None, ("main", 4, 4, 2, 1)),
    (("DEL", "MSG"), 0xf0, "ASTERISK", ("keypad", 2, 0)),
    (("RCD",), 0xf1, "MINUS_PAD", ("keypad", 3, 0)),
    # Function block
    (("F1",), 0xd0, "F1", ("function", 0, 0)),
    (("F2",), 0xd1, "F2", ("function", 0, 1)),
    (("F3",), 0xd2, "F3", ("function", 0, 2)),
    (("F4",), 0xd3, "F4", ("function", 0, 3)),
    (("F5",), 0xd4, "F5", ("function", 0, 4)),
    (("CNVRT",), 0xd6, None, ("function", 1, 0)),
    (("CRAWL",), 0xd8, "F11", ("function", 1, 1)),
    (("ROLL",), 0xd9, "F12", ("function", 1, 2)),
    (("SET-UP",), 0xea, None, ("function", 1, 3)),
    (("MIX",), 0xe9, None, ("function", 1, 4)),
    # Cursor block
    (("HOME",), 0xcb, None, ("main", 4, 3, 2, 1)),
    (("COLOR", "FONT"), 0xcc, None, ("main", 2, 4, 2, 1)),
    (("CURSOR", "UP"), 0x8f, "UP", ("nav", 1, 3)),
    (("CURSOR", "LEFT"), 0x8c, "LEFT", ("nav", 0, 4)),
    (("CURSOR", "RIGHT"), 0x8d, "RIGHT", ("nav", 2, 4)),
    (("CURSOR", "DOWN"), 0x8e, "DOWN", ("nav", 1, 4)),
    # The host's keys for these are in HOSTHOLD in maxine.cpp, because they're held and these latch
    (("SHIFT", "CHAR"), SHIFT_CHAR, None, ("nav", 0, 2)),
    (("SHIFT", "PAGE"), SHIFT_PAGE, None, ("nav", 1, 2)),
    (("SHIFT", "ROW"), SHIFT_ROW, None, ("nav", 2, 2)),
    # Keypad
    (("CNTL",), 0xd5, "LCONTROL", ("main", 6, 4, 2, 1)),
    (("XFER",), 0xf9, None, ("main", 6, 3, 2, 1)),
    (("CHNG",), 0xf7, None, None),
    (("SLOW", "REVL"), 0xf5, None, None),
    (("7",), 0xc7, "7_PAD", ("keypad", 0, 1)),
    (("8",), 0xc8, "8_PAD", ("keypad", 1, 1)),
    (("9",), 0xc9, "9_PAD", ("keypad", 2, 1)),
    (("DO",), 0xf3, None, None),
    (("4",), 0xc4, "4_PAD", ("keypad", 0, 2)),
    (("5",), 0xc5, "5_PAD", ("keypad", 1, 2)),
    (("6",), 0xc6, "6_PAD", ("keypad", 2, 2)),
    (("READ", "NEXT"), 0xf6, "PLUS_PAD", ("keypad", 3, 1, 1, 2)),
    (("1",), 0xc1, "1_PAD", ("keypad", 0, 3)),
    (("2",), 0xc2, "2_PAD", ("keypad", 1, 3)),
    (("3",), 0xc3, "3_PAD", ("keypad", 2, 3)),
    (("READ",), 0xf8, "ENTER_PAD", ("keypad", 3, 3, 1, 2)),
    (("0",), 0xc0, "0_PAD", ("keypad", 0, 4, 2, 1)),
    (("CLR",), 0xca, "DEL_PAD", ("keypad", 2, 4)),
    # On the host keyboard only
    (("ALT",), 0xcf, "LALT", None),
    *[((f"F{i + 6}",), 0xe0 + i, f"F{i + 6}", None) for i in range(5)],
    # Emulator only: what the host pointer drives
    (("MOUSE",), POINTER_SWITCH, None, ("export", 0, 4)),
    # Added at the end so the indices above stay put. Tab from the host arrives through host_key.
    (("TAB",), 0xe5, None, ("main", 2, 3, 2, 1)),
    (("BUILD",), 0xf2, "SLASH_PAD", ("keypad", 1, 0)),
    # Emulator only: for Linux and Windows, which have no Export menu
    (("EXPORT", "NATIVE"), EXPORT_NATIVE, None, ("export", 0, 0, 1, 2)),
    (("EXPORT", "SQUARE", "PIXEL"), EXPORT_SQUARE, None, ("export", 0, 2, 1, 2)),
    # Emulator only: what the second screen shows. The driver's second_screen output picks the label.
    (("SECOND", "SCREEN"), SECOND_SCREEN, "NUMLOCK", ("keypad", 0, 0)),
]

assert len(KEYS) <= 96

# Screens, in layout units. Both are as tall as each other and show the visible areas in maxine.cpp
# in their true shape: Prompts has square pixels, and Color Edit's 720x486 are 0.9 as wide as tall.
PROMPTS_W, EDIT_W, SCREEN_H, GAP = 520, 603, 452, 8
WIDTH = PROMPTS_W + GAP + EDIT_W
KEY_W, KEY_H, PITCH_X, PITCH_Y = 52, 30, 56, 33
PANEL_Y = SCREEN_H + GAP
PANEL_H = 5 * PITCH_Y + 7
HEIGHT = PANEL_Y + PANEL_H

# Clusters from left to right, with their widths in keys, spaced to fill the panel
CLUSTER_WIDTHS = {"function": 2, "main": 8, "nav": 3, "keypad": 4, "export": 1}
CLUSTER_GAP = 30
CLUSTERS = {}
_x = (WIDTH - sum(columns * PITCH_X - (PITCH_X - KEY_W) for columns in CLUSTER_WIDTHS.values())
      - CLUSTER_GAP * (len(CLUSTER_WIDTHS) - 1)) // 2
for _name, _columns in CLUSTER_WIDTHS.items():
    CLUSTERS[_name] = (_x, PANEL_Y + 5)
    _x += _columns * PITCH_X - (PITCH_X - KEY_W) + CLUSTER_GAP


# Keys whose label follows an output, by the output's value
STATE_LABELS = {POINTER_SWITCH: [("MOUSE",), ("TABLET",)], SECOND_SCREEN: [("COLOR", "EDIT"), ("VIDEO",), ("KEY",)]}

# Degrees to turn the arrow, which points right, on the cursor keys. They're shapes, not text, because layout text
# uses each system's own font and not all of them have arrows.
ARROWS = {0x8f: 270, 0x8c: 180, 0x8d: 0, 0x8e: 90}


def arrow(degrees):
    return (f'<image><bounds x="0" y="0" width="1" height="1"/><data><![CDATA['
            f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {KEY_W} {KEY_H}">'
            f'<path fill="#eeeee6" transform="rotate({degrees} {KEY_W / 2} {KEY_H / 2})" '
            f'd="M16 13h11V7l10 8-10 8v-6H16z"/></svg>]]></data></image>')


def text(string, x, y, w, h, color):
    return (f'<text string="{escape(string)}"><bounds x="{x}" y="{y}" width="{w}" height="{h}"/>'
            f'<color {color}/></text>')


def key_text(lines, tall):
    ink = 'red="0.93" green="0.93" blue="0.9"'
    if len(lines) == 1 and tall:
        return [text(lines[0], 0.08, 0.38, 0.84, 0.24, ink)]
    if len(lines) == 1:
        return [text(lines[0], 0.08, 0.28, 0.84, 0.44, ink)]
    if tall:
        top = 0.5 - 0.12 * len(lines)
        return [text(line, 0.08, top + row * 0.24, 0.84, 0.24, ink) for row, line in enumerate(lines)]
    return [text(lines[0], 0.08, 0.1, 0.84, 0.38, ink), text(lines[1], 0.08, 0.52, 0.84, 0.38, ink)]


def key_element(index, lines, tall, states=None, degrees=None):
    """states is a label for each value of the key's output. Only the first is unlit."""
    parts = [f'<element name="key{index}">', '<rect state="0"><color red="0.3" green="0.3" blue="0.32"/></rect>']
    parts += [f'<rect state="{state}"><color red="0.75" green="0.6" blue="0.2"/></rect>'
              for state in range(1, len(states) if states else 2)]
    if degrees is not None:
        parts.append(arrow(degrees))
    elif states:
        for state, label in enumerate(states):
            parts += [part.replace('<text ', f'<text state="{state}" ') for part in key_text(label, tall)]
    else:
        parts += key_text(lines, tall)
    parts.append('</element>')
    return ''.join(parts)


def layout():
    out = ['<?xml version="1.0"?>', '<!-- Generated by make_layout.py -->', '<mamelayout version="2">']
    out.append('<element name="panel"><rect><color red="0.15" green="0.15" blue="0.16"/></rect></element>')
    items = []
    for index, (lines, code, host, place) in enumerate(KEYS):
        if place is None:
            continue
        out.append(key_element(index, lines, len(place) > 3 and place[4] > 1, STATE_LABELS.get(code), ARROWS.get(code)))
        cluster, column, row = place[:3]
        wide, tall = (place[3], place[4]) if len(place) > 3 else (1, 1)
        x0, y0 = CLUSTERS[cluster]
        port, mask = f'PANEL{index // 32}', 1 << (index % 32)
        name = f' name="shift{code - SHIFT_CHAR}"' if SHIFT_CHAR <= code <= POINTER_SWITCH else ''  # shift3 is the switch
        name = ' name="second_screen"' if code == SECOND_SCREEN else name
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


# The host pointer drives the firmware's arrow over Prompts, or its crosshair or the tablet over Color Edit. Coordinates
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
             '// MAXINE key code for each bit of PANEL0 to PANEL2. $100 up are the shift keys, the mouse/tablet switch, the export buttons, then the second screen key.',
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
