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

# The MVME162's 82596 needs byte order and framing MAME doesn't have
for PATCH in "$HERE"/patches/*.patch; do
    git -C "$MAME" apply --reverse --check "$PATCH" 2>/dev/null || git -C "$MAME" apply "$PATCH"
done

if ! grep -q '@source:chyron/maxine.cpp' "$MAME/src/mame/mame.lst"; then
    printf '\n@source:chyron/maxine.cpp\nmaxine\n' >> "$MAME/src/mame/mame.lst"
fi

cd "$MAME"

SOURCES=$(cd src/mame && ls chyron/*.cpp | paste -sd , -)
BUILD_KEY="$SOURCES pcap nosound"
REGENIE=0
if [ "$BUILD_KEY" != "$(cat .maxine-sources 2>/dev/null)" ]; then
    REGENIE=1
    echo "$BUILD_KEY" > .maxine-sources
    # Make doesn't notice changed defines, so old OSD objects would still want the libraries left out
    find build \( -path '*/src/osd' -o -name 'libosd_*' \) -prune -exec rm -rf {} + 2>/dev/null || true
fi

# Some MAME files take over 2.5 GB to compile. One killed for memory leaves an empty object that make
# counts as finished, and the link then fails, so a small machine or Docker VM runs fewer jobs.
JOBS=$(getconf _NPROCESSORS_ONLN)
if [ -r /proc/meminfo ]; then
    FIT=$(awk '/^MemTotal/ { print int($2 / 2500000) }' /proc/meminfo)
    if [ "$FIT" -lt "$JOBS" ]; then JOBS=$((FIT > 0 ? FIT : 1)); fi
fi

# The machine has no sound, and leaving the audio back ends out takes most of the libraries with them
make -j"$JOBS" \
    SUBTARGET=maxine SOURCES="$SOURCES" REGENIE=$REGENIE \
    USE_LIBSDL=1 USE_PCAP=1 USE_QTDEBUG=0 NOWERROR=1 PTR64=1 \
    NO_USE_PULSEAUDIO=1 NO_USE_PIPEWIRE=1 NO_USE_PORTAUDIO=1 NO_USE_MIDI=1 \
    TOOLS=1 "$@"
