#!/bin/sh
# Copies the shared libraries a Linux program needs into a folder, except the ones to leave to the system:
# glibc and the GCC runtime, the graphics drivers, and whatever Electron needs anyway, because a
# bundled copy of those can clash with what the system's graphics drivers load.
set -eu

BIN=$1
OUT=$2
mkdir -p "$OUT"

ldd "$BIN" | awk '/=> \//{print $3}' | while read -r LIB; do
    NAME=$(basename "$LIB")
    case $NAME in
        ld-linux*|libanl.*|libc.so*|libdl.*|libm.so*|libnsl.*|libpthread.*|libresolv.*|librt.*|libutil.*) continue ;;
        libgcc_s.*|libstdc++.*) continue ;;
        libEGL*|libGL*|libOpenGL*|libdrm.*|libgbm.*|libglapi.*) continue ;;
        libX*|libwayland*|libxcb*|libxkbcommon*) continue ;;
        libasound.*|libdbus-1.*|libexpat.*|libfontconfig.*|libfreetype.*|libgio-*|libglib-*|libgobject-*) continue ;;
        libharfbuzz.*|libpng16.*|libsystemd.*|libudev.*|libz.so*) continue ;;
    esac
    cp -L "$LIB" "$OUT/$NAME"
done
