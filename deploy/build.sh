#!/usr/bin/env bash
# Install dependencies, build the engine and the web app, apply migrations.
set -euo pipefail
APP=/opt/zerobeat
cd "$APP"
set -a
# shellcheck disable=SC1091
. /etc/zerobeat/zerobeat.env
set +a
export NEXT_TELEMETRY_DISABLED=1
npm ci --include=dev --no-audit --no-fund
# Check before building: a type error or a failing test stops here, and the build that
# is running now stays in place. The tests run at the lowest CPU priority, with long
# timeouts and no speed budgets, so a live station keeps decoding while they run.
if ! npm run -s typecheck || ! ZEROBEAT_SKIP_SPEED=1 nice -n 19 npx vitest run --reporter=dot --testTimeout=120000; then
  echo "!!  checks failed: nothing was rebuilt; the running version is unchanged" >&2
  exit 1
fi
npm -w packages/engine run build
NODE_ENV=production npm -w apps/web run build
install -d -o zerobeat -g zerobeat "$APP/apps/web/.next/cache"
runuser -u zerobeat -- env ZEROBEAT_DB="$ZEROBEAT_DB" ZEROBEAT_MIGRATIONS="$ZEROBEAT_MIGRATIONS" node --import tsx scripts/migrate.ts
