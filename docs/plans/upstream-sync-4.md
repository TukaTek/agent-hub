# Upstream Sync #4 (through #4301) and Node 24

**Status:** Merged on the branch. Not deployed.

**Goal:** Bring `TukaTek/agent-hub` up to upstream `main` at `943dd52b` (#4301), 1,670 commits past the `2362e07b` merge base of [sync #3](upstream-sync-3.md), and move the toolchain to Node 24 and pnpm 12. Skips are the same as in sync #3. Everything else upstream ships is taken. Features that could route around Hub-managed identity, tenant isolation or Hub-managed keys stay off under Hub.

**Architecture:** Same as sync #3, but in seven sequential batches instead of one merge, so each batch can be resolved and verified on its own. Each batch is a real two-parent merge (`git merge --no-ff --no-commit <upstream sha>`). Then `scripts/upstream-remerge.mjs` re-merges each conflicted file after rebranding and formatting the base and upstream sides, and the remaining hunks are resolved by hand. Batch boundaries sit right before the pnpm 12 switch and the Node 24 floor.

Notation: `<old>` is upstream's retired product name. Upstream PRs are written "#N".

## Batches

| #   | Upstream range         | Merge       | Notes                                                                      |
| --- | ---------------------- | ----------- | -------------------------------------------------------------------------- |
| 1   | `2362e07b..99695120d`  | `f230f3a2c` | 445 conflicts; executor and router splits; email-first Hub sign-in kept    |
| 2   | `99695120d..adf17c628` | `ee7fa9d22` | Node 24.22 Docker images; PITR role and slot renamed                       |
| 3   | `adf17c628..ac49fed58` | `220ee25c5` | CAAH-169 cherry-picks meet their originals; self-host docs split           |
| 4   | `ac49fed58..0df9d229c` | `76c043ebc` | Better Auth 1.7.16; SCIM refused with Hub; Polish UI                       |
| 5   | `0df9d229c..ac644a616` | `29727494f` | Shared spaces; bot email; web type scale                                   |
| 6   | `ac644a616..b0651cd5c` | `9079be8d2` | pnpm 12.18, graphile-worker 0.18, `@composio/core` 0.28, run runtime split |
| 7   | `b0651cd5c..943dd52b`  | `c56b7f446` | Node 24.15 floor, Expo SDK 58, Lingui 6.12, Vitest 5, shared catalogs      |

Fork commits on the branch: one before the merges (the re-merge script carries upstream additions into the fork's renamed paths), and after them, xAI voice keeps its own API key under Hub.

## Must stay intact

| Area                           | Resolution                                                                                                                                                                                                  |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hub sign-in and sessions       | Fork sign-in flow kept on web, desktop and mobile (mobile's moved to `api-auth.ts`). Passkeys and email codes stay off in Hub mode. Refresh lease and 503-on-unconfirmed session kept in upstream's router. |
| New identity paths             | SCIM refuses to start with Hub. Shared page links, plugin submissions and integration claims are unmounted under Hub. Owner bootstrap refuses Hub. Voice can't borrow a provider sign-in under Hub.         |
| Composio                       | `@composio/core` 0.28 and upstream's completed-result check taken. The deployment key stays one direct provider in the Hub-scoped connector stack, chosen first in connection flows.                        |
| Tool completion audit          | Fork queue and concurrency kept. Event append is raw SQL upstream, so recovery also accepts P2010/23505.                                                                                                    |
| Deferred migrations (CAAH-169) | Upstream's implementation (lock timeout and retry) with the fork's names.                                                                                                                                   |
| Branding                       | Rebrand rules added for SQL identifiers, `<old>_private`, `<old>_pitr`, raw GitHub URLs, image aliases and camelCase identifiers. Bridge prefix `cah-c` and role `cortexai_agent_hub_app` unchanged.        |
| Reskin and copy                | Geist and the fork palette kept; fork leftovers moved onto upstream's type scale. "Assistant" wording ported into upstream's Lingui macros on mobile.                                                       |
| Computer image                 | Fork desktop session kept; upstream's browser build option and policy taken. Per-screen browser launchers follow the installed browser.                                                                     |

## Skips

| Item                                 | Reason                                                                                   |
| ------------------------------------ | ---------------------------------------------------------------------------------------- |
| Honcho memory provider               | Policy.                                                                                  |
| Dutch (`nl`) locale                  | Policy. Removed from web, mobile, desktop, Android resources and the shared catalog.     |
| `README.zh-CN.md`, `README.th-TH.md` | Upstream-only store links and copy.                                                      |
| Upstream `www` redesign              | The fork owns its site. Only dependency bumps are taken; new upstream pages are dropped. |
| Desktop hosted-service first launch  | There is no hosted service; a first launch opens setup.                                  |

## Translations

Upstream moved web and mobile onto one set of Lingui catalogs in `packages/i18n/locales` (#4185 and the commit before it). Mobile's hand-written dictionaries are gone. Where the English text matches, the fork's translations from its old web catalogs and mobile dictionaries were carried into the shared catalogs. zh-CN, zh-TW and Polish must stay complete, so the strings still missing there were translated. Other locales show those strings in English until the catalog workflow updates them.

## Database migrations

114 new migrations, all from upstream. Prisma applies unapplied migrations regardless of timestamp, so the fork's `hub_*` migrations need no reordering.

- **Deferred** (`-- deferred`, applied one deploy later): `drop_pending_instructions_run`, `drop_message_history_search_idx`, `drop_thread_unread`, `drop_message_history_search_files_idx`.
- **Drops in the same release** (as upstream shipped them): `drop_space_backup_models`, `drop_model_preference_default`, `drop_unused_referral_tables`, `drop_dead_bot_and_referral_columns`. The previous release can read these during the overlap.
- `bot_cross_space_default_on` flips the cross-space default back to on.

## Deploy impact

- **Node 24.15+ and pnpm 12.18.** Engines are `^24.15.0 || >=26`. CI, Dockerfiles (including the fork's topology and Railway images) and EAS use Node 24.22.2.
- **Postgres** stays on 18.
- **New settings** include `INSTABOX_API_KEY`, `PAID_SERVICES_*`, `INBOUND_EMAIL_*`, `POSTGRES_MEMORY_LIMIT`/`POSTGRES_SHARED_BUFFERS`/`POSTGRES_EFFECTIVE_CACHE_SIZE`, `CORTEXAI_AGENT_HUB_EXTRA_AUTH_ORIGINS`, `CORTEXAI_AGENT_HUB_LOCAL_MODELS_API_KEY`, `CORTEXAI_AGENT_HUB_ADMIN_EMAILS`, `AUDIT_*`, `MASTER_KEY_PROVIDER` with `AWS_KMS_*`, Incus and Wuying computers, and `SCIM_BEARER_TOKEN` (refused with Hub). `VAPID_*` and `SUPERMEMORY_*` left `.env.example`.
- **Linux desktop updates** are verified against upstream's ed25519 public key. The fork needs its own key pair before shipping Linux updates.

## Verification

- `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm db:generate`, `pnpm check` and the Vitest suite after every batch, on Node 24 from batch 6 on.
- Postgres tests, image builds and e2e run in CI.
