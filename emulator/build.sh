#!/bin/sh
# Overlays emulator/src on the MAME checkout and builds the single-driver binary.
# Driver-local devices live next to the driver in src/mame/chyron, so no MAME
# build scripts need patching; only the driver list gets one section added.
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
MAME=$HERE/mame

[ -d "$MAME/.git" ] || "$HERE/fetch-mame.sh"

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
BUILD_KEY="$SOURCES pcap"
REGENIE=0
if [ "$BUILD_KEY" != "$(cat .maxine-sources 2>/dev/null)" ]; then
    REGENIE=1
    echo "$BUILD_KEY" > .maxine-sources
fi

make -j"$(sysctl -n hw.ncpu)" \
    SUBTARGET=maxine SOURCES="$SOURCES" REGENIE=$REGENIE \
    USE_LIBSDL=1 USE_PCAP=1 NOWERROR=1 PTR64=1 \
    TOOLS=1 "$@"
