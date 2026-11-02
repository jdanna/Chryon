#!/bin/sh
# Builds the small ffmpeg that writes video captures, into emulator/ffmpeg, or $MAXINE_FFMPEG_DIR
# (gitignored). It has only ProRes and what feeds it, so it needs no other libraries and stays LGPL:
# leave out --enable-gpl, because that would change the licence of what the app ships.
# MAXINE_TARGET=windows cross-compiles it, in emulator/Dockerfile.windows.
set -eu

# Tag n7.1.5
COMMIT=3a0867c2bfda4a4d4309ca1a8cbdc6175e67f587
HERE=$(cd "$(dirname "$0")" && pwd)
OUT=${MAXINE_FFMPEG_DIR:-$HERE/ffmpeg}
SRC=$OUT/src

set -- --disable-everything --disable-autodetect --disable-doc --disable-debug --disable-network \
    --disable-ffplay --disable-ffprobe --disable-avdevice \
    --enable-protocol=pipe,file --enable-demuxer=rawvideo --enable-decoder=rawvideo \
    --enable-encoder=prores_ks --enable-muxer=mov \
    --enable-filter=split,scale,format,setparams,setsar,alphaextract

BINARY=ffmpeg
if [ "${MAXINE_TARGET:-}" = windows ]; then
    BINARY=ffmpeg.exe
    set -- "$@" --enable-cross-compile --target-os=mingw32 --arch=x86_64 \
        --cross-prefix=x86_64-w64-mingw32- --extra-ldflags=-static
fi

# Assembly only speeds it up. The packaged builds have nasm in their images.
command -v nasm >/dev/null || set -- "$@" --disable-x86asm

KEY="$COMMIT $*"
if [ -f "$OUT/$BINARY" ] && [ "$KEY" = "$(cat "$OUT/.build-key" 2>/dev/null)" ]; then
    echo "$OUT/$BINARY is up to date"
    exit 0
fi

# A fetch that failed leaves .git behind, so only a checked out tree counts as done
if [ ! -f "$SRC/configure" ]; then
    rm -rf "$SRC"
    mkdir -p "$SRC"
    git init -q "$SRC"
    git -C "$SRC" remote add origin https://github.com/FFmpeg/FFmpeg.git
    git -C "$SRC" fetch -q --depth 1 origin "$COMMIT"
    git -C "$SRC" checkout -q --detach FETCH_HEAD
fi

cd "$SRC"
./configure "$@"
make -j"$(getconf _NPROCESSORS_ONLN)"

cp "$BINARY" "$OUT/$BINARY"

{
    echo "This app ships ffmpeg, under the LGPL version 2.1 or later, as a separate program."
    echo "Source: https://github.com/FFmpeg/FFmpeg/tree/$COMMIT (tag n7.1.5)"
    echo "Configured with: $*"
} > "$OUT/FFMPEG-NOTICE.txt"
cp COPYING.LGPLv2.1 "$OUT/FFMPEG-LICENSE.txt"
echo "$KEY" > "$OUT/.build-key"
