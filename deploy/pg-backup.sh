#!/usr/bin/env bash
# Daily pg_dump of the forward-test system of record (WS4 — "confirm backups").
# Not run automatically by this repo; install the cron line below yourself.
#
#   crontab -e
#   0 3 * * * /home/ubuntu/code/personal/market-pulse/deploy/pg-backup.sh >> /home/ubuntu/pg-backups/backup.log 2>&1
#
# Restores are on you too — verify one occasionally:
#   gunzip -c /home/ubuntu/pg-backups/market_pulse-YYYY-MM-DD.sql.gz | psql "$DATABASE_URL"

set -euo pipefail

BACKUP_DIR="${MP_BACKUP_DIR:-/home/ubuntu/pg-backups}"
RETENTION_DAYS="${MP_BACKUP_RETENTION_DAYS:-14}"
CONTAINER="${MP_DB_CONTAINER:-market-pulse-db}"
DB_NAME="${MP_DB_NAME:-market_pulse}"
DB_USER="${MP_DB_USER:-postgres}"

mkdir -p "$BACKUP_DIR"
STAMP="$(date -u +%Y-%m-%d)"
OUT="$BACKUP_DIR/market_pulse-$STAMP.sql.gz"

docker exec "$CONTAINER" pg_dump -U "$DB_USER" "$DB_NAME" | gzip > "$OUT"
echo "backed up $DB_NAME to $OUT ($(date -u +%Y-%m-%dT%H:%M:%SZ))"

find "$BACKUP_DIR" -name 'market_pulse-*.sql.gz' -mtime "+$RETENTION_DAYS" -delete
