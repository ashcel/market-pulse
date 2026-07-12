#!/usr/bin/env bash
# Daily pg_dump of the forward-test system of record (WS4 — "confirm backups").
# Talks TCP to the dockerized Postgres (localhost:5435) with the host's
# pg_dump, so it needs no docker-group membership. Credentials come from
# ~/.pgpass (chmod 600, line: localhost:5435:market_pulse:postgres:<password>)
# — never from this script or the crontab.
#
# Installed cron (crontab -l to confirm):
#   0 3 * * * /home/ubuntu/code/personal/market-pulse/deploy/pg-backup.sh >> /home/ubuntu/pg-backups/backup.log 2>&1
#
# Verify a restore occasionally:
#   createdb -h localhost -p 5435 -U postgres market_pulse_restore_test
#   gunzip -c /home/ubuntu/pg-backups/market_pulse-YYYY-MM-DD.sql.gz | psql -h localhost -p 5435 -U postgres market_pulse_restore_test
#   dropdb -h localhost -p 5435 -U postgres market_pulse_restore_test

set -euo pipefail

BACKUP_DIR="${MP_BACKUP_DIR:-/home/ubuntu/pg-backups}"
RETENTION_DAYS="${MP_BACKUP_RETENTION_DAYS:-14}"
DB_HOST="${MP_DB_HOST:-localhost}"
DB_PORT="${MP_DB_PORT:-5435}"
DB_NAME="${MP_DB_NAME:-market_pulse}"
DB_USER="${MP_DB_USER:-postgres}"

mkdir -p "$BACKUP_DIR"
STAMP="$(date -u +%Y-%m-%d)"
OUT="$BACKUP_DIR/market_pulse-$STAMP.sql.gz"

pg_dump --no-password -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" "$DB_NAME" | gzip > "$OUT"
echo "backed up $DB_NAME to $OUT ($(date -u +%Y-%m-%dT%H:%M:%SZ))"

find "$BACKUP_DIR" -name 'market_pulse-*.sql.gz' -mtime "+$RETENTION_DAYS" -delete
