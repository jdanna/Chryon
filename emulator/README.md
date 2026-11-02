# MAXINE! Studio Emulator

![The emulator running Message Compose](../docs/emulator.png)

A MAME driver that runs the Chyron MAXINE! 11.01 software. Prompts is on the left, Color Edit on the
right, and a clickable panel of MAXINE! keys is below them.

## Functionality

- Runs from the original disk
- Message compose and other built-in apps fully work.
- Exports Fill and Key as PNGs.
- Emulates a mouse and a WACOM SD510C tablet.
- Includes 64 MB of expansion RAM.

## Instructions

The Emulator tab in MAXINE! Studio is the easy way to run it, on a Mac or Linux. Everything below is for running
it from a checkout. In the app, the saved image, NVRAM and exports are in the folder shown under Saved image
location, and Start network asks for your password instead of using `sudo`. On Linux, that needs polkit.

On a Mac, it needs Xcode command line tools, Python 3 and SDL2 (`brew install sdl2`). On Ubuntu, it needs
`sudo apt install libsdl2-dev libsdl2-ttf-dev libasound2-dev libpcap-dev`. The first build takes a long time.

```bash
emulator/build.sh
emulator/run.sh
```

The firmware runs on `emulator/run/disk.chd`, copied from `roms/maxine-default.chd` on first launch, so
your work is kept. Delete that file to start over. The default has software options enabled, and
`roms/maxine-v11.01.chd` is the clean [archive.org](https://archive.org/details/maxine-v10v11) image.

### Keys

| Host | MAXINE |
|---|---|
| Return | NEW LINE |
| Backspace | BACKSPACE |
| Tab | TAB |
| Left Ctrl | CNTL |
| Left Alt | ALT |
| Esc | ESC |
| Arrows | CURSOR |
| Hold Insert, Home, Page Up | SHIFT ROW, CHAR, PAGE |
| Page Down | XFER |
| Numpad − | READ NEXT |
| Numpad Enter | READ |
| Numpad + | RCD |
| Numpad * | DEL MSG |
| Numpad . | CLR |
| F1–F10 | F1–F10 |
| F11, F12 | CRAWL, ROLL |
| Numeric keypad | KEYPAD |
| Fn+Delete | ERASE, which clears the whole message |

Everything else is on the panel. Its SHIFT keys stay latched until clicked again and apply to the arrow keys.
Holding the host's Shift as well moves further. MODE SLCT opens the menu that exits to the Loader.

Command-V pastes the clipboard as plain ASCII.

### Mouse

The mouse isn't captured. Over Prompts, the firmware's arrow follows your pointer and the buttons click
there. It re-syncs when the pointer re-enters Prompts or the app regains focus.

### Tablet

A new machine is set up for the WACOM SD510C. If you've changed it, choose it again under Tablet Type in the
Loader's Setup. Click MOUSE on the panel to switch to TABLET. It only works in Logo Compose. Left and right click
are buttons 1 and 2. Button 2 flips between the crosshair on Color Edit and the arrow on Prompts, so keep your
pointer over the screen in use.

To draw an outline over Color Edit, press O, Return, Right arrow, Return, then P at each point and O to
close it. Press `?` in Logo Compose for the other keys.

### Network

Run this once after each reboot, on a Mac or Linux. It needs your password.

```bash
sudo emulator/net-up.sh
```

It creates a virtual Ethernet link and gives your computer 10.37.0.1. `sudo emulator/net-down.sh` removes it. Start the emulator and the MAXINE is at
10.37.0.2. Its disk needs the Networking option, which the default disk has. Change the MAXINE's address in
the Loader's Setup, under Network, then Save Values. The address is kept in `/SYSTEM/ETC/NET_CONF` on the disk.

On Linux, the link is a TAP device called `tap-mess-<your user ID>-0`, so run the emulator as the user who ran
the script, not as root.

To check it, wait for the Loader, then run `ping 10.37.0.2`. FTP starts a few seconds after ping does.

FTP takes any login and works in active mode only, as on the real unit. Fonts are in `/MAXINE/MACHINE`. In
active mode the MAXINE connects back to your computer, so a firewall has to allow that. If logging in works but
listing a folder hangs, that's the likely cause. With ufw on Linux:

```bash
sudo ufw allow in on tap-mess-$(id -u)-0
```

The default disk has a `/SYSTEM/ETC/TELNETD.CFG` that allows telnet from 10.37.0.1, as user and password `chyron`.
Telnet starts a few seconds after FTP. A disk that doesn't have that file closes the connection straight away, so
that's what `maxine-v11.01.chd` does, and so does a saved disk copied before the file was added. To add it, upload
it over FTP and reboot the emulator. See `docs/remote-control-research.md` for the format.

### Export

On a Mac, use Export > Video and Key in the menu bar, or Command-E, and choose a folder. Right Ctrl saves to
`emulator/run/snap/maxine/` instead. Each export writes 720×486 `video` and `key` PNGs, plus `-square` copies
at 648×486 for square-pixel tools.

## Limitations

- Tested on macOS and Ubuntu 24.04.
- Your computer can reach the MAXINE, but the MAXINE can't reach the wider network through it. Telnet login
  and the Intelligent Interface haven't been tested past connecting.
- No boot PROM dump: the driver loads the operating system from disk itself.
- The edge colour, Prompts palette and 50 MHz CPU speed are guesses.
- The clock and date can read wrongly.
- Fn+Delete also switches to MAME's controls, and pressing it again switches back. In that mode Esc can quit.
