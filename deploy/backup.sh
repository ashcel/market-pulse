#!/usr/bin/env bash
# Encrypted nightly PostgreSQL + frontend build backup.
set -euo pipefail
umask 077

BACKUP_DIR="${MP_BACKUP_DIR:-$HOME/market-pulse-backups}"
PROJECT_DIR="${MP_PROJECT_DIR:-$HOME/code/personal/market-pulse}"
DB_HOST="${MP_DB_HOST:-localhost}"
DB_PORT="${MP_DB_PORT:-5435}"
DB_NAME="${MP_DB_NAME:-market_pulse}"
DB_USER="${MP_DB_USER:-postgres}"
GPG_RECIPIENT="${MP_BACKUP_GPG_RECIPIENT:?Set MP_BACKUP_GPG_RECIPIENT}"
BACKUP_HOST="${MP_BACKUP_HOST:-}"
BACKUP_REMOTE_DIR="${MP_BACKUP_REMOTE_DIR:-market-pulse}"
STAMP="$(date -u +%Y-%m-%dT%H%M%SZ)"
DAILY_DIR="$BACKUP_DIR/daily"
WEEKLY_DIR="$BACKUP_DIR/weekly"

mkdir -p "$DAILY_DIR" "$WEEKLY_DIR"

DB_OUT="$DAILY_DIR/market-pulse-db-$STAMP.dump.gpg"
WEB_OUT="$DAILY_DIR/market-pulse-frontend-$STAMP.tar.gpg"
pg_dump --no-password --format=custom --host="$DB_HOST" --port="$DB_PORT" \
  --username="$DB_USER" "$DB_NAME" | gpg --batch --yes --encrypt \
  --recipient "$GPG_RECIPIENT" --output "$DB_OUT"

tar -C "$PROJECT_DIR/frontend" -cf - .output | gpg --batch --yes --encrypt \
  --recipient "$GPG_RECIPIENT" --output "$WEB_OUT"

if [[ "$(date -u +%u)" == "7" ]]; then
  cp "$DB_OUT" "$WEEKLY_DIR/"
  cp "$WEB_OUT" "$WEEKLY_DIR/"
fi

mapfile -t daily_files < <(ls -1t "$DAILY_DIR"/*.gpg 2>/dev/null || true)
(( ${#daily_files[@]} <= 14 )) || rm -- "${daily_files[@]:14}"
mapfile -t weekly_files < <(ls -1t "$WEEKLY_DIR"/*.gpg 2>/dev/null || true)
(( ${#weekly_files[@]} <= 8 )) || rm -- "${weekly_files[@]:8}"

if [[ -n "$BACKUP_HOST" ]]; then
  scp -- "$DB_OUT" "$WEB_OUT" "$BACKUP_HOST:$BACKUP_REMOTE_DIR/daily/"
fi

printf 'Backup complete: %s\n' "$STAMP"
