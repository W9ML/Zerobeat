#!/usr/bin/env bash
# Update to the latest commit: back up, pull, build, migrate, restart.
#   sudo bash /opt/zerobeat/deploy/update.sh
set -euo pipefail
APP=/opt/zerobeat
DATA=/var/lib/zerobeat
cd "$APP"

stamp=$(date -u +%Y%m%d-%H%M%S)
echo "==> Backing up the database"
runuser -u zerobeat -- node -e "
  const D = require('better-sqlite3');
  new D('$DATA/zerobeat.db', { readonly: true }).backup('$DATA/backups/pre-update-$stamp.db').then(() => console.log('    $DATA/backups/pre-update-$stamp.db'));
"

echo "==> Pulling"
before=$(git rev-parse --short HEAD)
git fetch -q origin
git reset -q --hard origin/main
after=$(git rev-parse --short HEAD)
echo "    $before -> $after"

echo "==> Building"
bash "$APP/deploy/build.sh"

echo "==> Restarting"
systemctl restart zerobeat-engine zerobeat-web
sleep 3
systemctl is-active zerobeat-engine zerobeat-web
curl -fsS http://127.0.0.1:3000/api/health && echo
