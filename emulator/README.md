# MAXINE! emulator

A MAME driver for the Chyron MAXINE!. It boots the archived 11.01 disk image into Message Compose
on a stub boot: the real Program Loader and Message Compose, fonts from disk, typing, colours, and
messages saved to and read from disk. Hardware notes are in `docs/hardware-map.md`.

The window shows two of the machine's four outputs: **Prompts**, the UI, on the left, and **Color
Edit**, the text with its cursor and safe title overlays, on the right. Below them is a clickable
panel with the MAXINE keys that have no obvious host key. On a Mac, Export > Video and Key in the menu
bar, or Command-E, asks for a folder and saves the clean **Video** and **Key** outputs there at the next
free number, as a pair of native 720x486 PNGs and a `-square` pair at 648x486 for square-pixel tools.
Right Ctrl saves the same files to `emulator/run/snap/maxine/`. Color Edit is shown in its true shape,
with NTSC pixels 0.9 as wide as tall.

The driver is an overlay on a pinned MAME commit. `build.sh` clones MAME into `emulator/mame/`,
copies `src/mame/chyron/` into it and builds a binary holding just this driver, plus `chdman`.

```bash
emulator/build.sh
```

Needs Xcode command line tools, Python 3 and SDL2 (`brew install sdl2`). The first build takes a
long time; later ones only rebuild the driver.

## Disk image

Two images are in this repo for preservation, both read-only. `emulator/roms/maxine-v11.01.chd` is the
clean 11.01 image from [archive.org](https://archive.org/details/maxine-v10v11).
`emulator/roms/maxine-default.chd` is the same disk with software options enabled, plus some test
messages, and it's what the emulator starts from. To rebuild the clean image from
`maxine-v11.01.zip`:

```bash
cd emulator/roms
unzip maxine-v11.01.zip
../mame/chdman createhd -i maxine-v11.01.img -o maxine-v11.01.chd -c none -ss 512
```

## Running

```bash
emulator/run.sh               # window
emulator/run.sh -debug        # with the MAME debugger
```

Keys: Return is NEW LINE, Backspace BACKSPACE, Left Ctrl CNTL, Left Alt ALT, Esc ESC, Delete ERASE
(which clears the whole message), Home HOME, Page Up
READ, Page Down CHNG, End READ NEXT, Insert XFER, F1–F10, F11 CRAWL, F12 ROLL, arrows CURSOR, numeric
keypad KEYPAD. Scroll Lock or Fn+Delete switches between emulated keys and MAME's own. Command isn't
bound to a MAXINE key, and Command-V types the host clipboard in as plain ASCII with new lines kept.

The mouse is never captured. Over Prompts the host pointer is hidden, the firmware's arrow follows it,
and the buttons click there. The arrow can't reach the outermost 15–25 pixels of Prompts. It re-syncs
by running to the top left corner and back when the pointer re-enters Prompts or the app regains focus.
The panel's three SHIFT keys stay latched until clicked again, and apply to the arrow keys meanwhile.
Holding the host's Shift as well moves further. The panel's MOUSE/TABLET switch turns the host pointer
into a WACOM SD510C pen for Logo Compose and stops the mouse. Left and right click are buttons 1 and 2.
Button 2 flips Logo Compose between the crosshair on Color Edit and the arrow on Prompts, and the pen
lines up with whichever is in use while the pointer is over that screen. To draw an outline over Color
Edit: press O, Return, Right arrow and Return to accept the colour, P at each point, then O to close it. It needs that tablet chosen in the Loader's Setup, under Tablet Type. MODE SLCT opens the Exit Mode menu, which leads back to
the Program Loader. MIX and SLOW REVL aren't on the panel.

To get going: press a key at the Serial Ports warning, click Message Compose, press Left Ctrl then F,
then Return, Q, Left Ctrl twice, and type.

```bash
emulator/tests/run-test.sh    # headless: boots and checks the Loader drew its title bar
```

The firmware writes to its disk, so `run.sh` runs on a copy at `emulator/run/disk.chd`. Delete that file to go back to the starting image: `emulator/roms/maxine-default.chd` if it exists, otherwise the archive image. To change the default, copy a stopped `run/disk.chd` over it.

`artwork/make_layout.py` generates the window layout and `src/mame/chyron/maxine_keys.h` from one key
list. Rerun it after changing a key, and run `build.sh` as well if a key's name, code or host key changed.

There's no boot PROM dump, so the driver loads `/SYSTEM/PROGRAMS/PSOS` itself and starts it, and
NVRAM defaults to zeros plus the SCSI entry the disk needs.

## Known gaps

- Roll and crawl: the firmware reaches its Roll Execution screen, but nothing has played out.
- The edge colour is a guess at the palette's 50% entry. The Prompts palette is a gray guess.
- VMEchip2 is a register store apart from its interrupt enables and levels.
- 82596 frame data has the wrong byte order, so networking won't work yet.
- The clock reads 12:xx 0/0/00 in the hour after midnight, and the year read 06 for 26. The RTC bytes
  are right, so this needs tracing.
- The CPU runs at 50 MHz, because MAME's cycle counts are well above a real 68040's. That's a guess.
- The site ID is `$2192`, the one the archive image's licensed files carry.
