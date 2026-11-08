#!/usr/bin/env bash
# Zerobeat install for Debian 12/13. Run as root from a checkout at /opt/zerobeat:
#
#   git clone <repository> /opt/zerobeat
#   bash /opt/zerobeat/deploy/install.sh --lan       # plain HTTP on port 80, home network
#   bash /opt/zerobeat/deploy/install.sh --tunnel    # loopback only, HTTPS proxy in front
#   --client-ip-header=X-Forwarded-For  with --tunnel, when the proxy is not cloudflared
#                                       (default CF-Connecting-IP)
#
# Safe to re-run: never overwrites the environment file or the database. Re-running with
# the other option switches how the page is reached.
set -euo pipefail

APP=/opt/zerobeat
DATA=/var/lib/zerobeat
ENVF=/etc/zerobeat/zerobeat.env

usage() {
  sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}
say() { printf '\n==> %s\n' "$1"; }

MODE=""
IPHDR=""
for a in "$@"; do
  case "$a" in
    --lan) MODE=lan ;;
    --tunnel) MODE=tunnel ;;
    --client-ip-header=*) IPHDR="${a#*=}" ;;
    -h | --help) usage 0 ;;
    *) echo "unknown option: $a"; usage 1 ;;
  esac
done
if [ -z "$MODE" ]; then
  # A re-install keeps the choice made last time.
  if grep -qs 'listen 80 default_server' /etc/nginx/sites-available/zerobeat; then MODE=lan
  elif [ -f /etc/nginx/sites-available/zerobeat ]; then MODE=tunnel
  else echo "Choose how the page is reached: --lan or --tunnel"; echo; usage 1; fi
fi
# The tunnel's client-address header: as given, as last time, or cloudflared's.
if [ -z "$IPHDR" ]; then
  # On a first install there is no site yet; sed failing there is not an error.
  IPHDR=$( { sed -n 's/^real_ip_header \([A-Za-z0-9-]*\);$/\1/p' /etc/nginx/sites-available/zerobeat 2>/dev/null || true; } | head -1)
  IPHDR=${IPHDR:-CF-Connecting-IP}
fi
case "$IPHDR" in *[!A-Za-z0-9-]*) echo "--client-ip-header: letters, digits and - only"; exit 1 ;; esac

[ "$(id -u)" = 0 ] || { echo "run as root"; exit 1; }
[ -f "$APP/package.json" ] || { echo "expected the code at $APP (git clone <repository> $APP)"; exit 1; }
. /etc/os-release
case "${ID:-}" in
  debian | ubuntu) ;;
  *) echo "warning: written for Debian 12/13; this is ${PRETTY_NAME:-unknown}" ;;
esac

say "Packages"
apt-get update -qq
apt-get install -y -qq nginx chrony fontconfig fonts-dejavu-core ca-certificates curl git openssl >/dev/null
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
npm -v | grep -q '^1[1-9]\.' || npm i -g npm@11 >/dev/null 2>&1
# FT8 needs the clock right to about half a second.
systemctl enable --now chrony >/dev/null

say "User and directories"
id zerobeat >/dev/null 2>&1 || useradd --system --home-dir "$DATA" --shell /usr/sbin/nologin zerobeat
install -d -o zerobeat -g zerobeat -m 750 "$DATA" "$DATA/qsl" "$DATA/backups"
install -d -o root -g zerobeat -m 750 /etc/zerobeat

say "Environment"
if [ ! -f "$ENVF" ]; then
  sed -e "s|^ZEROBEAT_SECRET_KEY=.*|ZEROBEAT_SECRET_KEY=$(openssl rand -hex 32)|" \
      -e "s|^ENGINE_TOKEN=.*|ENGINE_TOKEN=$(openssl rand -hex 32)|" \
      "$APP/deploy/zerobeat.env.example" > "$ENVF"
  echo "    wrote $ENVF with fresh keys: keep a copy of ZEROBEAT_SECRET_KEY somewhere safe"
else
  echo "    keeping $ENVF"
fi
chown root:zerobeat "$ENVF"
chmod 640 "$ENVF"

say "Build (a few minutes)"
bash "$APP/deploy/build.sh"

say "Services"
install -m 644 "$APP/deploy/systemd/zerobeat-engine.service" /etc/systemd/system/
install -m 644 "$APP/deploy/systemd/zerobeat-web.service" /etc/systemd/system/
if [ "$MODE" = lan ]; then
  listen='    listen 80 default_server;\n    listen [::]:80 default_server;'
  proto='$scheme'
  realip=''
else
  listen='    listen 127.0.0.1:80 default_server;\n    listen [::1]:80 default_server;'
  proto='https'
  realip="set_real_ip_from 127.0.0.1;\nset_real_ip_from ::1;\nreal_ip_header $IPHDR;"
fi
sed -e "s|^@LISTEN@$|$listen|" -e "s|@PROTO@|$proto|" -e "s|^@REALIP@$|$realip|" "$APP/deploy/nginx/zerobeat.conf" > /etc/nginx/sites-available/zerobeat
chmod 644 /etc/nginx/sites-available/zerobeat
ln -sf /etc/nginx/sites-available/zerobeat /etc/nginx/sites-enabled/zerobeat
rm -f /etc/nginx/sites-enabled/default
# nginx keeps large request bodies (an SSTV picture) in temp folders that its workers must
# own; on one install they were left to "nobody" and every upload failed with a 500.
ngx_user=$(awk '$1 == "user" { sub(";", "", $2); print $2; exit }' /etc/nginx/nginx.conf)
for d in body proxy fastcgi scgi uwsgi; do
  if [ -d "/var/lib/nginx/$d" ]; then chown "${ngx_user:-www-data}:root" "/var/lib/nginx/$d"; fi
done
nginx -t -q
systemctl daemon-reload
systemctl enable zerobeat-engine zerobeat-web >/dev/null
systemctl restart zerobeat-engine zerobeat-web
# A restart, not a reload: a reload cannot move a listening socket from every interface
# to loopback, and nginx then keeps the old one without saying so.
systemctl restart nginx

say "Checking"
ok=""
for _ in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:3000/api/health >/dev/null 2>&1; then ok=1; break; fi
  sleep 2
done
if [ -z "$ok" ]; then
  echo "    the web app did not answer; see: journalctl -u zerobeat-web -u zerobeat-engine -n 50"
  exit 1
fi
echo "    healthy"
# What nginx is really listening on must match the choice.
addrs=$(ss -Hltn "sport = :80" | awk '{print $4}' | sort -u | tr '\n' ' ')
if [ "$MODE" = tunnel ]; then
  for a in $addrs; do
    case "$a" in 127.0.0.1:80 | "[::1]:80") ;; *) echo "    nginx is listening on $a, not loopback only: check /etc/nginx for other sites"; exit 1 ;; esac
  done
else
  case " $addrs" in *" 0.0.0.0:80 "* | *" *:80 "*) ;; *) echo "    nginx is not listening on every interface ($addrs)"; exit 1 ;; esac
fi
echo "    nginx on $addrs"

say "Done"
if [ "$MODE" = lan ]; then
  for ip in $(hostname -I); do case "$ip" in *:*) ;; *) echo "    Open http://$ip/" ;; esac; done
  echo "    Plain HTTP: keep it on your own network and never forward port 80 from the internet."
  echo "    For use away from home, re-run with --tunnel behind Cloudflare Tunnel or Tailscale."
else
  echo "    nginx is on http://127.0.0.1:80 only. Point your tunnel or HTTPS proxy at it."
fi
echo "    The first visit creates the administrator account and your station."
