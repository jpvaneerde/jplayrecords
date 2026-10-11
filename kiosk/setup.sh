#!/bin/sh
# Turns a Raspberry Pi 4/5 with Raspberry Pi OS Lite (64-bit, Bookworm or newer) into the record-room screen.
#
#   curl -fsSL https://raw.githubusercontent.com/jpvaneerde/jplayrecords/main/kiosk/setup.sh -o setup.sh
#   sudo sh setup.sh 'https://records.jplay.cloud/d/<device-token>'
#
# Create the device link first: records.jplay.cloud → Settings → Kiosk screens.
set -eu

URL="${1:-}"
if [ -z "$URL" ]; then
  echo "Usage: sudo sh setup.sh '<device link from Settings → Kiosk screens>'" >&2
  exit 1
fi
ORIGIN=$(printf '%s' "$URL" | sed -E 's#^(https?://[^/]+).*#\1#')

apt-get update
apt-get install -y --no-install-recommends cage chromium curl fonts-noto-color-emoji

# A locked user just for the kiosk (no password, no sudo).
id kiosk >/dev/null 2>&1 || useradd -m -s /usr/sbin/nologin kiosk
usermod -aG video,render,input,audio kiosk

cat > /etc/default/jplayrecords-kiosk <<CONF
KIOSK_URL=$URL
HEALTH_URL=$ORIGIN/healthz
CONF
chmod 600 /etc/default/jplayrecords-kiosk

DIR=$(cd "$(dirname "$0")" && pwd)
if [ -f "$DIR/jplayrecords-kiosk.service" ]; then
  cp "$DIR/jplayrecords-kiosk.service" /etc/systemd/system/
else
  curl -fsSL https://raw.githubusercontent.com/jpvaneerde/jplayrecords/main/kiosk/jplayrecords-kiosk.service \
    -o /etc/systemd/system/jplayrecords-kiosk.service
fi

systemctl daemon-reload
systemctl set-default graphical.target
systemctl disable getty@tty1.service || true
systemctl enable jplayrecords-kiosk.service
echo "Done. Reboot (sudo reboot) and the screen opens JPlay Records."
echo "Logs: journalctl -u jplayrecords-kiosk -f · change the URL in /etc/default/jplayrecords-kiosk"
