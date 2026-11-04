#!/usr/bin/env bash
# Classroom360 camera gateway: installs MediaMTX and the access checker on the parent Raspberry Pi.
#
#   sudo bash install.sh https://YOUR-PROJECT.supabase.co YOUR_PUBLISHABLE_KEY
#
# Safe to run again: it updates the program files and keeps your edited settings
# (/etc/classroom360/mediamtx.yml and camera-gateway.env).
#
# For testing without a Pi:  DESTDIR=/tmp/pi-root NO_SYSTEMD=1 ./install.sh URL KEY
set -euo pipefail

MEDIAMTX_VERSION="v1.21.0"
# sha256 of the release files, from https://github.com/bluenviron/mediamtx/releases/tag/v1.21.0
declare -A SHA256=(
  [amd64]="e02e34c3337a35f20ac9e5aa31524566108964e6e37dbc46cf8292169f6c792b"
  [arm64]="a8113b5928ba1a934b81557b61b8a07954b76921a4b567d54c7f086f8b39d9a2"
  [armv7]="b697706a572742665433a77e9403e94e874ae4a3b1144a574875904a332414bc"
  [armv6]="6884e1f26856a065e57a69f0423a55b79198a4b45b6deeed8661284d3cfb2914"
)

DESTDIR="${DESTDIR:-}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUPABASE_URL="${1:-${SUPABASE_URL:-}}"
SUPABASE_ANON_KEY="${2:-${SUPABASE_ANON_KEY:-}}"

die() { echo "Error: $*" >&2; exit 1; }

[[ -z "$DESTDIR" && $EUID -ne 0 ]] && die "run this with sudo."
[[ "$SUPABASE_URL" =~ ^https?://[^/[:space:]]+$ ]] || die "give the Supabase project address first, for example: sudo bash install.sh https://abcd1234.supabase.co YOUR_PUBLISHABLE_KEY"
[[ -n "$SUPABASE_ANON_KEY" ]] || die "give the publishable (anon) key as the second argument."
[[ "$SUPABASE_ANON_KEY" == sb_secret_* || "$SUPABASE_ANON_KEY" == *service_role* ]] && die "that looks like a SECRET key. The Pi only needs the publishable (anon) key."

case "$(uname -m)" in
  x86_64)        ARCH=amd64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  armv7l)        ARCH=armv7 ;;
  armv6l)        ARCH=armv6 ;;
  *) die "unsupported processor: $(uname -m)" ;;
esac

OPT="$DESTDIR/opt/classroom360"
ETC="$DESTDIR/etc/classroom360"
UNITS="$DESTDIR/etc/systemd/system"

echo "Downloading MediaMTX $MEDIAMTX_VERSION ($ARCH)..."
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
FILE="mediamtx_${MEDIAMTX_VERSION}_linux_${ARCH}.tar.gz"
URL="${MEDIAMTX_URL:-https://github.com/bluenviron/mediamtx/releases/download/${MEDIAMTX_VERSION}/${FILE}}"
curl -fsSL --retry 3 -o "$TMP/$FILE" "$URL" || die "could not download $URL"
echo "${SHA256[$ARCH]}  $TMP/$FILE" | sha256sum -c --status - || die "the download does not match its checksum. Nothing was installed."
tar -xzf "$TMP/$FILE" -C "$TMP" mediamtx

if [[ -z "$DESTDIR" ]]; then
  id -u classroom360 >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin classroom360
fi
mkdir -p "$OPT" "$ETC" "$UNITS"

install -m 0755 "$TMP/mediamtx" "$OPT/mediamtx"
install -m 0644 "$HERE/camera_auth.py" "$OPT/camera_auth.py"
install -m 0644 "$HERE/systemd/classroom360-mediamtx.service" "$UNITS/classroom360-mediamtx.service"
install -m 0644 "$HERE/systemd/classroom360-camera-auth.service" "$UNITS/classroom360-camera-auth.service"

# settings: written once, then left alone so your edits survive an update
if [[ ! -e "$ETC/mediamtx.yml" ]]; then install -m 0640 "$HERE/mediamtx.yml" "$ETC/mediamtx.yml"; echo "Created $ETC/mediamtx.yml (add your cameras there)."; else echo "Kept your $ETC/mediamtx.yml."; fi
umask 077
cat > "$ETC/camera-gateway.env.new" <<ENV
SUPABASE_URL=$SUPABASE_URL
SUPABASE_ANON_KEY=$SUPABASE_ANON_KEY
AUTH_LISTEN=127.0.0.1:9120
ALLOW_LOCAL_PUBLISH=1
CACHE_SECONDS=60
ENV
mv "$ETC/camera-gateway.env.new" "$ETC/camera-gateway.env"
chmod 0640 "$ETC/camera-gateway.env" "$ETC/mediamtx.yml"
if [[ -z "$DESTDIR" ]]; then chown root:classroom360 "$ETC/camera-gateway.env" "$ETC/mediamtx.yml"; fi

if [[ -z "${NO_SYSTEMD:-}" ]]; then
  systemctl daemon-reload
  systemctl enable --now classroom360-camera-auth.service
  systemctl enable classroom360-mediamtx.service
  systemctl restart classroom360-mediamtx.service
  sleep 2
  systemctl --no-pager --lines=0 status classroom360-camera-auth.service classroom360-mediamtx.service || true
fi

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
ADDR="${IP:-the-address-of-this-Pi}"
cat <<DONE

Installed. Next:
  1. Add each camera to $ETC/mediamtx.yml (examples are in the file), then:
       sudo systemctl restart classroom360-mediamtx
  2. In the Classroom360 web app, open Cameras, choose Add camera and enter:
       Gateway address: http://${ADDR}:8889
       Stream name:     the name you gave the camera in mediamtx.yml (for example lrc-301)
  3. Allow ports 8889/tcp and 8189/udp+tcp on this Pi's firewall if it has one.
DONE
