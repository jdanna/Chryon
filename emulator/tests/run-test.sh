#!/bin/sh
# Headless boot check. Prints PASS or FAIL and exits non-zero on failure.
set -u

HERE=$(cd "$(dirname "$0")/.." && pwd)
RESULT=$("$HERE/run.sh" -video none -sound none -nothrottle -seconds_to_run 40 \
    -autoboot_script "$HERE/tests/boot.lua" 2>&1 | grep -E 'PASS|FAIL')
echo "${RESULT:-FAIL: no result}"
case "$RESULT" in PASS*) exit 0 ;; *) exit 1 ;; esac
