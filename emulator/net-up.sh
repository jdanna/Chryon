#!/bin/sh
# Connects this Mac to the emulated MAXINE, once per reboot. The emulator takes one end of a virtual
# Ethernet cable and the Mac the other, so the unit is a real address at 10.37.0.2.
set -eu

[ "$(id -u)" -eq 0 ] || exec sudo "$0" "$@"

ifconfig feth0 >/dev/null 2>&1 || ifconfig feth0 create
ifconfig feth1 >/dev/null 2>&1 || ifconfig feth1 create
ifconfig feth0 peer feth1
ifconfig feth0 up
ifconfig feth1 inet 10.37.0.1 netmask 255.255.255.0 up

# Lets the emulator use feth0 without root
chgrp admin /dev/bpf*
chmod g+rw /dev/bpf*

echo "This Mac is 10.37.0.1 on feth1. Start the emulator and reach the MAXINE at 10.37.0.2."
