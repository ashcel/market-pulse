#!/usr/bin/env bash
# Cron-driven liveness probe for the forward-test worker (P0.3). The in-app
# alert path is the SSE worker-health notification (src/server/health-watch.ts);
# this probe is the browser-independent forensic trail: it hits the same
# unauthenticated health view and logs anything non-ok to the journal + a file.
#
# Installed cron (crontab -l to confirm):
#   */10 * * * * /home/ubuntu/code/personal/market-pulse/deploy/health-check.sh
set -uo pipefail

URL="${MP_HEALTH_URL:-http://localhost:3002/api/forward-test?view=health}"
LOG="${MP_HEALTH_LOG:-/home/ubuntu/pg-backups/worker-health.log}"

BODY="$(curl -fsS --max-time 10 "$URL" 2>&1)" || {
  MSG="health endpoint unreachable: $BODY"
  logger -t market-pulse-health "$MSG"
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $MSG" >> "$LOG"
  exit 0
}

STATUS="$(printf '%s' "$BODY" | grep -oE '"status":"[a-z-]+"' | head -1 | cut -d'"' -f4)"
if [ "$STATUS" != "ok" ]; then
  MSG="worker health=$STATUS body=$BODY"
  logger -t market-pulse-health "$MSG"
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $MSG" >> "$LOG"
fi
