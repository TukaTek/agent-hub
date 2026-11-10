# Row-level security bypass key: deploy notes (CAAH-151)

Applies to every CortexAI Agent Hub instance that runs the API with separate database logins
(`DATABASE_MIGRATION_URL` = owner, `DATABASE_URL` = app login that is a member of
`cortexai_agent_hub_app`). The examples call two instances "instance A" and "instance B"; the steps
are the same for each.

## What changes

Before this release, any database session could run `set_config('app.rls_bypass', 'on', ...)`, so
SQL that ran for one Space could switch itself into the cross-Space system scope. After it, the
`*_system` policies go through `app_rls_bypass()`, which also requires `app.rls_bypass_key`: an
HMAC of the app login's password. `pnpm db:migrate` stores a SHA-256 digest of that key in
`cortexai_agent_hub_private.rls_bypass_keys`, a schema the app login has no privileges on.

The release also drops the `*_previous_release` policies left from the tenant-tables rollout
(`20261022120000`), which gave every row of 21 tables to any session that cleared
`app.rls_version`, and the `app_rls_version()` function they used.

## Migrations and ordering

| Order | Migration | Kind | Effect |
|---|---|---|---|
| 1 | `20261109150000_rls_bypass_key` | ordinary | Creates the private schema, the digest table and `app_rls_bypass()` (accepts the plain bypass, so the previous release still works). Rewrites every policy whose condition is exactly the plain bypass to `(SELECT app_rls_bypass())`. Drops `*_previous_release` policies and `app_rls_version()`. |
| 2 | `20261109150100_rls_bypass_key_required` | `-- deferred` | Replaces `app_rls_bypass()` so it also requires the stored key (or accepts the plain bypass while no digest is stored). |

`pnpm db:migrate` / `db:deploy` now holds a `-- deferred` migration back the first time it sees it
and applies it on the next run. The first deploy of this release therefore applies migration 1
only. Migration 2 applies on the next deploy (or the next API container start, since the container
runs `db:deploy` on start), by which time the previous release, which sends no key, has stopped. A
fresh database gets both at once.

Prisma's migrations path can be overridden through `CORTEXAI_AGENT_HUB_MIGRATIONS_PATH`. Only the
migrate command sets it (to a temporary copy without the held-back migrations); operators never
need to set it.

## Roles and grants

- No new role. `cortexai_agent_hub_app` gets no grant on `cortexai_agent_hub_private`; the schema
  revokes everything from `PUBLIC`.
- `app_rls_bypass()` is `SECURITY DEFINER`, owned by the migration (owner) role, with a fixed
  `search_path`. The app login calls it through the default `EXECUTE` on functions.
- `pnpm db:migrate` (as the owner) now also:
  1. logs in once with `DATABASE_URL` to confirm the password works. If it doesn't, it warns and
     registers nothing.
  2. stores the digest of the key derived from that password and removes any other digest, in one
     statement.
  3. if `DATABASE_URL` has no password, deletes all digests (so the plain bypass keeps working) and
     warns.

## Environment variables

No new variable for operators. The key is derived from the password already in `DATABASE_URL`.
Keep `DATABASE_URL` and `DATABASE_MIGRATION_URL` (or `POSTGRES_APP_PASSWORD` in Compose) as they
are.

## Pre-deploy checks (per instance)

1. `DATABASE_URL` and `DATABASE_MIGRATION_URL` name different logins. With one shared URL,
   row-level security is not enforced at all and this change has no effect.
2. The app login in `DATABASE_URL` has a password.
3. The owner login can create a schema in the database (it already creates tables).
4. Take the usual pre-deploy database backup.

## Post-deploy checks (per instance)

1. The migrate log for the first deploy shows
   `Holding back until the next migration run: 20261109150100_rls_bypass_key_required`, then
   `Runtime login is ready`, with no bypass-key warning.
2. API and worker start without the warning "Background work across Spaces is blocked".
3. After the next deploy or API restart, `_prisma_migrations` lists
   `20261109150100_rls_bypass_key_required` as applied, and the warning is still absent.
4. As the owner: `SELECT count(*) FROM cortexai_agent_hub_private.rls_bypass_keys` returns 1.
5. As the app login: the same query fails with `permission denied`.
6. Background work that runs in system scope (routine wakeups, outbox drain, reconcilers) keeps
   running. Check the worker log for row-level security errors.

## Changing the app login's password later

Run `pnpm db:migrate` (or restart the API container) after changing it. Until then the API and
worker warn that background work across Spaces is blocked, because the old digest no longer
matches.

## Rollback

- **Before migration 2 has applied** (the first deploy): rolling back the code is safe. The
  previous release sends no key and migration 1 still accepts the plain bypass. The
  `*_previous_release` policies are gone, but no running release relies on them.
- **After migration 2 has applied:** do not run the previous release as is. Its system scope sends
  no key and would be refused, which stops cross-Space background work. To roll back, first
  restore the permissive function as the owner:

  ```sql
  CREATE OR REPLACE FUNCTION app_rls_bypass() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
    AS $$ SELECT coalesce(current_setting('app.rls_bypass', true) = 'on', false) $$;
  ```

  or `DELETE FROM cortexai_agent_hub_private.rls_bypass_keys;`, which makes the function accept
  the plain bypass. Then roll back the code, and re-run `pnpm db:migrate` with this release when
  rolling forward again.
- Migrations are not reversed automatically. The schema, table and function are harmless to an
  older release once the function is permissive.

## Upstream sync note

Upstream ships the same change as `20261114120000_rls_bypass_key` and
`20261114120100_rls_bypass_key_required`, using upstream's own private schema name. When syncing
upstream, drop those two upstream migrations in favour of the ones above, rather than applying
both.
