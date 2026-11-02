# MAXINE remote control over IP: research notes

Researched 2026-11-01, then probed on the unit the same evening. **No II command has been
answered yet.** Facts marked "firmware" come from disassembling the 11.01 disk image, and
"inferred" means worked out from examples. `TELNETD.X` and `INTELINT.X` read from the unit
are byte-identical to the image, and its `FTPD.X` and `NETWRK` differ only in the site ID.

## Verdict

Control over IP looks feasible without emulating anything. MAXINE 11.01 has a telnet server
on port 23 that connects to the Intelligent Interface (II), Chyron's remote-control protocol.

| Route | Status |
|---|---|
| II over telnet, port 23 | Best option. Listening on the unit, but it only accepts clients on the unit's own subnet. |
| II over serial, through a serial-to-IP adapter | Fallback. This is the setup Avid and Editware document. |
| WiNFiNiT | Server is on the unit and licensed, client not found. See below. |

## Results on the unit, 2026-11-01

- **Port 23** refused on the first probe and accepted a few minutes later, with no change
  made from here. Now every connection from the Mac is closed about 5 ms after it opens, with
  no banner. That matches the subnet check below: the Mac reaches the unit through a VPN, from
  an address outside the unit's subnet.
- **Port 6500** accepts connections and never sends anything. Tried: idle for 8 s, bare CR,
  `Q\\`, and the relay's `0x01` flag byte first. Why it stays silent is unknown. `listen`
  completes the TCP handshake, so a connection doesn't prove the daemon accepted it.
- FTP, telnet and 6500 all still answered after these tests.
- **Licensing:** Startup only runs `FTPD.X` if its site ID matches the machine, and it runs.
  `II_OPT`, `NFS_OPT`, `DDR.OPT`, `WINFINIT.X` and `NETWRK` carry the same ID, so II is
  licensed. `IS.OPT` (IMAGESTOR!) is in `/SYSTEM/UNPURCH`, so that one isn't.
- `TELNETD.CFG` isn't on the unit, so the defaults below apply.

## What could block it

- **Subnet check (firmware):** see the telnet section. This is what stops the Mac today.
- **Message Compose:** II itself doesn't need it to start, see below, but playout and message
  commands presumably do. Avid says to enter it and load fonts first.
- **Login:** see below. Tel No Login or a `users` entry is required.
- **Crawls and rolls:** Avid says a cued one blocks other II commands until it ends, and a
  serial crawl can only be aborted with ESC on the keyboard.

## Next test

Either route gets past the subnet check. Nothing else from the Mac is worth trying until one
of them is in place.

1. **No change to the unit:** connect from an address in the unit's subnet, either a machine
   on that network or NAT on the VPN gateway.
2. **Change the unit:** upload a `TELNETD.CFG` (below) to `/SYSTEM/ETC` and reboot. It's read
   once at startup.

Then run `nc <unit-ip> 23`, expect `Welcome to Chyron Intelligent Interface.`, and press Enter.
`00004190` means II is listening. Editware documents this reply on serial, and it changes
nothing on screen.

Don't send `Y` keystrokes unless the unit is confirmed to be in Message Compose: at the Loader
they would drive its menus. Ask before sending any real command: the unit has hung on bursts of
FTP writes, and the disk holds the originals.

## Telnet server (firmware)

Module `Telnet ver 11.00`, image offset `0x11efc08`. Present in 10.10 as well (`ver 10.10`).

- Listens on TCP port 23, hard-coded (`0x11f429e`, `move.w #$17`). There is no port option.
- Default banner: `Welcome to Chyron Intelligent Interface.`
- **Boot:** Startup loads every type `0x4C` and `0x4D` program in `/SYSTEM/PROGRAMS` whose site
  ID matches or is `ffffffff`. `TELNETD.X` and `INTELINT.X` are both type `0x4D` with
  `ffffffff`, so both run at boot, whether or not Message Compose is open. Message Compose looks
  up the `II` task and appears to suspend and resume it around a serial crawl (pSOS calls 6 and
  7, inferred).
- **Startup order:** the `TELD` task sleeps 5 s, reads the config and starts the `EPTY` task.
  `EPTY` waits up to 60 s for II's `IIAQ` queue, connects, gets the II version, then opens the
  acceptor on port 6500. `TELD` waits up to 120 s for that and only then listens on 23. If any
  step fails the task deletes itself, and port 23 stays closed until a reboot.
