#!/usr/bin/env bash
set -euo pipefail
umask 077
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${1:?usage: restore.sh backups/<stamp>}"
compose=(docker compose -f "$ROOT/infra/compose/docker-compose.yml")
# Compose resolves its default env file relative to the compose file, not the
# repo root; point it at the root .env when one exists (vars may also come
# from the environment, so its absence is not an error).
if [[ -f "$ROOT/.env" ]]; then compose=(docker compose --env-file "$ROOT/.env" -f "$ROOT/infra/compose/docker-compose.yml"); fi
if [[ -f "$ROOT/.env" ]]; then
  node "$ROOT/infra/compose/backup-metadata.mjs" verify "$SRC" "$ROOT/.env" "local-compose-v1"
else
  node "$ROOT/infra/compose/backup-metadata.mjs" verify "$SRC" "" "local-compose-v1"
fi
"${compose[@]}" up -d postgres
until "${compose[@]}" exec -T postgres pg_isready -U rakazo >/dev/null 2>&1; do
  sleep 1
done
if [[ -f "$ROOT/.env" ]]; then
  node "$ROOT/infra/compose/backup-metadata.mjs" emit "$SRC" rakazo.sql "$ROOT/.env" |
    "${compose[@]}" exec -T postgres psql -U rakazo -d rakazo
  node "$ROOT/infra/compose/backup-metadata.mjs" emit "$SRC" homes.tgz "$ROOT/.env" |
    tar -xzf - -C "$ROOT"
else
  node "$ROOT/infra/compose/backup-metadata.mjs" emit "$SRC" rakazo.sql |
    "${compose[@]}" exec -T postgres psql -U rakazo -d rakazo
  node "$ROOT/infra/compose/backup-metadata.mjs" emit "$SRC" homes.tgz |
    tar -xzf - -C "$ROOT"
fi
"${compose[@]}" up -d
echo "Restore complete from $SRC"
