#!/usr/bin/env bash
# Decrypt and restore one database dump and, optionally, one frontend archive.
set -euo pipefail
umask 077

if (( $# < 1 || $# > 2 )); then
  printf 'Usage: %s DB_DUMP.gpg [FRONTEND.tar.gpg]\n' "$0" >&2
  exit 2
fi

DB_DUMP="$1"
WEB_DUMP="${2:-}"
DB_HOST="${MP_DB_HOST:-localhost}"
DB_PORT="${MP_DB_PORT:-5435}"
DB_USER="${MP_DB_USER:-postgres}"
DB_NAME="${MP_RESTORE_DB_NAME:-market_pulse_restore}"
PROJECT_DIR="${MP_PROJECT_DIR:-$HOME/code/personal/market-pulse}"

if [[ "$DB_NAME" == "market_pulse" && "${MP_ALLOW_PRODUCTION_RESTORE:-}" != "yes" ]]; then
  printf 'Refusing source DB restore. Set MP_RESTORE_DB_NAME or explicitly set MP_ALLOW_PRODUCTION_RESTORE=yes.\n' >&2
  exit 1
fi

gpg --batch --decrypt "$DB_DUMP" | pg_restore --no-owner --no-privileges \
  --clean --if-exists --host="$DB_HOST" --port="$DB_PORT" --username="$DB_USER" \
  --dbname="$DB_NAME"

if [[ -n "$WEB_DUMP" ]]; then
  rm -rf "$PROJECT_DIR/frontend/.output"
  gpg --batch --decrypt "$WEB_DUMP" | tar -C "$PROJECT_DIR/frontend" -xf -
fi

printf 'Restore complete: database=%s\n' "$DB_NAME"