- **Port 6500** is the internal side. For each client, `TELD` connects to it, sends one `0x01`
  byte and relays. It binds to all addresses, so it's reachable from the network with no subnet
  check. With login on, a login task sleeps 2 s, waits up to 30 s for that byte, then prompts.
- **Subnet check:** with no `allow` list, a client must be in the unit's own network, taken
  from its IP class. Anyone else is closed with no banner and logs `TELD - refusing service
  to: %s`. With an `allow` list, only those ranges are accepted, so include the local network.

### `TELNETD.CFG` (firmware)

Read at `TELD` start from `<drive>/SYSTEM/ETC/TELNETD.CFG`, or `<drive>/<dir>/ETC/TELNETD.CFG`.
It isn't in the disk image or on the unit, so the syntax comes from the parser. An `[allow]` rule has been
tried on the emulator, see the plan below. It's plain text with `[section]` headers, `key=value` lines, and `#` comments.
Section and key names ignore case.

```
[options]
MAXSESSIONS=2
BANNER=Welcome to Chyron Intelligent Interface.

[users]
name=password

[allow]
lan=<first-lan-ip>-<last-lan-ip>
vpn=<vpn-client-ip>

[forbid]
```

`users` keys and values are cut to 20 bytes. `allow` and `forbid` values are one address or
`first-last`, and the key is ignored but must not be empty.

### Login

- The no-login flag is one byte at `$fffc0268` (read at `0x11f6306`, set at `0x11f6316`).
  When set, a client attaches straight to II.
- Otherwise it prompts `login: ` and `password: `, with three tries, then sends `Telnet
  access denied, please reconnect.`
- Credentials are compared in plain text with the `users` list (`0x11f144c`). No default
  users were found, so without a config file every login should fail.
- The toggle is **Tel No Login** in the Loader's Setup menu, which reports `Telnet Login
  prompt enabled` or `disabled`. The same menu has **FTP Reset**, which reports `FTP server
  has been reset.` That may help after an FTP hang; it hasn't been tried.
- Not checked: whether the server sends telnet IAC negotiation. A client should expect it.

### Plan for MAXINE! Studio remote control

Not built yet. This is what Studio needs to reach the Intelligent Interface over telnet. Test against the emulator
first (`emulator/net-up.sh`, unit at 10.37.0.2), and ask before writing to a real unit.

Tested on the emulator on 2026-11-02:

- With no `/SYSTEM/ETC/TELNETD.CFG`, port 23 accepted the TCP connection and closed it straight away with no
  data, from 10.37.0.1 to a unit at 10.37.0.2. The subnet check above suggests that client should have passed, so
  why it closed isn't known. Adding the file fixed it. A client should treat this close as "not allowed or not
  set up" rather than a network failure.
- FTP can install the file. `CWD /SYSTEM/ETC` then `STOR TELNETD.CFG` worked with Unix line endings, in active
  mode like every other transfer. The server reads it at boot, so the unit has to reboot afterwards.
- With this file and `host=10.37.0.1`, the server accepted the connection and sent `ff fd 18`, telnet's `IAC DO
  TERMINAL-TYPE`. So it does negotiate, and the open question under Login is answered:

```ini
[options]
MAXSESSIONS=2
BANNER=Welcome to Chyron Intelligent Interface.

[users]
chyron=chyron

[allow]
host=10.37.0.1

