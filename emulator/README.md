# MAXINE! Studio Emulator

![The emulator running Message Compose](../docs/emulator.png)

A MAME driver that runs the Chyron MAXINE! 11.01 software. Prompts is on the left, Color Edit on the
right, and a clickable panel of MAXINE! keys is below them.

## Functionality

- Runs from the original disk
- Message compose and other built-in apps fully work.
- Exports Fill and Key as PNGs.
- Captures Fill and Key live as 59.94i ProRes files.
- Feeds a picture to the Video Input board.
- Emulates a mouse and a WACOM SD510C tablet.
- Includes 64 MB of expansion RAM.

## Instructions

The Emulator tab in MAXINE! Studio is the easy way to run it, on a Mac, Linux or Windows. Everything below is for
running it from a checkout, except where it says Windows. In the app, the saved image, NVRAM and exports are in the
folder shown under Saved image location, and Start network asks for your password instead of using `sudo`. On Linux,
that needs polkit. On Windows, it's a UAC prompt, and the app is the only way to run the emulator.

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
| Print Screen, Scroll Lock, Pause | DEL ROW, INS ROW, CNTR ROW |
| Insert, Home, Page Up | DEL CHAR, INS CHAR, CNTR PAGE |
| Hold Delete, End, Page Down | SHIFT CHAR, SHIFT PAGE, SHIFT ROW |
| Numpad Enter | READ |
| Numpad + | READ NEXT |
| Numpad − | RCD |
| Numpad * | DEL MSG |
| Numpad / | BUILD |
| Numpad . | CLR |
| F1–F10 | F1–F10 |
| F11, F12 | CRAWL, ROLL |
| Numeric keypad | KEYPAD |
| Num Lock, or Clear on a Mac keypad | Switches the right-hand screen, see below |

Everything else is on the panel, such as ERASE, XFER, HOME and COLOR FONT. Its right side is laid out like a PC
keyboard, with each key where its host key is. The SHIFT keys stay latched on the panel until clicked again, and apply
to the arrow keys. Holding the host's Shift as well moves further. A held arrow key repeats after half a second,
20 times a second. MODE SLCT opens the menu that exits to the Loader.

A Mac laptop has no Print Screen, Scroll Lock, Pause or Insert, so those are panel keys there. Fn+arrows give Home, End,
Page Up and Page Down, and Fn+Delete is Delete. Some desktops keep Print Screen for themselves, and the panel's DEL ROW
works there too.

The panel's key in the Num Lock position switches the right-hand screen between Color Edit, Video and Key. It's labelled
with what's showing, and lit on Video and Key. Those two are the clean outputs, so the cursor and text box aren't on
them, and capture and export don't change with it. It goes back to Color Edit each time the emulator starts.

Command-V pastes the clipboard as plain ASCII. On Windows, it's Right Alt+V, because Windows keeps Win+V.

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

