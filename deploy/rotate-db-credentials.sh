#!/usr/bin/env bash
# One-shot credential rotation + hardening for the forward-test Postgres.
# Run manually on the VPS as ubuntu (needs sudo): it
#   1. rotates the postgres password to a fresh random value,
#   2. moves it into ~/.pgpass, the untracked repo .env,
#      /etc/market-pulse-worker.env and a new /etc/market-pulse.env,
#   3. wires the web service to that env file via a systemd drop-in,
#   4. recreates the DB container so the loopback-only port binding
#      (docker-compose.yml) takes effect,
#   5. restarts web + worker and verifies old creds are dead.
#
# After a successful run: change the DATABASE_URL fallback in
# src/server/db/client.ts to postgres:postgres (see the TODO there) and commit.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
NEW="$(openssl rand -hex 24)"

# 1. Rotate inside Postgres (auth via current ~/.pgpass).
psql --no-password -h localhost -p 5435 -U postgres -d market_pulse \
  -c "ALTER USER postgres WITH PASSWORD '${NEW}';" >/dev/null
echo "step1: password rotated in postgres"

# 2. ~/.pgpass (backups + manual psql).
printf 'localhost:5435:*:postgres:%s\n' "$NEW" > /home/ubuntu/.pgpass
chmod 600 /home/ubuntu/.pgpass
echo "step2: ~/.pgpass updated"

# 3. Untracked repo .env — compose var + dev DATABASE_URL.
umask 077
cat > "$REPO/.env" <<EOF
POSTGRES_PASSWORD=${NEW}
DATABASE_URL=postgres://postgres:${NEW}@localhost:5435/market_pulse
EOF
echo "step3: repo .env written"

# 4. Worker env: swap the password inside DATABASE_URL in place.
sudo sed -i -E "s#(://[^:/]+:)[^@]+@#\\1${NEW}@#" /etc/market-pulse-worker.env
echo "step4: /etc/market-pulse-worker.env updated"

# 5. Web env file (the service previously relied on the hardcoded fallback).
sudo install -m 600 /dev/null /etc/market-pulse.env
printf 'DATABASE_URL=postgres://postgres:%s@localhost:5435/market_pulse\n' "$NEW" \
  | sudo tee /etc/market-pulse.env >/dev/null
echo "step5: /etc/market-pulse.env written"

# 6. systemd drop-in so the web service loads it.
sudo mkdir -p /etc/systemd/system/market-pulse.service.d
sudo tee /etc/systemd/system/market-pulse.service.d/override.conf >/dev/null <<'EOF'
[Service]
EnvironmentFile=/etc/market-pulse.env
EOF
echo "step6: systemd drop-in installed"

# 7. Recreate the DB container → loopback-only binding takes effect.
(cd "$REPO" && sudo docker-compose up -d)
echo "step7: DB container recreated"

# 8. Restart consumers.
sudo systemctl daemon-reload
sudo systemctl restart market-pulse market-pulse-worker
echo "step8: services restarted"

# 9. Verify.
sleep 3
psql --no-password -h localhost -p 5435 -U postgres -d market_pulse -tAc "select 'new-cred-ok'"
if PGPASSWORD=hermes3369 psql -h localhost -p 5435 -U postgres -d market_pulse \
    -tAc "select 1" >/dev/null 2>&1; then
  echo "FAIL: old password still works"; exit 1
fi
echo "old-cred-rejected-ok"
ss -tln | grep 5435 || true
echo "done — now flip the client.ts fallback (see TODO) and commit."
