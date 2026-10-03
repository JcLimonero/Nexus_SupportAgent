#!/usr/bin/env bash
# Restore a backup made by backup-for-migration.ps1 into the Coolify stack and
# verify row counts against the manifest. Run ON the Coolify server.
#
#   ./restore-coolify.sh /path/to/migration-backup-YYYYMMDD-HHMM
#
# Containers are auto-detected by name (Coolify names them <service>-<uuid>);
# override with DB_CONTAINER / BACKEND_CONTAINER if several stacks run here.
# Destructive for the TARGET database (--clean). Never run it against a stack
# that already holds data you want to keep.
set -euo pipefail

DIR="${1:?usage: $0 <backup-dir>}"
cd "$DIR"
sha256sum -c SHA256SUMS

DB="${DB_CONTAINER:-$(docker ps --format '{{.Names}}' | grep -E '^db-' | head -1)}"
BE="${BACKEND_CONTAINER:-$(docker ps --format '{{.Names}}' | grep -E '^backend-' | head -1)}"
[[ -n "$DB" && -n "$BE" ]] || { echo "db/backend containers not found; set DB_CONTAINER / BACKEND_CONTAINER"; exit 1; }
echo "db=$DB backend=$BE"

read -r -p "This OVERWRITES the database in '$DB'. Type YES to continue: " ok
[[ "$ok" == "YES" ]] || exit 1

echo "== stop backend (no writes during restore)"
docker stop "$BE" >/dev/null

echo "== restore database"
docker cp nexus_agent.dump "$DB":/tmp/nexus_agent.dump
# pg_restore exits non-zero on harmless "already exists" noise (vector extension);
# the row-count check below is the real verdict.
docker exec "$DB" pg_restore -U nexus -d nexus_agent --clean --if-exists --no-owner --no-privileges /tmp/nexus_agent.dump || true
docker exec "$DB" rm -f /tmp/nexus_agent.dump

echo "== restore uploaded files"
docker start "$BE" >/dev/null
docker cp nexus_data.tgz "$BE":/tmp/nexus_data.tgz
docker exec "$BE" sh -c "tar xzf /tmp/nexus_data.tgz -C /data && rm /tmp/nexus_data.tgz"

echo "== verify against manifest"
fail=0
while IFS='=' read -r key want; do
  case "$key" in
    table:*) got=$(docker exec "$DB" psql -U nexus -d nexus_agent -tAc "SELECT count(*) FROM ${key#table:}" | tr -d '[:space:]') ;;
    files:data) got=$(docker exec "$BE" sh -c "find /data -type f | wc -l" | tr -d '[:space:]') ;;
    *) continue ;;
  esac
  want=$(echo "$want" | tr -d '[:space:]\r')
  if [[ "$got" == "$want" ]]; then echo "  ok   $key = $got"; else echo "  FAIL $key: expected $want, got $got"; fail=1; fi
done < manifest.txt

# response_cache may legitimately differ if the app flushed it on start.
[[ $fail -eq 0 ]] && echo "RESTORE VERIFIED" || { echo "MISMATCH - do not cut over"; exit 1; }
