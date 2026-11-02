# MAXINE hardware map

For the emulator in `emulator/`. Sources are marked: **fw** = found in the 11.01 firmware, **sch** =
MAXINE schematics (Publ. 2A01697, PDF page numbers), **man** = MVME162 User's Manual or MVME162LX
Programmer's Reference. Nothing here has been checked on the unit. The CPU card hasn't been looked
at, so the CPU card model below comes from how the firmware behaves.

## CPU card

**MVME162 with a 25 MHz 68040.** The emulator runs on this model, so it fits everything the firmware
has done so far. The card itself hasn't been looked at. This corrects an earlier reading: the string
`Motorola 167 82596CA LANC` is only the name in the LAN driver, and writes to `$fff450ee` belong to
other paths in a file built for several CPU cards (`Infinit/060` strings are there too).

Evidence for 162 (**fw**):

- The serial setup writes a Z85230 sequence to `$fff45005`, not CD2401 registers.
- `$fff42000` behaves as the MCchip. `$fff42040`–`$43` is its bus, access time and ABORT switch block,
  which explains the `$17` write and the vector `$5E` handler.
- `PSOS` copies just under 512 KB to `$ffe00000`, the 162's SRAM size. The 167 has 128 KB.
- Driver banners read `162 Prompt Driver` and `162 VT786 Driver`.

Other CPU facts (**fw**):

- Paged MMU unused. Nothing in `PSOS` writes TC, URP or SRP. `HWINIT.X` sets DTT1 `$ffffe040`
  (`$ffxxxxxx` serialized, not cached) and DTT0 `$00018000` (`$00000000`–`$01ffffff`), CACR `$80008000`.
- FPU used heavily, about 6,500 FP instructions in Message Compose, mostly fmove, fmul, fadd, fsub,
  fdiv and fcmp.
- 4 MB DRAM, from the memory size logic at `PSOS` entry. The 162 came with 1, 4 or 8 MB.
- 64 MB expansion on the Andrea board at `$06000000`–`$09ffffff`. Programs load from the top of it.

| Address | Device | Source |
|---|---|---|
| `$00000000`–DRAM size | DRAM | man |
| `$FF800000`–`$FFBFFFFF` | 32-pin PLCC EPROM XU24 and 1 MB Flash; J21 sets EPROM size, and a jumper picks which one supplies the reset code | man |
| `$FFE00000` | 512 KB SRAM | man, fw |
| `$FFF40000`–`$FFF401FF` | VMEchip2 LCSR, GCSR | man, fw |
| `$FFF42000`–`$FFF42FFF` | MCchip | man, fw |
| `$FFF45001`/`3`, `5`/`7` | SCC #1 port B control/data, port A control/data | man, fw |
| `$FFF45801`… | SCC #2, same layout | man |
| `$FFF46000` | 82596CA LAN. Port: two 16-bit writes, low word first. `+4` is channel attention | man, fw |
| `$FFF47000` | 53C710 SCSI | man, fw |
| `$FFFC0000`–`$FFFCFFFF` | MK48T08 BBRAM and clock, 8 KB repeated | man, fw |

`emulator/patches/i82586-mvme162.patch` keeps frame data, the configure block and addresses in memory order,
pads and checksums received frames, which MAME's host backends deliver without an FCS, and makes dword access
unaligned, because the LAN driver's command blocks can sit on 2-byte boundaries.

**82596 byte order (fw, Linux driver):** 16-bit fields read normally, 32-bit pointers are low word
first. `SCP` is at `$2f6e0`, sysbus `$44`. The emulator treats it as a little-endian chip with each
long's words swapped. Frame data doesn't go through that swap on the real board, which isn't handled.

Interrupts: MCchip vector base `$50`, tick timer 1 at 2 ms on level 5. VMEbus IRQs go through
VMEchip2, enable bits at `$fff4006c`, levels at `$fff40084` (`$00654321`, so IRQ n is level n).

## pSOS boot

`/SYSTEM/PROGRAMS/PSOS` (fw):

- Header long at `+0x9c` is the entry point, `$30c8`. Load base `$3000`.
- Entry sets VBR 0 and SR `$2700`, picks memory size from NVRAM `$fffc0302` (0 or 2 selects 4, else 3)
  and stores it in `$fffc0000`. SP `$b80`. MCchip vector base `$50`.
