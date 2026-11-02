#!/bin/sh
# Removes the virtual Ethernet link that net-up.sh made. Stop the emulator first.
set -eu

[ "$(id -u)" -eq 0 ] || exec sudo "$0" "$@"

if [ "$(uname -s)" = Linux ]; then
    OWNER=${SUDO_UID:-${PKEXEC_UID:-$(id -u)}}
    TAP=tap-mess-$OWNER-0
    ip link show "$TAP" >/dev/null 2>&1 && ip link delete "$TAP"
    echo "Removed $TAP."
    exit 0
fi

ifconfig feth1 >/dev/null 2>&1 && ifconfig feth1 destroy
ifconfig feth0 >/dev/null 2>&1 && ifconfig feth0 destroy
echo "Removed feth0 and feth1."
