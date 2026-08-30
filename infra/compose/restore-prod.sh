#!/usr/bin/env bash
set -euo pipefail
umask 077

PROJECT_DIR="${RAKAZO_PROJECT_DIR:-/srv/rakazo}"
COMPOSE_FILE="${PROJECT_DIR}/infra/compose/docker-compose.prod.yml"
ENV_FILE="${PROJECT_DIR}/.env"
SNAPSHOT_DIR="${1:?usage: restore-prod.sh /var/backups/rakazo/<stamp>}"
EXPECTED_LAYOUT="production-compose-v1"
DB_READY_ATTEMPTS="${RAKAZO_RESTORE_DB_READY_ATTEMPTS:-60}"

if [[ ! "${DB_READY_ATTEMPTS}" =~ ^[1-9][0-9]{0,2}$ ]] ||
  (( DB_READY_ATTEMPTS < 1 || DB_READY_ATTEMPTS > 300 )); then
  echo "RAKAZO_RESTORE_DB_READY_ATTEMPTS must be an integer from 1 through 300." >&2
  exit 2
fi

compose=(docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}")

node "${PROJECT_DIR}/infra/compose/backup-metadata.mjs" verify "$SNAPSHOT_DIR" "${ENV_FILE}" "${EXPECTED_LAYOUT}"

"${compose[@]}" up -d postgres
database_ready=false
for ((attempt = 1; attempt <= DB_READY_ATTEMPTS; attempt++)); do
  if "${compose[@]}" exec -T postgres sh -c \
    'pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"' >/dev/null 2>&1; then
    database_ready=true
    break
  fi
  if (( attempt < DB_READY_ATTEMPTS )); then
    sleep 1
  fi
done
if [[ "${database_ready}" != "true" ]]; then
  printf '%s\n' \
    "PostgreSQL did not become ready after ${DB_READY_ATTEMPTS} attempt(s); application services were not stopped by this restore." \
    "Inspect the postgres service logs and health configuration, restore database readiness, then retry." >&2
  exit 1
fi

"${compose[@]}" stop caddy web worker api

node "${PROJECT_DIR}/infra/compose/backup-metadata.mjs" emit \
  "$SNAPSHOT_DIR" rakazo.dump "${ENV_FILE}" "${EXPECTED_LAYOUT}" |
  "${compose[@]}" exec -T postgres sh -c \
    'pg_restore --clean --if-exists --no-owner --no-privileges -U "$POSTGRES_USER" -d "$POSTGRES_DB"'

node "${PROJECT_DIR}/infra/compose/backup-metadata.mjs" emit \
  "$SNAPSHOT_DIR" appdata.tgz "${ENV_FILE}" "${EXPECTED_LAYOUT}" |
  "${compose[@]}" run --rm --no-deps --entrypoint sh api -c \
    'find /data -mindepth 1 -maxdepth 1 -exec rm -rf -- {} + && tar -xzf - -C /data'

"${compose[@]}" up -d --wait
echo "Production restore complete from ${SNAPSHOT_DIR}"