- Copies the kernel block to SRAM: pSOS+ `M68020 V2.0.E` at `$ffe00000`, pHILE+ `V2.3.2` at `$ffe06000`,
  pROBE+ `V2.0.E` at `$ffe13000`, pRPC, pNA+ `V2.0.B`, then jumps to pROBE+ at `$ffe13020`. pROBE+ runs
  silently and starts pSOS+. The file holds a second set about `$46000` later, for another CPU.
- A fatal error from pSOS+ lands in pROBE+, which waits on the console for its host protocol, seen as
  a read loop looking for `S`. That's the symptom if the boot stops early.
- `STARTUP`, `HWINIT.X`, `LOADER.X` and `PMT.DRV` then load from the volume.

NVRAM (`$fffc0000`), all zeros works once the disk entry is set:

- `$0a` + 8 × minor: log2 block size, u32 block count, SCSI ID, LUN, type (0 none, 1 Seagate, 2 Iomega).
- `$0100`–`$0102`: frame buffer type per board. `$0103`: bit 4 means VSB addressing. `$0104`: video board.
- `$008a`: no-mount flag. `$0200`: major number of a boot volume to try. `$0252`: boot volume name.
- `$0302`: debug mode. `$0770`–`$0790`: network settings. `$1ff8` up: clock.

The boot tries volumes `5.0`, `5.3`, `0.1`, then `0.0`. Unmatched minors give error `$a0000`.

## Andrea interface board

| Address | Device | Source |
|---|---|---|
| `$81xxxxxx` | VSB | sch p40 |
| `$82xxxxxx` | Local | sch p40 |
| `$83xxxxxx` (`84`, `85` look the same) | VME | sch p40 |
| `$06`–`$09xxxxxx` | DRAM | sch p40 |
| `$82100000`–`6` | TMS34010 host port, 50 MHz (ADRL, ADRH, DATA, CTL); four TC524256 VRAM | sch p41, `PMT.DRV` |
| `$82100008` | TMS34010 reset, bit 0 | `PMT.DRV` |
| `$8210180x` | ARCNET COM20020 | sch p43 |
| `$8210188x` | ARCNET ID switch. WiNFiNiT Server reads `$82101881`, bits reversed; its top two bits override the user mode in NVRAM `$fffc07d3`. Reads 0 in the emulator | sch p40, `WINFINIT.X` |
| `$8210190x` | Status buffer | sch p40, fw |
| `$82101981` | Site ID, from an undumped 16R8 PAL and 74F374. Write 0 or 1 for the high or low byte, read it bit-reversed | sch p40, `STARTUP` |
| `$821020xx` | BIM, 8 registers on odd addresses, part not printed | sch p40, fw |
| `$821028xx` | MC68901 MFP, GPI and timers, 3.6864 MHz | sch p40 |
| `$821030xx` | Keyboard DUART, SCN68681, 3.6864 MHz | sch p44 |
| `$821038xx` | Serial DUART, ports 2 and 3 | sch p44 |

**Prompt display (fw):** PMT uploads a 34010 program to `$250000` up, and its mailbox is at `$24c000`,
with host control `& $70 == $50` meaning ready. The 34010 interrupts the 68040 through BIM channel 0,
vector `$80`, VME IRQ 2. Its 4 bpp screen starts at VRAM 0, with 1024 pixels to a row, the low nibble
first. About 702×480 is visible at 525 lines, 702×572 at 625, and the UI is drawn 500×432. VTOTAL stays at `$ffff`, so the
vertical timing is external, from the video board.

**Interrupts (fw):** the BIM drives VME IRQs through the VMEchip2.

| Channel | Control | Vector | Source |
|---|---|---|---|
| 0 | `$1a`, level 2 | `$80` | TMS34010 |
| 1 | `$15`, level 5 | `$85` | Serial DUART (wiring assumed) |
| 2 | `$16`, level 6 | `$4b` | Field interrupt. The firmware counts these to pick 525 or 625 lines: under 58 a second is 625. Taken over by the Vdrive handler at field rate |
| 3 | `$12`, level 2 | `$90` | Keyboard DUART and MFP |

MAME's BIM model isn't used: it never clears a channel's pending state, so a channel that fires once
answers every later acknowledge at its level. The driver has its own, with level-sensitive inputs.

## Outputs

The MAXINE has four: **Prompts** (the UI), **Color Edit** (text plus cursor, safe title and colour
chip overlays), **Video** (clean text) and **Key** (the matte).