[forbid]
```

Still untested: answering the negotiation, logging in, and any II command. A raw socket that ignored `ff fd 18`
got nothing further, so Studio's client must reply to IAC options before expecting `login: `.

What Studio needs:

1. A telnet client that handles IAC negotiation. Answering `IAC WONT` to each `DO` is the likely minimum.
2. A setup step that reads `/SYSTEM/ETC/TELNETD.CFG` if there is one, adds this computer's address to `[allow]`
   rather than replacing the file, uploads it, and tells the operator to reboot. Show the operator what will
   change first.
3. Either credentials in the app, or the operator turning on **Tel No Login**, which skips the login. Passwords in
   this file are plain text on a unit that serves FTP to anyone, so never reuse a real one.
4. The source address the unit sees has to be the one in `[allow]`. A client over a VPN needs its VPN address or
   a NAT on the unit's subnet, which is why telnet closes on the real unit today.

## II protocol

Module `Intel. Interface ver 11.00`, image offset `0xb35008`. Main parser at `0xb37348`,
line reader at `0xb37f84`.

### Framing (firmware)

- Fields are separated by `\`, and `\\` ends the message.
- A line ends at CR. LF is ignored, and backspace (0x08) deletes the previous byte.
- 0x06 has special handling that wasn't decoded.
- The buffer is 6000 bytes (`buffer overrun - %d`).
- The first byte is the command, and anything over `z` or not in the table is invalid.
- Uppercase commands ignore the machine ID. Lowercase forms take it as the first field, and a
  wrong ID appears to be dropped without a reply. Uppercase is simplest for a single unit.
- A line that is exactly `\\` returns error 0x4190.

### Checksum (firmware)

Optional. If the byte before CR is `\`, no checksum is checked.

Otherwise the last two bytes are hex digits. The checksum is the sum of every byte before
them, including the `\\`, mod 256. It is compared as `%02x`, and uppercase letters are folded
to lowercase. A single digit after `\` is treated as having a leading `0`.

Example: `V\5\3\1\1\2011\1\\` has checksum `f5`, so send `V\5\3\1\1\2011\1\\f5` + CR.

### Replies

| Reply | Meaning | Source |
|---|---|---|
| `*\r\n` | Success | firmware, Inscriber |
| `%08x\r\n` | Error code | firmware |
| `V\%02d\%08x\\` | Effect status | format string, not traced |
| `V\%s\%08x\\` | Effect failure | firmware |

`V` and `T` don't return `*` from the parser. Avid says only `V` commands signal that an
action has finished. `Q` resends the last reply, which starts as `00004195`.

| Code | Meaning |
|---|---|
| `0x400b` | Bad checksum |
| `0x4190` | Line was exactly `\\`; Editware also gets it from a bare Enter |
| `0x4192` | Invalid command, or an invalid argument to `P` or `S` |
| `0x4195` | Initial "last reply" value, meaning unknown |

The full list is in Appendix A of the II handbook, which wasn't found.

### Command table (firmware)

Table at `0xb376c6`: `!CFMPQRSTUVWXYZcfmpqruvwyz`. Lowercase handlers check the machine ID,
then fall into the uppercase handler. Addresses are image offsets.

| Cmd | Handler | Firmware message or meaning |
|---|---|---|
| `!` | `b376e0` | Not decoded |
| `C`, `F` | `b37702` | `Template attribute change successful`; `F` vs `C` not decoded |
| `M` | `b377b4` | `Directory change successful` |
| `P` | `b37822` | `Priority change successful`; argument `0` or `1`, likely Turbo mode |
| `Q` | `b37910` | Resend last reply |
| `R` | `b37938` | `External update successful` |
| `S` | `b37992` | `Timeout change successful`; first argument `1` or `2` |
| `T` | `b37a56` | `Command sent to Recall Keyboard Daemon` |
| `U` | `b37a96` | `Template data field update successful` |
| `V`, `X` | `b37b48` | Effects; `X` vs `V` not decoded |
| `W` | `b37bd6` | `Template data record successful` |
| `Y`, `Z` | `b37cb0` | Keyboard packet (`0xb3b320`) to primary / secondary user |

## Command syntax

### From Inscriber's guide

Inscriber's product follows the II protocol, so check these against the unit.

```
M\[drive letter]/[directory name]\\
W\[tab data message ID]\[tab description message ID]\[data 1]\[data 2]\...\\
T\[command #]\[parameter 1]\...\\
V\[read effects framebuffer code]\1\[effect]\[pattern]\[speed]\[ease]\[reverse]\[row 0 dir]\...\\
V\[roll or crawl framebuffer code]\1\[effect]\[roll or crawl ID]\[duration]\\
V\6\[special effects command 1]\...\\
```

Inscriber's example:

```
M\c/news\\
W\2000\1000\Ralph Phelpps\Waterloo\Crime Reporter\\
T\7\2000\A\\
```

This selects a folder, fills template 1000 and saves it as 2000, then airs it on channel A.
`T` is an IMAGESTORE! command, so playout on the MAXINE may need `V` instead.

`V\5` miscellaneous subcommands:

| # | Action |
|---|---|
| 1 / 2 | Keyboard input off / on |
| 3 | Prebuild framebuffer |
| 4 | Set Message Compose active buffer |
| 5 | Set palette |
| 6 | Quick erase, displaying framebuffer |
| 7 | Quick erase, non-displaying framebuffer |
| 11 / 12 | Disable / enable prompts monitor updates |
| 13 | Prebuild |

Other groups: `V\3` mix effects, `V\4` transform, `V\6` trigger effects.

`T` numbers: 0 add still, 1 replace still, 2 move entry, 3 delete entry, 4 delete playlist,
5 change current entry, 6 read next, 7 read still, 8 read playlist, 9 query playlist,
10 query entry, 11 keyboard lock, 12 save playlist, 13 query status, 14 erase channel.

### Working examples

- Call up page 2011 (Editware): `V\5\3\1\1\2011\1\\`
- Lowercase with a text field (Avid): `v\$MID\5\13\1\1\$TADD\1\No! never!\\`
- `W` update over TCP (Ross forum): `W\50005\50000\ \LINE ONE\LINE TWO\\`

Field positions in the `V\5\3` and `V\5\13` forms are inferred. They look like buffer,
something, message number, something, then text fields.

### Read effect parameters (Avid)

`mode\type\speed\ease\rev[\rowd...]\\`

- **mode:** C cut, D dissolve, H hide, P push, R reveal, W wipe.
- **type:** A horizontal slide/wipe, B vertical slide/wipe, C horizontal split wipe,
  D vertical split wipe, E box wipe, F row slide/wipe, G scanline wipe (1/4 screen at a time),
  H row-by-row scanline wipe, I screen scanline wipe, J pixel wipe. C, D and E are wipes only.
  Dissolve still needs a value from A to J.
- **speed:** 1 to 300 frames.
- **ease:** 0 none, 1 in, 2 out, 3 both.
- **rev:** 0 off, 1 on.
- **rowd:** optional, up to 24 rows; 0 up, 1 down, 2 left, 3 right, 4 static.

Buffer IDs: 0 is buffer 1, 1 is buffer 2, 2 is buffer 3 (iNFiNiT! only).

### Keystrokes (`Y`)

`Y` sends keystrokes to the primary user, so it can reach anything the keyboard can. Avid
writes keycodes as `<NNN>` in decimal:

```
y\$MID\<205><202>#PADD<248><217>\\     static roll cue, single channel; clears the screen
y\$MID\ \\                             play
y\$MID\<254>\\                         stop
y\$MID\<247><202>#PADD<248><216>\\     static crawl cue
y\$MID\<254><247>\\                    crawl stop, changes the buffer back
```

`#PADD` is the message address as keypad codes. `<NNN>` may be Avid's notation for a raw byte
rather than text the unit parses. Going by the roles above, 205 clears the screen, 247
changes buffer, 217 is roll, 216 is crawl and 254 stops, but those are all inferred. Avid
warns that decimal 8 is not handled well.

## Setup on the unit

- **Machine ID:** SET-UP I. Must be set when II is installed.
- **Serial:** SET-UP C. Unset ports show `Serial Ports not initialized - use SETUP C`.
- **Network:** SET-UP N. Reboot after changes.
- **State:** enter Message Compose and load the fonts first. Avid says fonts must be loaded to
  the font keys each time Message Compose is entered.
- **Error reboot:** SET-UP E. Chyron recommends Manual for live use.

### Serial fallback

- The firmware's II client is on COM4 (`II - unable to create COM4 client`), and Editware
  uses Port 4 on an iNFiNiT!.
- MAXINE has four serial ports, RS-232 by default. RS-422 needs a jumper change, and Chyron
  warns that wrong wiring can damage the port.
- Avid's default is 9600 8N1; Editware used 19200 8N1. Match SET-UP C.
- Use XON/XOFF or no flow control. The Chyron ignores hardware handshaking.
- RS-232 on the Chyron's DB-9: pin 3 transmit, pin 2 receive, pin 5 ground. Avid also suggests
  looping RTS/CTS (7-8) and DCD/DTR/DSR (1-4-6) on the PC side if its port needs them.

## WiNFiNiT

A PC application for operating the unit. It's a licensed option with a server on the unit,
`WINFINIT.X`, and setup has a Keybd Map item for it (SET-UP M). The manual says `KeyPC` and PC
control can run remotely, and User Mode has Local and Remote settings.

The image's `WINFINIT.X` is a 4 KB stub, but this unit has the real 101 KB server, stamped with
its site ID. Its protocol could be read from that file, but the client and handbook still
weren't found. II covers playback, data and keystrokes anyway, so WiNFiNiT is only worth
chasing to see the screen remotely; the server does send screen images (`DIB`) and takes
keycodes and tablet coordinates.

- It reports `Connection: LOCAL`, `AVAILABLE` or `IN USE`, and tells the operator to connect
  once User Mode is set to Remote. Its ports are closed now, which fits a user set to Local.
- Ports (firmware): TCP 8181 for the primary user, 8182 for the secondary, plus a socket bound
  to 8180 with a broadcast address on 8100, purpose not traced. 8100, 8180, 8181 and 8182 all
  refused from the Mac.

Modern Chyron products (Lyric, HyperX, Prime) also use II on port 23 through their own
telnet setting. Ross, Sportradar and others document this, so those guides are useful for
syntax, but Lyric's II is an extended subset and can be UTF-16.

## Firmware reference

Source: `maxine-v11.01.img` from `maxine-v10v11`. It's a 1 GB image with data in about the
first 47 MB, and the disk content appears twice, about `0x1590400` apart. The CPU is a 68040.

- Each module starts with a `Name ver NN.NN` banner preceded by `0000004d`, and its strings
  follow `START OF DATA`.
- Calls and string references use a form Capstone can't decode: `4ebb 8170 <disp32>` (`jsr`)
  and `487b 8170 <disp32>` (`pea`). `41fb`, `43fb`, `45fb` and `47fb` with `8170` are `lea`.
  The target is opcode address + 2 + disp32.

| Module | Offset |
|---|---|
| Message Compose 11.01 | `0x9d1c08` |
| Intel. Interface 11.00 | `0xb35008` |
| FTP Server Daemon 11.00 | `0xcdb408` |
| Network Utilities 11.00 | `0xd51808` |
| Startup Program 11.00 | `0x1065808` |
| pSOS 11.01 | `0x1098808` |
| Program Loader 11.01 | `0x1189008` |
| Telnet 11.00 | `0x11efc08` |
| Keyboard Map Drv 11.00 | `0x1296c08` |

`Fonts By Wire`, at `0xcc2008`, may be worth a look for font loading over serial.

Program files start with a big-endian type and site ID, then the banner. The task name and
start values are at `+0xa8`.

## Open questions

1. Why did port 23 refuse at first and open later? A boot still in progress fits, but nobody
   checked when the unit was powered on.
2. Why is port 6500 silent? If the telnet relay hits the same thing, a client on the right
   subnet will see a banner and then nothing.
3. Does the telnet server send IAC negotiation? Does a client on the right subnet get a banner?
4. What is the full keycode map for `Y`, including number keys and the `'` key? Start with the
   Keyboard Map driver and the keymap section of the manual.
5. What do the `V\5\3` and `V\5\13` fields mean, and what do `!`, `C` vs `F` and `X` do?
6. Does II traffic hang the unit the way FTP write bursts did? Pace it the same way at first.
7. Can the handbook be found (Pub. 2A01989, Rev C, February 1999)?

## Sources

- [Chyron Maxine Disk Images](https://archive.org/details/maxine-v10v11)
- [Chyron Maxine Schematics](https://archive.org/details/chyron-maxine-schematics)
- [Chyron Infinit Schematics](https://archive.org/details/chyron-infinit-schematics)
- [Chyron Maxine Flyer](https://archive.org/details/chyron-maxine-flyer)
- [WinMasterCG](https://archive.org/details/winmastercg), third-party Windows control software
- [iNFiNiT! Family Operation Manual, Rev D](https://www.manualslib.com/manual/1215325/Chyron-Infinit-Series.html)
- [Inscriber Automation Interface User Guide](https://docshare01.docshare.tips/files/21835/218352025.pdf), chapter 9
- [Avid Chyron Device Manager Guide 1.1](https://resources.avid.com/SupportFiles/attach/CAv1.1-ChyronDMG.pdf)
- [Avid Chyron Device Manager Guide 1.6](https://resources.avid.com/supportfiles/attach/0130-06422-02a.pdf)
- [Editware Fastrack iNFiNiT! tech note](http://www.editware.com/_Fastrack/Tech-ReleaseNotes/TNFTChryonInfinit!.htm)
- [Ross forum: Chyron II commands over TCP](https://rossvideo.community/communities/community-home/digestviewer/viewthread?MessageKey=01489899-1f74-4a82-acc1-6a5dd53ac031&CommunityKey=94781415-eb0f-4f9a-b891-c44d41d870c8)
- [Ross: ChyronHego device setup](https://help.rossvideo.com/acuity-device/Topics/Devices/CG/Chyron-HyperX.html)
