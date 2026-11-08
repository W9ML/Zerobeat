#!/usr/bin/env bash
# Let the engine drive a radio plugged into this machine: an ICOM on USB, or any radio
# through Hamlib (Yaesu, Kenwood, Elecraft, Xiegu…).
#
# Installs the ALSA tools for the radio's sound card and Hamlib's rigctld, and a systemd
# drop-in that gives the engine the serial ports and sound cards and nothing else under
# /dev. Without it the engine runs with a private /dev, which is right for a FlexRadio or
# an ICOM on the network.
# Undo: rm /etc/systemd/system/zerobeat-engine.service.d/local-radio.conf && systemctl daemon-reload
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 1; }

apt-get install -y -qq alsa-utils libhamlib-utils >/dev/null
install -d /etc/systemd/system/zerobeat-engine.service.d
rm -f /etc/systemd/system/zerobeat-engine.service.d/icom.conf
install -m 644 /opt/zerobeat/deploy/systemd/engine-local-radio.conf /etc/systemd/system/zerobeat-engine.service.d/local-radio.conf
systemctl daemon-reload
systemctl restart zerobeat-engine

echo "Hamlib: $(rigctld -V 2>/dev/null | head -1)"
echo "  Find your radio's model number: rigctl -l | grep -i <name>"
echo
echo "Serial ports (use a /dev/serial/by-id path in Settings → Radio if there is one):"
ls -l /dev/serial/by-id/ 2>/dev/null || ls -l /dev/ttyACM* /dev/ttyUSB* 2>/dev/null || echo "  none: is the radio on, its USB cable connected, and the device passed through to this VM?"
echo
echo "Sound cards:"
arecord -l 2>/dev/null | grep -E '^card' || echo "  none found"