Program video is NTSC 720x486, with pixels 0.9 as wide as tall. Prompts runs on a 12 MHz pixel clock, which
is within about 1% of square. Color Edit shows the whole raster, because the Palette tool draws its colour
chips from row 453 to 492, at 603 layout units wide by 452 tall. The tablet's units are square: its scales
per raster pixel and line, 4.937 and 5.489, differ by the same 0.9.

Prompts and the overlay share the 34010's 4-bit pixels. The top three bits are Prompts and bit 0 is
the overlay, kept apart with PMASK: `$1111` for Prompts, `$eeee` for the overlay. MAME's 34010 ignores
PMASK, so the driver applies it in `vram_w`, to pixels in the display area only.

In the emulator, the overlay sits at FB x = VRAM x − 10, y = VRAM y + 22, from lining up the cursor.

## Frame buffer board

At `$81000000`; further boards at `$81080000` and `$81100000`. `HWINIT` tells types apart by reading
back the base register: `$ffffffff` (floating, write-only) is a plain board and loads `FB_DUAL.X`.
`NVRAM $0100` holds the result. `FB_ANCH.X` and `FB_CLYP.X` are for other types. Schematics: 2A01548,
IDT7201 FIFOs (p5), palette 2K×25 (p6), VRAM (p13–17).

| Offset | Use |
|---|---|
| `+00` | Control. Bit 5 set: data port takes run records. Clear: it copies rows. Bits 2..0 flip the displayed bank of up to three boards (bit 0 set shows bank B). Bits 18..11 and others unexplained |
| `+04` | Colour number: 0 black, 1 green, 2 blue, 3 cyan, 4 red, 5 yellow, 6 magenta, 7 white |
| `+08` | Address, `row << 10 \| x`. 2048 rows, two banks of 1024 |
| `+0c` | Data port |
| `$10000`, `$11000` | Line tables, 1024 longs each, `row * $800` |
| `$20000` | Palette, `bank << 8 \| n`, 8 banks of 32, stored `$BBGGRR`. Entry 1 is the 75% colour, 2 the 50%, 3 up unexplained ramps |
| `$30000` | A third table, purpose unknown |

**The data port takes font records.** A run record is exactly one word of a font file: layer in the
top 16 bits, intensity in 15..8, `(32 − length) << 3 | type`. The layer picks the palette entry (1 face,
2 edge) and the intensity is the key. `FB_DUAL` copies glyph data straight to the port, re-sending
control every 8 words. Fills write one row, then in row mode: `3` latches the addressed row and each
later record copies it to `length` rows.

**With control bit 4 clear, each word is one pixel:** `$KKBBGGRR`, the key and a full colour that bypasses
the palette, in the palette's byte order and already multiplied by the key. Message Compose's Palette tool (CNTL, P) draws its bars, swatch and
colour chips this way, into the frame buffer rather than the overlay, so they reach Video and Key too.

Message Compose redraws a row into the hidden bank, flips, and repeats on the other bank.

