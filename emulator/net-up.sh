#!/bin/sh
# Connects this computer to the emulated MAXINE, once per reboot. The emulator takes one end of a
# virtual Ethernet cable and the computer the other, so the unit is a real address at 10.37.0.2.
set -eu

[ "$(id -u)" -eq 0 ] || exec sudo "$0" "$@"

if [ "$(uname -s)" = Linux ]; then
    # MAME opens the TAP named after the user running it, and that user has to own it
    OWNER=${SUDO_UID:-${PKEXEC_UID:-$(id -u)}}
    TAP=tap-mess-$OWNER-0
    ip link show "$TAP" >/dev/null 2>&1 || ip tuntap add dev "$TAP" mode tap user "$OWNER"
    ip addr replace 10.37.0.1/24 dev "$TAP"
    ip link set "$TAP" up
    echo "This computer is 10.37.0.1 on $TAP. Start the emulator and reach the MAXINE at 10.37.0.2."
    exit 0
fi

ifconfig feth0 >/dev/null 2>&1 || ifconfig feth0 create
ifconfig feth1 >/dev/null 2>&1 || ifconfig feth1 create
ifconfig feth0 peer feth1
ifconfig feth0 up
ifconfig feth1 inet 10.37.0.1 netmask 255.255.255.0 up

# Lets the emulator use feth0 without root
chgrp admin /dev/bpf*
chmod g+rw /dev/bpf*

echo "This Mac is 10.37.0.1 on feth1. Start the emulator and reach the MAXINE at 10.37.0.2."
