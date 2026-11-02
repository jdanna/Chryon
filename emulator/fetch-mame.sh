#!/bin/sh
# Clones the pinned MAME commit into emulator/mame, or $MAXINE_MAME_DIR (gitignored).
# Master, not a release: the NCR53C710 model isn't in mame0289.
set -eu

COMMIT=1a8349fbf9a453069cf3f49c29d7117ddcf10fde
HERE=$(cd "$(dirname "$0")" && pwd)
MAME=${MAXINE_MAME_DIR:-$HERE/mame}

if [ -d "$MAME/.git" ]; then
    echo "$MAME already exists"
    exit 0
fi

git init "$MAME"
cd "$MAME"
git remote add origin https://github.com/mamedev/mame.git
git fetch --depth 1 origin "$COMMIT"
git checkout --detach FETCH_HEAD