Unknown: real edge colour (the model uses entry 2 of the face colour's bank), how face and edge
share a 16-bit pixel (the model stores both), and how roll and crawl drive the hardware.

Also present, as plain memory in the emulator: `$81200000`–`$81201fff`, `$81202000`–`ff`, and
`$81203000`–`$81205fff` (video board). HWINIT tests `$81202000` with `$aa55`. `$81202100` (601 board) and
`$81300000` (camera) are left absent so those options report not found.

Video board 2A01707: ADV7120 × 2 for Y and C (p31), timing PROMs CY7C263, undumped (p23).
Optional: F/X, Transformer (`$846`–`$85`), Camera capture, 601, Anchor (NCR53C720, `$810`, `$811`).

## Keyboard and mouse

The keyboard is an 8052 at 11.059 MHz (sch p4), on an RS-485 pair per the owner, through DUART
channel A at **9600 8E1**, one byte per key. The ISR at `$75c4` posts each byte to the `key1` queue.
Channel B is a Microsoft-style serial mouse: 1200 7N1, 3-byte packets. Loader menus are mouse-driven.

Key codes come from Message Compose's name table at file offset `$1589a4`, cross-checked with Avid's
guide. Letters are ASCII. Above `$7f`:

| Codes | Keys |
|---|---|
| `$80`–`$8b` | SHIFT ROW / PAGE / CHAR, L R D U |
| `$8c`–`$8f` | CURSOR L R D U |
| `$90`–`$9b` | S-SHIFT ROW / PAGE / CHAR |
| `$a0`–`$a7` | FNT SEL 1–8 |
| `$a8`–`$af` | COL SEL RED MGTA BLUE CYAN YEL GRN WHT BLK |
| `$c0`–`$ca` | KEYPAD 0–9, CLR |
| `$cb`–`$cf` | HOME, COLOR FONT, ERASE, NEW LINE, ALT |
| `$d0`–`$d4`, `$e0`–`$e4` | F1–F5, F6–F10 |
| `$d5`, `$d6` | CNTL, CNVRT |
| `$d8`–`$df` | CRAWL, ROLL, DELR, INSR, CENTR, DELC, INSC, CENTP |
| `$e5`, `$e6` | TAB, shifted TAB |
| `$e9`–`$eb` | MIX, SET-UP, IMAGESTOR |
| `$ed`, `$ee` | LOOP, END LOOP |
| `$f0`–`$fc` | DEL MSG, RCD, BUILD, DO, TRIGGER CEL, SLOW REVL, READ NEXT, CHNG, READ, XFER, DELAY, AUTO EXECUTE, WAIT FOR KEY |
| `$fe` | ESC |

The Loader sees CNTL as `$2a`. In Message Compose, CNTL brings up "Type a letter", and `HELP.MM` lists
the letters: F fonts, D directory, B background, P palette, and so on.

### Tablet

Channel A of the serial DUART. NVRAM `$fffc0262` non-zero sets it up from the record at `$fffc0218`:
baud word, then data bits and parity a nibble each, then stop bits. That's 19200 8O1 here. The baud,
data, parity and stop values on the Serial Communications screen are the II port's record at `$21c`, not
the tablet's. `$fffc0411` is the tablet type: 1 SD510C, 2 SD420, 3 UD608, 4 UD1212, 5 Hitachi, 7–11
Intuos, and 0 assumes Hitachi. PSOS's driver is `$a0000` and only starts when a program reads it, which
Logo Compose does and the Loader and Message Compose don't.

An SD510C sends 18-character ASCII lines, `#,XXXXX,YYYYY,BB` with CR LF, which the firmware scales by
2802/3020. BB is the button code, and 99 means the pen is out of range. Logo Compose uses it for the
crosshair on Color Edit, the Point X and Y readouts and buttons, and needs a continuous stream to follow
it. Button 2 flips between that draw mode and a menu mode with an arrow on Prompts. The crosshair's centre
is at raster x = 50.66 + 0.20257 X, y = 591.09 − 0.18219 Y, within a pixel over 34 points, and the arrow's
tip at Prompts x = 0.198 X − 7, y = 443.5 − 0.146 Y. Logo Compose drops a line with X above 3016 or Y
outside 550 to 3019, and the crosshair stays where it was. Every line with a button down counts as a new press, about 20 a second, so the
emulator sends one per click and waits for PSOS's frame flag at `$30cc4` to clear. Lifting the pen, line
code 99, also drops it into menu mode.

Logo Compose's dispatch table at `$11b6e` gives the 12 puck buttons and their keyboard equivalents: 1 S
select point, 2 CNTL, 3 A adjust point, 4 U control point, 5 C arc, 6 P add point, 7 O start or end
outline, 8 S, 9 D delete point, 10 L select outline, 11 N undo, 12 ? help. So the keyboard reaches
everything, and the driver only needs buttons 1 and 2. To make an outline: O, Return, Right arrow, Return
in the Outline Color dialog (a second Return alone lands on Escape), P at each point, then O to close.

Outlines are drawn into the frame buffer one pixel at a time, with control bit 4 clear (see "Frame buffer
board"). With Color 1 selected, a point marker is `$ff00ff00`, pure green. Lines are 3×3 dabs a pixel apart,
`07 1f 07 / 1f 7f 1f / 07 1f 07` in both key and green, written with control bit 25 set. Bit 25 must combine
a word with the pixel, or each dab would erase the last one's centre. The levels are 2ⁿ−1, so OR and max give
the same result, and the emulator ORs. That's inferred, not confirmed on the board. Deleting a point clears
its pixels with key 0 and bit 25 clear. At startup Logo Compose draws a grey box the same way, `$7f7f7f` at the
centre of the dab, with corners near raster (54, 41) and (665, 386).

### Mouse cursor

Mouse deltas move the cursor 1:1 in Prompts pixels, and each program keeps its own x, y pair
(`$09d14a3a` in the Loader and `$09cbe2d2` in Message Compose on this boot, so don't rely on either).
That pair is the arrow's tip, stops at x 107–662, y 38–448, and restarts at 662, 448 with each program.
The arrow is blitted at tip + (5, 7).

The 34010 mailbox has the newest blit's x, y at word `$24c10`, and the previous blit at `$24c20`
with its pitch at +1, x, y at +6 and width, height at +16. Cursor blits have pitch `$2804` and height
15, at 6 or 7 words wide. The clock's blit, at y 30, is what usually pushes the cursor into the
previous slot, up to about 6 seconds later. Other screen drawing also passes through the newest slot.

The emulator has no direct read of the position, so `update_mouse()` counts its own moves. It trusts
the mailbox only for a cursor blit followed by the clock's, and otherwise re-syncs by pushing the cursor
into the top left limit, which gives a known position.

In Message Compose, CURSOR L moves one character and typing overstrikes. SHIFT ROW R (`$81`) moves the
current row 1 pixel right, locked or unlocked. ERASE clears the whole message.

SHIFT ROW R with the keyboard's Shift (`$91`, S-SHIFT ROW R) moves the row 9 pixels.

Two codes aren't named in that table. BACKSPACE is `$5e`, named beside SPACEBAR in Message Compose's
function key display at file offset `$7cd38`, and it deletes the previous character. MODE SLCT is `$ff`:
key readers such as `$81c98` call `mc_exit()` at `$12e8` on that code, which opens the Exit Mode menu
(Exit, Suspend, Quit) built by `pc_modselbld()`. The firmware's "MODE_SLCT" prompts also accept CNTL.

## Disk

No boot sector. pHILE volume `SCRIBEVOL3`, read by `tools/phile.py`. Internal drive on the 53C710.

## Licensed modules

Startup runs `/SYSTEM/PROGRAMS` entries whose site ID matches the machine or is `ffffffff`. The
archive image's licensed files carry `00002192`, so the emulator's site ID register must match to run
`FTPD.X` and `NETWRK`. Keep any real unit's ID out of this repo.

Software options are enabled by a 44-digit key in Disk Utils: Next Page, then Site ID. Its HW Site ID
line prints `site.subscript`. A key has to match the system type (4 is Maxine!, 6 Imagestor! for Maxine!),
the first two characters of the disk version, the site and the subscript. Enter accepts a key and shows
what it enables, and CNTL then X writes that to the drive. Typing X without CNTL goes into the key field.
Writing moves the enabled programs from `/SYSTEM/UNPURCH` to `/SYSTEM/PROGRAMS`, so Startup loads them at
the next boot.

Network settings live in `/SYSTEM/ETC/NET_CONF` on the disk, which Setup's Network screen writes with Save Values.
The network stack reads NVRAM early in boot: the low three Ethernet address bytes at `$779`, then the Internet
address at `$77c`, subnet mask at `$780` and default gateway at `$784`. About 10 seconds in, the Loader's `set_network`
code copies the file over `$76c`, `$774`, `$77c`–`$78f`, creating the file if there isn't one, which is why it
says to reboot after a change. So an address written straight to NVRAM works for one boot, confirmed 2026-11-02 by
booting at 10.37.0.9 and then falling back to 10.37.0.2, and `$779` isn't touched. Fields append to their
text, so clear them with Backspace, and move between them with the arrow keys. The LAN driver reads its full
address from `$1f2c`, where the boot PROM would have put it, so the driver builds that at reset as `08:00:3e`
plus the bytes at `$779`. It also seeds 10.37.0.2/24 with gateway 10.37.0.1 while `$77c` is zero.

## Sources

- [MVME162 User's Manual](https://m88k.com/Docs/162/mvme162_user_manual.pdf)
- [MVME162LX Programmer's Reference](https://m88k.com/Docs/162/162lxpgd.pdf)
- [Linux MVME16x 82596 driver](https://github.com/torvalds/linux/blob/master/drivers/net/ethernet/i825xx/82596.c)
- [Maxine schematics](https://archive.org/details/chyron-maxine-schematics)
- [Disk images](https://archive.org/details/maxine-v10v11)
