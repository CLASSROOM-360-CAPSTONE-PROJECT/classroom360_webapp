#!/usr/bin/env bash
# Classroom360 locker station: installs the locker program on the locker's Raspberry Pi.
#
#   sudo bash install.sh https://YOUR-PROJECT.supabase.co
#
# It asks for the project's SECRET key (the "secret" or "service_role" key from Supabase, Settings > API
# keys). That key stays on this Pi in /etc/classroom360/locker.env, readable only by root and the service.
# To skip the question:  sudo SUPABASE_SERVICE_KEY=... bash install.sh https://...
#
# Safe to run again: it updates the program and keeps your settings (/etc/classroom360/locker.json and locker.env).
#
# For testing without a Pi:  DESTDIR=/tmp/pi-root NO_SYSTEMD=1 NO_PIP=1 SUPABASE_SERVICE_KEY=sb_secret_x ./install.sh URL
set -euo pipefail

DESTDIR="${DESTDIR:-}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUPABASE_URL="${1:-${SUPABASE_URL:-}}"
KEY="${SUPABASE_SERVICE_KEY:-}"

die() { echo "Error: $*" >&2; exit 1; }

[[ -z "$DESTDIR" && $EUID -ne 0 ]] && die "run this with sudo."
[[ "$SUPABASE_URL" =~ ^https?://[^/[:space:]]+$ ]] || die "give the Supabase project address first, for example: sudo bash install.sh https://abcd1234.supabase.co"

if [[ -z "$KEY" && ! -e "$DESTDIR/etc/classroom360/locker.env" ]]; then
  [[ -t 0 ]] || die "set SUPABASE_SERVICE_KEY, or run this in a terminal so it can ask for the key."
  read -rsp "Paste the project's SECRET key (nothing is shown as you type): " KEY; echo
fi
if [[ -n "$KEY" ]]; then
  [[ "$KEY" == sb_publishable_* ]] && die "that is the PUBLISHABLE key. The locker needs the SECRET key (or the old service_role key)."
  if [[ "$KEY" == eyJ* ]]; then
    role="$(python3 -c 'import base64,json,sys; p=sys.argv[1].split(".")[1]; print(json.loads(base64.urlsafe_b64decode(p+"="*(-len(p)%4))).get("role",""))' "$KEY" 2>/dev/null || true)"
    [[ "$role" == "service_role" ]] || die "that key is not the service_role key (it says '${role:-unknown}'). Use the secret key."
  elif [[ "$KEY" != sb_secret_* ]]; then
    die "that does not look like a Supabase secret key (it should start with sb_secret_ or eyJ)."
  fi
fi

OPT="$DESTDIR/opt/classroom360"
ETC="$DESTDIR/etc/classroom360"
UNITS="$DESTDIR/etc/systemd/system"

if [[ -z "$DESTDIR" ]]; then
  id -u classroom360 >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin classroom360
  # the service reads the GPIO pins, the SPI reader, the I2C display and a USB reader through these groups
  for g in gpio spi i2c input; do getent group "$g" >/dev/null && usermod -aG "$g" classroom360 || true; done
fi
mkdir -p "$OPT/locker" "$ETC" "$UNITS"

rm -rf "$OPT/locker/locker_station"
cp -r "$HERE/locker_station" "$OPT/locker/locker_station"
find "$OPT/locker/locker_station" -name __pycache__ -prune -exec rm -rf {} +
chmod -R go-w "$OPT/locker"
install -m 0644 "$HERE/systemd/classroom360-locker.service" "$UNITS/classroom360-locker.service"

if [[ -z "${NO_PIP:-}" ]]; then
  echo "Installing the Python parts (this takes a few minutes the first time)..."
  command -v apt-get >/dev/null && apt-get install -y python3-venv python3-gpiozero python3-lgpio python3-smbus i2c-tools >/dev/null || true
  [[ -d "$OPT/locker-venv" ]] || python3 -m venv --system-site-packages "$OPT/locker-venv"
  "$OPT/locker-venv/bin/pip" install --quiet --upgrade mfrc522 RPLCD smbus2 evdev
  if grep -qs "Raspberry Pi 5" /proc/device-tree/model 2>/dev/null; then
    echo "Raspberry Pi 5 detected: switching the GPIO library to rpi-lgpio."
    "$OPT/locker-venv/bin/pip" uninstall -y --quiet RPi.GPIO || true
    "$OPT/locker-venv/bin/pip" install --quiet rpi-lgpio
  fi
fi

if [[ ! -e "$ETC/locker.json" ]]; then
  sed "s#https://YOUR-PROJECT.supabase.co#$SUPABASE_URL#" "$HERE/config.example.json" > "$ETC/locker.json"
  chmod 0644 "$ETC/locker.json"
  echo "Created $ETC/locker.json. Open it and check the station name and the pins."
else
  echo "Kept your $ETC/locker.json."
fi
if [[ -n "$KEY" ]]; then
  umask 077
  printf 'SUPABASE_SERVICE_KEY=%s\n' "$KEY" > "$ETC/locker.env.new"
  mv "$ETC/locker.env.new" "$ETC/locker.env"
  [[ -z "$DESTDIR" ]] && chgrp classroom360 "$ETC/locker.env" && chmod 0640 "$ETC/locker.env"
  echo "Saved the secret key to $ETC/locker.env (only root and the service can read it)."
else
  echo "Kept your $ETC/locker.env."
fi

if [[ -z "${NO_SYSTEMD:-}" && -z "$DESTDIR" ]]; then
  systemctl daemon-reload
  systemctl enable classroom360-locker.service >/dev/null
  echo
  echo "Installed. Before starting it, check the settings and the database:"
  echo "  sudo -u classroom360 env \$(cat /etc/classroom360/locker.env) /opt/classroom360/locker-venv/bin/python -m locker_station --config /etc/classroom360/locker.json check"
  echo "Then:  sudo systemctl start classroom360-locker"
else
  echo "(test install under $DESTDIR: systemd not touched)"
fi
