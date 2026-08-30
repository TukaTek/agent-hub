#!/usr/bin/env bash
set -euo pipefail
umask 077

PROJECT_DIR="${RAKAZO_PROJECT_DIR:-/srv/rakazo}"
COMPOSE_FILE="${PROJECT_DIR}/infra/compose/docker-compose.prod.yml"
ENV_FILE="${PROJECT_DIR}/.env"
SNAPSHOT_DIR="${1:?usage: restore-prod.sh /var/backups/rakazo/<stamp>}"
EXPECTED_LAYOUT="production-compose-v1"

compose=(docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}")

node "${PROJECT_DIR}/infra/compose/backup-metadata.mjs" verify "$SNAPSHOT_DIR" "${ENV_FILE}" "${EXPECTED_LAYOUT}"

"${compose[@]}" stop caddy web worker api
"${compose[@]}" up -d postgres
until "${compose[@]}" exec -T postgres sh -c \
  'pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"' >/dev/null 2>&1; do
  sleep 1
done

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
