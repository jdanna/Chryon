# Blackmagic DeckLink SDK headers

The include files of the Blackmagic Desktop Video SDK 12.2.2, for the emulator's DeckLink output
(`src/mame/chyron/decklinkout.cpp`). They come unchanged from GStreamer's copy in
`subprojects/gst-plugins-bad/sys/decklink/{linux,osx,win}` at commit
`f120800ee1f7c143c9f688066b0c2643f156e464`. `osx` is renamed `mac` here.

Each file carries Blackmagic Design's licence, which allows redistribution as long as the notice stays in
the file. The SDK itself is at https://www.blackmagicdesign.com/desktopvideo_sdk.

Nothing here is linked. The library comes from the Desktop Video driver at run time: `libDeckLinkAPI.so`
on Linux, `/Library/Frameworks/DeckLinkAPI.framework` on a Mac, and COM on Windows. Any Desktop Video
from 12.2 on works with these headers.

`emulator/build.sh` copies the folder for the target into the MAME tree as `src/mame/chyron/decklink/`.