On Windows, install [TAP-Windows](https://build.openvpn.net/downloads/releases/tap-windows-9.24.7-I601-Win10.exe) with
its default options, then press Start network in the app. That adds an adapter called `MAXINE Emulator` and a firewall
rule for it, and they stay across reboots. Stop network removes both and leaves TAP-Windows and any other adapters
alone. Press it before uninstalling the app. Windows on Arm can't use the driver.

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

Each export writes a matching `video` and `key` PNG, at one of two sizes:

- Native is the 720×486 raster.
- Square Pixel is 640×480, named `-640x480`. It narrows the picture to 648×486, then crops 4 columns from each side
  and 3 lines from the top and bottom.

Press EXPORT NATIVE or EXPORT SQUARE PIXEL, to the right of the keypad, and choose a folder. Run from a checkout,
without the app, those buttons save to `emulator/run/snap/maxine/` instead.

On a Mac, the Export menu asks for a folder too: Command-E for Native, or Shift-Command-E for Square Pixel.

Right Ctrl or Shift+Right Ctrl saves straight to the snapshot folder on any system: `snap/maxine/` in the saved image
location in the app, or `emulator/run/snap/maxine/` from a checkout.

### Capture

The Capture section of the Emulator tab records Video and Key while the machine runs, as a matched pair of files:
`capture-0001-video.mov` and `capture-0001-key.mov`. They start on the same frame and have the same length.

- ProRes 422 HQ, about 1 GB a minute, with no audio.
- 720×486, the frame buffer's own pixels, tagged 10:11.
- 59.94i, lower field first. Each field is sampled at its own moment, so motion is real interlace.

Time in the files is the machine's time. If your computer can't keep up, the machine slows down and the app says so,
so no field is dropped or repeated.

A capture refuses to start with under 1 GB free and stops itself under 500 MB, because a file can't be read until it's
finished. Capture is only in the app. A checkout needs `emulator/build-ffmpeg.sh` run once, and a packaged app includes
ffmpeg.

### Video input

The emulated MAXINE has a Video Input board, and a picture you choose is what it sees. In the app, use Browse in the
Video input section of the Emulator tab; on the web, Video in on the top bar. PNG and JPEG work in the app, and any
picture the browser reads on the web.

In Message Compose, CNTL then I opens Video Input Control, which shows the picture live. Space switches between Video
Input and Video Freeze. Leave the menu live and the video stays behind your text, wherever the graphics leave it
uncovered. ALT then V turns that background on and off. With it off, a frozen picture is only kept if Key Enable was
on when it was captured, and each row you type is redrawn on black, as on the real unit. The Key output is the
graphics' key either way.

A picture fills the 4:3 frame without cropping. Ordinary pictures have square pixels and are narrowed to NTSC's, which
are 0.9 as wide as tall. A picture that's already an NTSC frame, 720 or 704 wide by 486 or 480 tall, is used pixel for
pixel.

## Web version

`npm run build:web` builds a static site in `dist-web/` that runs the emulator in a browser tab. It's the same driver,
built with Emscripten, so changes to the driver reach it on the next build. It needs [emsdk](https://emscripten.org/docs/getting_started/downloads.html)
in `~/emsdk`, or `$EMSDK`. The first build takes about 20 minutes, in its own tree at `emulator/mame-web`. Set
`MAXINE_SKIP_EMULATOR=1` to rebuild only the page. `npm run preview:web` serves it at http://127.0.0.1:8137/, and
`npm run test:web` checks it in headless Chrome.

`npm run deploy:web` builds it and publishes it to production on Cloudflare Pages, as the `maxine-emulator` project
whose production branch is `main`, which serves maxine.retrograde.tools. Cloudflare's own Git builds can't make this
site, because they have no Emscripten and stop at 20 minutes.

The startup page shows the release notes from `src/web/CHANGELOG.md`, so add an entry there with each web release.
The build writes a `_headers` file that tells browsers not to cache `emulator/`, so a new page never runs with an old
emulator. Unchanged files still come back as a quick 304.

It has the screens, panel, keyboard, mouse, paste, video input and PNG export, which downloads the pair. It has no network, telnet or
capture. The machine only runs while its tab is showing, because browsers stop drawing hidden tabs.

Each browser keeps its own copy. The first visit downloads the disk, and the first time the machine writes to it, the
whole disk goes into the browser's IndexedDB, with NVRAM. Later visits start from that copy. It's saved every 15 seconds
when it has changed, when the tab is hidden and on Stop. Reset, or starting over from the startup page, deletes both.

The site uses `emulator/roms/maxine-web.chd` if it exists, and `maxine-default.chd` if not. A site with a different image
drops each browser's saved copy, because a saved disk can't carry over to a new image.

Command stays with the browser, and so do shortcuts it won't release, such as Ctrl+W, Ctrl+T and Ctrl+N. Use the panel
for CNTL with those letters. Paste with Command-V, or Ctrl+Shift+V on Windows and Linux.

## Limitations

- Tested on macOS and Ubuntu 24.04. Windows 10 and 11 x64 are new.
- Your computer can reach the MAXINE, but the MAXINE can't reach the wider network through it. Telnet login
  and the Intelligent Interface haven't been tested past connecting.
- No boot PROM dump: the driver loads the operating system from disk itself.
- The edge colour, Prompts palette and 50 MHz CPU speed are guesses.
- A capture's field order and 10:11 tag follow the NTSC standard. They haven't been measured on a real unit.
- The video input ignores the Gain, Black, Delay and Field settings, and Cap Mode hasn't been tried.
- The clock and date can read wrongly.
- Fn+Delete also switches to MAME's controls, and pressing it again switches back. In that mode Esc can quit.
