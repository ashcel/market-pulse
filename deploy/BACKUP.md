# Backup And Restore

`backup.sh` creates encrypted PostgreSQL and frontend `.output/` snapshots. It keeps seven daily sets and four Sunday weekly sets. Database credentials come from `~/.pgpass`; secrets are never command arguments.

## Prerequisites

- Install `postgresql-client`, `gpg`, `tar`, and optionally `scp`.
- Import the backup recipient's public GPG key. Keep its private key offline and test decryption before scheduling backups.
- Set `chmod 600 ~/.pgpass`; example: `localhost:5435:market_pulse:postgres:PASSWORD`.
- Build `frontend/.output/` before backup.
- For remote uploads, create `$MP_BACKUP_REMOTE_DIR/daily` on the destination and configure key-based SSH.

## Run

```bash
export MP_BACKUP_GPG_RECIPIENT='backup@example.com'
export MP_BACKUP_HOST='backup-user@backup-host' # optional; omit for local only
export MP_BACKUP_REMOTE_DIR='/srv/backups/market-pulse'
./deploy/backup.sh
```

Nightly cron example (run as the application user):

```cron
0 3 * * * MP_BACKUP_GPG_RECIPIENT=backup@example.com /home/ubuntu/code/personal/market-pulse/deploy/backup.sh >> /home/ubuntu/market-pulse-backups/backup.log 2>&1
```

## Restore Test

Create an empty disposable database, then restore. `restore.sh` intentionally defaults to `market_pulse_restore` and refuses `market_pulse` without an explicit override.

```bash
createdb -h localhost -p 5435 -U postgres market_pulse_restore
MP_RESTORE_DB_NAME=market_pulse_restore ./deploy/restore.sh \
  "$HOME/market-pulse-backups/daily/market-pulse-db-TIMESTAMP.dump.gpg" \
  "$HOME/market-pulse-backups/daily/market-pulse-frontend-TIMESTAMP.tar.gpg"
psql -h localhost -p 5435 -U postgres -d market_pulse_restore -c '\\dt'
dropdb -h localhost -p 5435 -U postgres market_pulse_restore
```

For disaster recovery, stop application traffic, take a final backup if possible, verify the selected archive and target, create the target database, then run with `MP_RESTORE_DB_NAME`. Restoring over `market_pulse` additionally requires `MP_ALLOW_PRODUCTION_RESTORE=yes`; this is destructive because `pg_restore --clean` replaces existing objects.

## Verification

- Check both encrypted files exist and are non-empty after every run.
- Test a restore into a disposable DB monthly.
- Verify remote copies independently; local success does not prove upload success.
- Monitor cron exit status/logs. GPG, dump, tar, retention, or upload failures produce non-zero exit status.
