#!/usr/bin/env bash
# Migrate OpenCrow data from the Colima/Docker stack into the native macOS stack.
# Prereqs: native Postgres + Qdrant + mem0 provisioned (opencrow native up) and
# the OLD Docker stack still running as the data source.
set -euo pipefail

PGBIN="$(brew --prefix)/opt/postgresql@17/bin"
NATIVE="${HOME}/.opencrow"

# Guard: psql binary must exist
[[ -x "${PGBIN}/psql" ]] || { echo "ERROR: psql not found at ${PGBIN}/psql — is postgresql@17 installed?"; exit 1; }

# Guard: verify a container is running before touching its data
require_running() {
  docker inspect --format '{{.State.Running}}' "$1" 2>/dev/null | grep -q true \
    || { echo "ERROR: container $1 is not running — start the Docker stack before migrating"; exit 1; }
}

echo "==> 1/3 Postgres: dump from container, restore into native"
require_running opencrow-postgres-1
docker exec opencrow-postgres-1 pg_dump -U opencrow -d opencrow --no-owner --no-privileges \
  | "${PGBIN}/psql" "postgres://opencrow:opencrow@127.0.0.1:5432/opencrow"

echo "==> 2/3 Qdrant: stop native, copy storage, restart"
require_running opencrow-qdrant-1
launchctl kill SIGTERM "gui/$(id -u)/com.opencrow.qdrant" 2>/dev/null || true
sleep 2
rm -rf "${NATIVE}/qdrant/storage"
mkdir -p "${NATIVE}/qdrant/storage"
docker cp opencrow-qdrant-1:/qdrant/storage/. "${NATIVE}/qdrant/storage/"
launchctl kickstart -k "gui/$(id -u)/com.opencrow.qdrant"

echo "==> 3/3 mem0: stop native, copy /data (kuzu + vectors), restart"
require_running opencrow-mem0-1
launchctl kill SIGTERM "gui/$(id -u)/com.opencrow.mem0" 2>/dev/null || true
sleep 2
mkdir -p "${NATIVE}/mem0"
docker cp opencrow-mem0-1:/data/. "${NATIVE}/mem0/"
launchctl kickstart -k "gui/$(id -u)/com.opencrow.mem0"

echo "==> Migration complete. Verify before deleting Colima."
