#!/bin/sh
# Runs the emulator. Extra arguments go to MAME. State stays in emulator/run (gitignored).
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
ORIGINAL=$HERE/roms/maxine-v11.01.chd
DEFAULT=$HERE/roms/maxine-default.chd
CHD=$HERE/run/disk.chd

# The firmware writes to its disk, so it runs on a copy. Delete run/disk.chd to start over, from
# the local default if there is one, or the archive image.
mkdir -p "$HERE/run"
if [ ! -f "$CHD" ]; then
    [ -f "$DEFAULT" ] && ORIGINAL=$DEFAULT
    cp "$ORIGINAL" "$CHD"
    chmod u+w "$CHD"
fi

cd "$HERE/run"
exec "$HERE/mame/maxine" maxine \
    -rompath "$HERE/roms" \
    -hard "$CHD" \
    -nvram_directory nvram -cfg_directory cfg \
    -artpath "$HERE/artwork" -plugin layout -pluginspath "$HERE/mame/plugins" -homepath "$HERE/mame" \
    -window -skip_gameinfo -nomouse \
    "$@"
