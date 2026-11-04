#!/bin/sh
# Overlays emulator/src on the MAME checkout and builds the single-driver binary.
# Driver-local devices live next to the driver in src/mame/chyron, so no MAME
# build scripts need patching; only the driver list gets one section added.
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
# MAXINE_MAME_DIR keeps a separate tree, which is how the packaged Linux build stays apart from this one
MAME=${MAXINE_MAME_DIR:-$HERE/mame}

[ -f "$MAME/makefile" ] || MAXINE_MAME_DIR=$MAME "$HERE/fetch-mame.sh"

mkdir -p "$MAME/src/mame/chyron"
cp "$HERE"/src/mame/chyron/* "$MAME/src/mame/chyron/"

# The DeckLink SDK's headers for the target, which decklinkout.cpp includes. The web has no DeckLink.
case "${MAXINE_TARGET:-}" in
    windows) DECKLINK=win ;;
    web) DECKLINK= ;;
    *) [ "$(uname -s)" = Darwin ] && DECKLINK=mac || DECKLINK=linux ;;
esac
rm -rf "$MAME/src/mame/chyron/decklink"
[ -n "$DECKLINK" ] && cp -R "$HERE/third_party/decklink/$DECKLINK" "$MAME/src/mame/chyron/decklink"

# The MVME162's 82596 needs byte order and framing MAME doesn't have
apply_patches() {
    for PATCH in "$@"; do
        git -C "$MAME" apply --reverse --check "$PATCH" 2>/dev/null || git -C "$MAME" apply "$PATCH"
    done
}
apply_patches "$HERE"/patches/*.patch

# Windows is cross-compiled in emulator/Dockerfile.windows, with SDL linked in. It uses the SDL OSD
# like the other platforms, because the Windows one puts the cursor back on every message pump.
# The GUI subsystem keeps a console from opening. The arguments here override the make line below.
# MAME clears ARCHITECTURE on an arm64 host, which would pick the 32-bit target, so it's set here.
if [ "${MAXINE_TARGET:-}" = windows ]; then
    apply_patches "$HERE"/patches/windows/*.patch
    set -- TARGETOS=windows ARCHITECTURE=_x64 OSD=sdl PLATFORM=x86 MINGW64=/usr USE_LIBSDL=0 USE_PCAP=0 USE_TAPTUN=1 TOOLS=0 \
        LDOPTS=-Wl,--subsystem,windows "$@"
fi

# The web build goes through Emscripten, in its own tree (emulator/mame-web). MAME picks the asmjs target
# from CC, which emmake sets. A wasm build is 32-bit, and has no sockets, threads or network devices to use.
MAKE_TOOL=make
if [ "${MAXINE_TARGET:-}" = web ]; then
    command -v emcc >/dev/null || . "${EMSDK:-$HOME/emsdk}/emsdk_env.sh"
    embuilder build sdl3 sdl3_ttf
    apply_patches "$HERE"/patches/web/*.patch
    MAKE_TOOL="emmake make"
    set -- OSD=sdl3 USE_LIBSDL=0 USE_PCAP=0 TOOLS=0 PTR64=0 "$@"
fi

if ! grep -q '@source:chyron/maxine.cpp' "$MAME/src/mame/mame.lst"; then
    printf '\n@source:chyron/maxine.cpp\nmaxine\n' >> "$MAME/src/mame/mame.lst"
fi

cd "$MAME"

SOURCES=$(cd src/mame && ls chyron/*.cpp | paste -sd , -)
# MAME still builds a .cpp whose header the driver includes, so one that can't compile there guards itself, as decklinkout.cpp and ndiout.cpp do
[ "${MAXINE_TARGET:-}" = web ] && SOURCES=$(echo "$SOURCES" | sed 's/chyron.decklinkout.cpp,//; s/chyron.fieldcapture.cpp,//; s/,chyron.ndiout.cpp//; s/chyron.ndiout.cpp,//')
BUILD_KEY="$SOURCES pcap nosound"
REGENIE=0
if [ "$BUILD_KEY" != "$(cat .maxine-sources 2>/dev/null)" ]; then
    REGENIE=1
    echo "$BUILD_KEY" > .maxine-sources
    # Make doesn't notice changed defines, so old OSD objects would still want the libraries left out
    find build \( -path '*/src/osd' -o -name 'libosd_*' \) -prune -exec rm -rf {} + 2>/dev/null || true
fi

# A small machine or Docker VM runs fewer jobs, because some MAME files take over 3 GB to compile
JOBS=$(getconf _NPROCESSORS_ONLN)
if [ -r /proc/meminfo ]; then
    FIT=$(awk '/^MemTotal/ { print int($2 / 2500000) }' /proc/meminfo)
    if [ "$FIT" -lt "$JOBS" ]; then JOBS=$((FIT > 0 ? FIT : 1)); fi
fi

# The machine has no sound, and leaving the audio back ends out takes most of the libraries with them
mame_make() {
    $MAKE_TOOL SUBTARGET=maxine SOURCES="$SOURCES" REGENIE=$REGENIE \
        USE_LIBSDL=1 USE_PCAP=1 USE_QTDEBUG=0 NOWERROR=1 PTR64=1 \
        NO_USE_PULSEAUDIO=1 NO_USE_PIPEWIRE=1 NO_USE_PORTAUDIO=1 NO_USE_MIDI=1 \
        TOOLS=1 "$@"
}

# Even those jobs can run out of memory when the big files land together. A compile killed that way
# leaves its object missing, or empty so that make counts it as finished, and only the archive or link
# step fails. So the first pass carries on past failures, and the second builds what's left in turn.
if ! mame_make -k -j"$JOBS" "$@"; then
    echo "Retrying what failed, one file at a time"
    find build -name '*.o' -size -513c -delete
    REGENIE=0
    mame_make -j1 "$@"
fi
