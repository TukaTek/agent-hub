# CAAH-97: Selective Upstream Sync — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** Plan only. No sync code, cherry-picks or conflict resolution until Agent Hub PM approves this plan and the decisions in "Decisions for the PM". Merge only on Sanjay's go.

**Goal:** Bring the upstream fixes the ticket names (routine retry #1397, backup-model fallback #1408, prompt cache #1450, Slack files #1458 and thread history #1460) into `TukaTek/agent-hub`, and review OIDC hardening #1416, without changing Hub SSO, Hub policy, CAAH-89 paging, CAAH-95 spill or CAAH-96 stall retry.

**Architecture:** Cherry-pick 12 upstream commits (the ticket's picks plus the prerequisites they need) in upstream order onto a sync branch, rebranding each with `scripts/upstream-rebrand.mjs`. Upstream #1392's same-model backoff is folded into CAAH-96's `fallbackAwareModelStream` in a separate fork commit, so the main agent and subagents keep one fallback and retry path. Optional fixes the PM approves are picked the same way.

**Tech stack:** git (`cherry-pick -x`), pnpm workspaces, Biome, TypeScript, Vitest (offline fake providers, fake timers), Prisma migrations on Postgres.

## Global constraints

- Notation: `<old>`, `<Old>` and `<OLD>` stand for upstream's retired product name in lower, title and upper case. `packages/testkit/src/product-identity.test.ts` fails on any tracked file that spells it out, or that uses the competitor-positioning phrase from upstream's marketing pages. This plan never does. Upstream PRs are written "upstream #N".
- CAAH-96 behavior is fixed: 2 stall retries before the first event (3 attempts at most), the final retry uses a backup when one fits, a backup switch is sticky, subagents fall back with their own state and never call `onModelChange`, and every attempt logs one `model call` line.
- Hub mode stays fail closed (CAAH-36). `HUB_SSO_ENABLED`, `HUB_POLICY_ENFORCEMENT=on|off` (CAAH-83) and `authorizeUserWork` keep working exactly as today. Direct OIDC can never be configured alongside Hub sign-in.
- CAAH-89 bounded MCP pages, CAAH-95 spill receipts and CAAH-72 attachment rules (macro Office blocked, Office and zip download-only) are unchanged.
- No new user-facing copy. The backoff and routine retry are invisible to users, apart from the routine's failure notice, which upstream now holds until the retry fails.
- New configuration is generic, with no provider-specific variables. The only env var the take set adds is `BOT_MESSAGE_MAX_HOPS` (default 6, the current constant).
- Tests stay deterministic and offline. The desktop Electron Playwright suite runs only in CI.
- Public repo: no secrets, hostnames or account names in commits, logs or the PR.

---

## Inventory (taken Oct 18, 2026)

- `origin/main` = `a5516949` (CAAH-96, PR #49). `upstream/main` = `39bcee47` (#1480). Merge base = `afa31774` (#1355), the commit CAAH-88 merged.
- `main` is **81 commits behind** upstream (no merge commits) and **77 ahead**. The ticket's count (73 behind) was taken a day earlier; upstream has since added #1465 through #1480.
- Every upstream commit was trial-applied by itself on `main` in a throwaway worktree (`cherry-pick --no-commit`, then abort). The "Trial" column counts conflicting files. Then the take set was applied cumulatively in upstream order, to separate missing prerequisites from real fork conflicts.
- Because our rebrand changed `@<old>/*` imports in nearly every source file (1,465 files differ from the merge base), most conflicts are one import block. Real fork conflicts are listed under "Conflict hotspots".

Reproduce:

```bash
git remote add upstream "$(grep -oE 'https://github.com/[^)]+' NOTICE).git"
git fetch upstream main
git merge-base origin/main upstream/main                  # afa31774
git rev-list --count origin/main..upstream/main           # 81
git log --reverse --format='%h %s' origin/main..upstream/main
```

### Every upstream commit

Decision key: **take** goes into the sync branch. **review** needs a PM decision, and the recommendation is in the reason. **skip** stays out of this sync, either for good (marketing, avatars, security posture) or until the next full catch-up.

| # | Commit | Upstream | Change | Decision | Reason | Trial |
|---|---|---|---|---|---|---|
| 1 | `0394e92c` | #1358 | Product shots on a competitor comparison page | skip | Marketing. The page's positioning fails `product-identity.test.ts` (CAAH-88 decision D4). | 4 |
| 2 | `c5f1fa83` | #1362 | Stop the Web Speech restart loop (beeps, duplicate transcript) | review | Recommend take: user-visible web dictation bug, applies cleanly. | 0 |
| 3 | `f9b873e0` | #1344 | Supervisor drops screen state left by a restarted container | review | Recommend take: computer reliability fix, applies cleanly. | 0 |
| 4 | `89dc995f` | #1369 | Mobile: omit credential configuration from saved chats | review | Recommend take, **security**: secret-request settings were kept in the plain offline cache. Applies cleanly. | 0 |
| 5 | `6e37690c` | #1368 | Comparison page cards with homepages | skip | Marketing, same as #1. | 3 |
| 6 | `0723154f` | #1375 | Compose: install dependencies before the source tree | skip | Build speed only. Conflicts with our Dockerfile. Next full sync. | 1 |
| 7 | `932534d7` | #1374 | Mobile dictation through the server transcriber | skip | Feature. Next full sync. | 1 |
| 8 | `3209a27d` | #1380 | Keep a backed-off run job | **take** | Prerequisite of #1397, which edits the same `wakeup.ts` and `job-reconciler.ts` hunks (`keepExisting`). Also fixes the worker retry cap. | 0 |
| 9 | `37f7b09a` | #1392 | Retry a transient model failure when no backup is left | **take** | Prerequisite of #1408, #1397 and #1430. Its same-model backoff is folded into the CAAH-96 wrapper. Its subagent rewrite is dropped for CAAH-96's (see "One fallback path"). | 3 |
| 10 | `fb3ef434` | #1393 | Background run keeps its instructions and answers on resume | review | Recommend take: correctness bug, applies cleanly. | 0 |
| 11 | `4548918e` | #1384 | undici dispatcher mismatch in the OpenAI-compatible usage fetch | review | Recommend take: breaks model connections that pin a dispatcher. 2 small conflicts in `pi-usage`. | 2 |
| 12 | `d1606fa6` | #1395 | Expo patch bump | skip | Mobile dependencies go in a dedicated dependency PR. | 2 |
| 13 | `9cf5fdd8` | #1394 | Telegram replies as Markdown | skip | Telegram isn't in TukaTek's rollout. Clean, so the next sync takes it. | 0 |
| 14 | `890073f0` | #1376 | Android allows cleartext HTTP for LAN servers | skip | Weakens transport security for a hosted product. Deliberate skip. | 2 |
| 15 | `89d1af24` | #1341 | Railway sandbox provider | skip | New optional provider, not needed. | 1 |
| 16 | `d165de43` | #1396 | A vision-capable native backup can take screen-tool runs | **take** | Fixes a fallback refusal in `fallbackSupportsContext`, and #1408's fallback tests build on it. Applies cleanly. | 0 |
| 17 | `d9bd2b50` | #1399 | Composer drafts per thread, optional Enter-to-send | skip | Feature with new settings copy. | 0 |
| 18 | `6be9a4f7` | — | Default avatar style to organic (direct push) | skip | Avatars (ticket). | 7 |
| 19 | `60684ee3` | — | Revert of #18 | skip | Avatars. | 7 |
| 20 | `9078b36f` | #1402 | Default avatar style to organic | skip | Avatars. It also changes a schema default through a migration. | 7 |
| 21 | `e6c2875a` | — | Organic avatars on the landing page (direct push) | skip | Marketing and avatars. | 3 |
| 22 | `4b2a36fd` | — | Revert of #21 | skip | Marketing and avatars. | 3 |
| 23 | `dffd2df9` | #1407 | Organic avatars on the landing page | skip | Marketing and avatars. | 1 |
| 24 | `39a676e2` | #1406 | Release a pending screen takeover when the user replies | review | Recommend take: otherwise the run stays held without browser tools. Applies cleanly, with a Postgres regression test. | 0 |
| 25 | `dacfcbe5` | #1408 | Kimi For Coding usage limit falls back to a backup | **take** | Ticket. Applies cleanly after #1392 and #1396. | 1 |
| 26 | `c00a8c19` | #1410 | Don't answer a message again after a run failed post-reply | review | Recommend take: duplicate replies. It matters more once routine runs retry. 1 conflict in `db/events.ts`. | 1 |
| 27 | `7d5e64c8` | #1411 | Timed-out page browser is a timeout; uncertain actions aren't retried | review | Recommend take: prevents repeating a page action that may have run. Applies cleanly. | 0 |
| 28 | `3cf3a9c6` | #1320 | Mobile Markdown table scroll hint | skip | Mobile UI polish. Next full sync. | 0 |
| 29 | `8b049dde` | #1321 | Mobile computer status at large text | skip | Mobile UI polish. | 0 |
| 30 | `54ba7faf` | #1340 | Mobile header title height | skip | Mobile UI polish. | 0 |
| 31 | `b469766d` | #1359 | Swipe actions on mobile inbox rows | skip | Feature. | 6 |
| 32 | `f76b8a63` | #1419 | Expo SDK patch bump | skip | Dependency PR. | 2 |
| 33 | `8046498b` | #1421 | Short glass titles at small text | skip | Mobile UI polish. | 2 |
| 34 | `3a096326` | #1417 | Swipe down to hide the keyboard | skip | Mobile UI polish. | 0 |
| 35 | `bca115e3` | #1420 | Wide Markdown tables pan on iOS | skip | Mobile UI polish. | 1 |
| 36 | `a25aa91e` | #1385 | Show/hide button on password fields | skip | Feature. It touches `Auth.tsx`, our Hub sign-in screen. | 2 |
| 37 | `6dea6755` | #1405 | Up to 10 bots in a group chat | skip | Product limit change. | 1 |
| 38 | `36b78d68` | #1426 | Follow-up to #1385 | skip | Depends on #36. | 2 |
| 39 | `5d1b795b` | #1401 | Mid-turn progress waits a minute, at most 3 per run | skip | Changes executor progress behavior. Next full sync. | 0 |
| 40 | `4444d9e8` | #1428 | Schedules described in words | skip | Cosmetic. Clean, next sync. | 0 |
| 41 | `e631150c` | #1329 | Retain Docker screens after runs | skip | Large computer lifecycle change that overlaps the CAAH-87 supervisor. | 3 |
| 42 | `67cd8069` | #1350 | Drag bots into sidebar sections | skip | Feature. | 0 |
| 43 | `fd1337ff` | #1425 | Patch and minor dependency updates | skip | Separate dependency PR. | 14 |
| 44 | `ec3fc564` | #1431 | Test fixes after #1329 and #1405 | skip | Only fixes skipped commits. | 2 |
| 45 | `f38c847a` | #1432 | Formatting for #44 | skip | Same. | 1 |
| 46 | `55e285da` | #1429 | CI screenshot cap | skip | Trivial. Next sync. | 0 |
| 47 | `e2599a78` | #1397 | Retry a routine run once after a transient model failure | **take** | Ticket. After prerequisites, only the import blocks in `executor.ts` and `wakeup.ts` conflict. | 4 |
| 48 | `737f25e4` | #1435 | Android foldables and tablets | skip | Feature. | 2 |
| 49 | `c80866a2` | #1317 | Opt-in OpenTelemetry export | skip | Feature. Touches `pi-runtime.ts` and `executor.ts`. Next full sync. | 5 |
| 50 | `b551a581` | #1440 | Configurable upload size (`MAX_UPLOAD_SIZE_MB`) | review | #1458 builds on its `maxUploadSizeBytes`. Recommend **not** taking it now (51 files, 15 conflicts) and porting #1458 against today's fixed 10 MB limit. | 15 |
| 51 | `029a1d21` | #1439 | Parallel web provider | skip | Feature. | 0 |
| 52 | `99e7f1cd` | #1416 | Separate OIDC sign-in from account-deletion reauth | review | Ticket. Recommend take: it is inert in Hub mode and stricter elsewhere (see "#1416 stays inert"). Applies cleanly. | 0 |
| 53 | `595b06af` | #1318 | Short readable run errors | skip | UI copy plus `pi-runtime.ts`. 17 conflicts. | 17 |
| 54 | `731feefa` | #1433 | Desktop packages on Windows | skip | Desktop packaging. Next full sync. | 2 |
| 55 | `65e2cb46` | #1436 | Sign-out error, phantom model, toggle a11y | skip | Touches the auth lifecycle, which differs under Hub. Next sync, with an auth review. | 1 |
| 56 | `09fbb41c` | #1319 | Space below the mobile composer | skip | Mobile UI polish. | 3 |
| 57 | `a03e0f58` | #1316 | Bots propose updates to their instructions | skip | Feature with a schema change. 13 conflicts. | 13 |
| 58 | `6191ad23` | #1430 | Empty stream with no finish reason is retryable | **take** | One phrase in the shared classifier the take set moves. Applies cleanly after #1397. | 3 |
| 59 | `a02b9678` | #1444 | Supervisor rejoins a computer's network first | review | Recommend take: desktop control is lost after a supervisor restart. 1 conflict. | 1 |
| 60 | `e55263f5` | #1441 | Image and video generation | skip | Feature. | 3 |
| 61 | `eae4a987` | #1448 | Larger OpenAI-compatible catalogs | skip | Next sync. | 0 |
| 62 | `7f9b9add` | #1449 | Docs for #61 | skip | Follows #61. | 1 |
| 63 | `16b99f28` | #1450 | Keep the prompt cache when a message arrives mid-run | **take** | Ticket. Applies cleanly. | 0 |
| 64 | `c647a04f` | #1452 | Configurable bot-to-bot hop limit | **take** | Prerequisite of #1458 (`botMessageMaxHops`). Generic `BOT_MESSAGE_MAX_HOPS`, default unchanged. | 4 |
| 65 | `b3a5d368` | #1456 | Slack: use the SDK's mention flag | **take** | Slack fix: channel mentions were treated as ambient. #1458 builds on its `types.ts` and `chat-sdk-surface.ts` changes. | 1 |
| 66 | `22aed2a8` | #1459 | Put recently attached files on the bot's computer | review | Completes the Slack-file story, but lands in `executor.ts` next to CAAH-95. Recommend the next full sync. | 4 |
| 67 | `a1c5e4fb` | #1461 | Paragraph break between assistant turns | skip | Next sync. | 1 |
| 68 | `da0a7c04` | #1453 | Configurable `message_user` cap | skip | Adds an `<OLD>_`-prefixed env var. Next sync, renamed. | 6 |
| 69 | `3ac1f809` | #1457 | Keep link targets in inbound text | **take** | Slack fix. #1458's `chat-sdk-surface.ts` hunks build on it. | 1 |
| 70 | `5b35ea78` | #1451 | No mid-turn narration in bot-to-bot runs | skip | Behavior change. Next sync. | 2 |
| 71 | `c7a1f01c` | #1463 | Last message time on sidebar rows | skip | Feature. | 0 |
| 72 | `65a06c82` | #1458 | Let the bot see files shared in Slack | **take** | Ticket. 8 conflicts alone, 4 after prerequisites (see "Slack"). | 8 |
| 73 | `76f42599` | #1460 | Backfill Slack thread history | **take** | Ticket. Applies cleanly after #1458. | 5 |
| 74 | `db4a0b28` | #1472 | Schedule tools run one at a time within a turn | review | Recommend take: a bot listed schedules before its new one was saved. Applies cleanly. | 0 |
| 75 | `b884f436` | #1473 | Automated user-role messages marked as not from the user | review | Recommend take, **prompt safety**: tool screenshots, nudges and shell output stop looking like the user's words. 1 conflict. | 1 |
| 76 | `102e107b` | #1476 | Slack eyes reaction on late replies | skip | Feature that needs a new Slack scope. | 7 |
| 77 | `47336c65` | #1467 | Emoji reaction wakes the bot | skip | Feature. | 2 |
| 78 | `45290a19` | #1465 | Start computers on use, cap uptime, shrink E2B | skip | Large executor and sandbox change. 9 conflicts. | 9 |
| 79 | `14bf61da` | #1466 | Switch spaces without a reload | skip | Feature. | 4 |
| 80 | `2afd7f65` | #1474 | Audio attachments | skip | Feature. | 13 |
| 81 | `39bcee47` | #1480 | Thumbs up on a pending takeover means done | skip | Depends on #77. | 3 |

**Totals: 12 take, 14 review, 55 skip.** Of the 14 review items, 12 are recommended for taking: #1416 plus 11 bug and security fixes. #1440 is recommended against, and #1459 is recommended for the next full sync. If the PM accepts every recommendation, the sync picks 24 commits.

## Apply order

Upstream order, prerequisites first. Optional picks are in brackets. Each line names the conflicts left after the earlier picks, from the cumulative trial.

1. `3209a27d` #1380, clean.
2. [`c5f1fa83` #1362], [`f9b873e0` #1344], [`89dc995f` #1369], clean.
3. `37f7b09a` #1392: `pi-runtime.ts`, `pi-runtime-fallback.test.ts`, `testkit/pi-offline.test.ts`. Resolve as described under "One fallback path".
4. [`fb3ef434` #1393], clean. [`4548918e` #1384]: `pi-usage.ts` and its test.
5. `d165de43` #1396, clean.
6. [`39a676e2` #1406], clean.
7. `dacfcbe5` #1408, clean after step 3.
8. [`c00a8c19` #1410]: `db/events.ts`. [`7d5e64c8` #1411], clean.
9. `e2599a78` #1397: imports in `executor.ts` and `wakeup.ts`. Its classifier move lands on the step 3 resolution.
10. [`99e7f1cd` #1416], clean.
11. `6191ad23` #1430, clean after step 9.
12. [`a02b9678` #1444]: supervisor `index.ts`.
13. `16b99f28` #1450, clean.
14. `c647a04f` #1452: `.env.example`, `team-chat-bridge.ts`, both `bot-messages.test.ts`.
15. `b3a5d368` #1456: `messaging-platforms.ts`. `3ac1f809` #1457, clean.
16. `65a06c82` #1458: `apps/api/src/{app,artifacts,artifacts.test,team-chat-bridge.test}.ts`.
17. `76f42599` #1460, clean after step 16.
18. [`db4a0b28` #1472], clean. [`b884f436` #1473]: `pi-runtime.ts`.
19. Fork commit: **CAAH-97: one fallback path: same-model provider backoff in the CAAH-96 wrapper**.

## One fallback path: #1392 and #1408 with CAAH-96

### What each side does today

- **CAAH-96 (`main`).** `fallbackAwareModelStream` is the only stream path. The main agent always uses it, with or without backups. Subagents use it with their own `FallbackStreamState` (parent's backups, local `onSwitch`, no `onModelChange`). Before output, an error is handled in order: (1) a watchdog stall uses the per-call stall budget of 2, and the final retry switches to a backup if one fits. (2) A non-stall provider-unavailable error switches to the next backup at once (`switched`). (3) Anything else is terminal. In passthrough mode (no backups), caller options pass through, pre-output events stream immediately and a retry drops the duplicate `start`.
- **Upstream #1392.** Also makes the wrapper the only path for the main agent and subagents, but gives subagents `fallbackModels: []`. When no backup is left, a provider-unavailable failure retries the same model after 2 s, 8 s and 20 s. Timeouts aren't backed off. Exhausted retries surface the *first* error. It adds `terminated` to the classifier.
- **Upstream #1408.** Adds one rule to `isRetryableProviderUnavailable`: HTTP 403 with Kimi's usage-limit wording counts as provider-unavailable, so the backup chain runs. 400 and 401 short-circuit to false first.
- **Upstream #1397 and #1430.** Move `errorFacts`, `isProviderTimeout` and `isRetryableProviderUnavailable` (with the Kimi rule) into `packages/adapter-kit/src/model-errors.ts`. Add `isTransientModelError` (quota, billing and usage limits are permanent) and `TransientModelError`, which the runtime throws so the executor can retry routines. Add dropped-connection phrases and `stream ended without finish_reason`.

### Reconciled design

The classifier lives once, in `adapter-kit/model-errors.ts`. `pi-runtime.ts` imports it, and its own `errorFacts` and `isRetryableProviderUnavailable` are deleted. `pi-runtime-fallback.test.ts` imports the classifier from `@cortexai-agent-hub/adapter-kit`.

The wrapper keeps CAAH-96's structure. Only one branch is added. For an error event before output that isn't a caller abort:

| Order | Condition | Action | Budget | Log outcome |
|---|---|---|---|---|
| 1 | Watchdog stall and `stallRetries > 0` | Retry. The final retry switches to a backup if one fits. Sticky. | Stall budget, 2 per call (unchanged) | `idle-timeout-retried` (unchanged) |
| 2 | Not a stall, provider failure, `isRetryableProviderUnavailable` (now includes Kimi 403) | Switch to the next backup that fits. Sticky. | Backup list (unchanged) | `switched` (unchanged) |
| 3 | **New.** Same as 2, no backup was switched, `!isProviderTimeout`, `providerRetries < 3`, and in passthrough mode nothing but `start` was forwarded this attempt | Wait 2 s, 8 s or 20 s (`abortableDelay`), then retry the same model | Provider budget, 3 per call, separate from the stall budget | `provider-retried` (new, with `errorMessage`) |
| 4 | Otherwise | Terminal. The event is the first retryable error when step 3 ran, or else this one. | — | `failed` (unchanged) |

Why this keeps CAAH-96's behavior:

- **2 stall retries.** Steps 2 and 3 both require "not a stall", so a stall never draws on the backup list or the provider budget. A third stall falls to step 4, so a stalled call still makes exactly 3 attempts. As a second guard, the stall message contains "timeout", so `isProviderTimeout` also excludes it from step 3.
- **Sticky switch.** Unchanged. Step 3 never changes the target, and steps 1 and 2 still use `switchTo`, which sets `state.onBackup`, persists `state.attempted`, and calls `onSwitch`.
- **Subagent fallback.** Upstream's `executeSubagent` hunk from #1392 is discarded when resolving. Subagents keep CAAH-96's state (parent's backups, local `onSwitch`, no `onModelChange`). They gain step 3 automatically because it lives in the shared wrapper.
- **Per-attempt logs.** Every attempt still logs one line with the same fields. Step 3 adds one outcome value to `ModelCallOutcome`.
- **Passthrough mode.** A same-model retry is only safe when the Agent saw nothing but `start`. CAAH-96 already relies on this for stalls. Step 3 checks it explicitly (a `forwardedNonStart` flag per attempt). If an attempt forwarded anything else before failing, the error is terminal, as it is today.
- **Abort.** The backoff delay uses the caller's signal, combined with the run signal when backups exist (the signals `signalAborted` already reads). An abort during the delay ends the call with "Model request was aborted" and no retry.

Bounds per call: at most 3 stalled attempts, one per configured backup, and 3 backoff attempts. The added worst-case wait is 30 s, and only for fast failures like 429, 503 or a dropped stream. Each attempt still goes through `ModelCallObserver.beforeCall`, so space budgets apply per attempt.

How it reaches the routine retry: once the wrapper gives up, `PiAgentRuntime` throws `TransientModelError` when `isTransientModelError(error)`. A routine run that stalled 3 times is therefore retried once, 12 minutes later, if it posted nothing and called no tool (#1397's rule). That is the intended combination: in-call retries first, then one run-level retry.

### Commit layout

- The #1392 pick keeps only the classifier phrase and the tests that hold under CAAH-96. Its wrapper and subagent hunks resolve to ours.
- The #1408, #1397 and #1430 picks apply on top. #1397 deletes our classifier copy from `pi-runtime.ts`.
- The final fork commit (step 19) adds step 3, the `provider-retried` outcome and the tests below, and ports #1392's backoff tests to CAAH-96's harness.

## #1416 stays inert unless configured

#1416 is not a new sign-in method. It hardens the direct OIDC sign-in that CAAH-88 already merged, which is off unless `OIDC_ISSUER`, `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET` are all set. It changes three places:

1. **`oidc.ts` (the OIDC provider plugin).** It forces `prompt=login`/`max_age=0` only for server-bound reauth, consumes a one-time callback marker, checks the ID-token `iss`/`sub` against UserInfo, and binds the deletion proof to the session, the linked account and a fresh `auth_time`. The plugin is only built when `env.oidc` exists (`packages/auth/src/index.ts`, `oidcDiscovery`).
2. **`index.ts` hooks.** The reauth hook runs only for `POST /sign-in/social` with `provider: "oidc"` and `reauthenticate: true`, and now also requires a linked account for the current OIDC issuer. The proof is written only on the OIDC callback (`/callback/oidc`).
3. **`account-security.ts`.** The deletion hook now refuses `GET /delete-user/callback` and query-string tokens in every mode. Our web app submits the emailed code over POST (`AccountAccess.tsx`), so that path is unaffected. The change only rejects more.

Why it can't touch Hub sign-in, policy or entitlement:

- `apps/api/src/env.ts` throws "OIDC sign-in can't be combined with Hub sign-in" when `OIDC_ISSUER` is set in Hub mode, and `createAuth` throws the same if both reach it. So in Hub mode the plugin and its callback don't exist.
- In Hub mode, `rejectHubAccountMutation` runs first in the same `before` hook and rejects `/sign-in/social` and `/delete-user` before any #1416 code runs.
- Hub SSO (`HUB_SSO_ENABLED`) has its own callback, `HUB_SSO_CALLBACK_PATH = /hub/sso/callback`, which #1416 doesn't touch.
- Policy enforcement and entitlement are applied by `startApiHubPolicy`, `startWorkerHubPolicy` and `authorizeUserWork`. #1416 touches none of them.

Tests that pin this are listed under "Tests".

## Conflict hotspots

### `packages/adapters/src/pi-runtime.ts`

Touched by #1392, #1396, #1408 and #1397 (plus optional #1473). Our side carries CAAH-96 (wrapper, watchdog, logs, subagent state), CAAH-95 (spill delivery in tool dispatch) and CAAH-89 (page budget in tool dispatch).

- The wrapper and `executeSubagent` are the only real semantic conflicts. Resolve them as described above.
- #1396's `fallbackSeesImages` lands in `fallbackSupportsContext`, which CAAH-96 left alone. It applies cleanly.
- The classifier move (#1397) deletes a block CAAH-96 didn't change.
- No take commit touches the tool-dispatch, spill or page-budget regions. The CAAH-89 and CAAH-95 tests below must stay green, unedited.

### `packages/adapters/src/executor.ts`

Only #1397 in the take set. It adds `notifyRoutineRetryAttemptsExhausted`, `retryRoutineRun` and routine-failure handling, and the only conflict is the import block. CAAH-95's spill code (`executor-tool-result-spill.test.ts`) is in other functions. Check after resolving:

- `retryRoutineRun` creates the retry run directly through Prisma. It still goes through `authorizeUserWork(run.userId)` when it executes (`executor.ts`, start of run execution), so a user Hub no longer authorizes gets the same fail-closed finalize as any run. A test pins this.
- The worker (`apps/worker/src/index.ts`) registers the new `routine.retry` handler. It has to sit after `startWorkerHubPolicy`, like the other handlers, so no job runs before policy loads.
- Migrations `20261014120000_run_retry_of_run` and `20261014120001_runs_retry_of_run_id_key_concurrent` sort after our latest (`20261010120000_artifact_client_nonce`). The second creates its unique index concurrently, so check it against the deploy's migration runner.

### MCP result budget and CAAH-89 paging

No upstream commit since the merge base touches `mcp-result-budget.ts`, `lazy-tool-catalog.ts`, `mcp-connector.ts` or `pi-runtime-limits.ts`. The only overlap is `testkit/src/pi-offline.test.ts`, where #1392 adds backoff cases next to CAAH-89's page-delivery cases. Keep both. #1450 changes the exchange count in `runtime-context.ts`, which carries only rebrand renames on our side. It doesn't change how old tool results are shortened, so bounded pages and spill receipts keep today's selection.

### CAAH-95 spill

No take commit touches `tool-result-spill.ts`, `computer-workspace.ts`, `computer-support.ts`, `context-selection.ts` or `builtin-tools.ts`. The risks are indirect:

- `adapter-kit/src/types.ts` gets additions from #1380, #1397, #1456 and #1458. CAAH-95 added the spill fields to the same file, so resolve by keeping both sides.
- #1459 (optional, recommended for later) would write attachments to the computer workspace next to spill files. That's why it isn't in this sync.

### Slack and `apps/api`

#1458 conflicts with our rebrand copy ("CortexAI Agent Hub thread" error text) and with #1440's `maxUploadSizeBytes`. Port it against the fixed limit: `storeInboundAttachment` uses `ATTACHMENT_MAX_BYTES`, with a local size label for the error. File type checks go through our `validateAttachmentMimeType` and `inferAttachmentMimeType`, so CAAH-72's rules apply to Slack files. #1460 needs Slack history scopes for the thread backfill. Confirm them before the smoke test.

## Method: cherry-pick, not merge

Earlier syncs were real merges (CAAH-88 merged everything up to `afa31774`). This one should cherry-pick:

- **A merge can't be selective.** `git merge upstream/main` brings all 81 commits. Merging only up to #1460 still brings 73, including #1316 (bot instruction proposals, schema), #1317 (OTel), #1318 (17 conflicts), #1329 (computer lifecycle), #1441 (media generation) and the avatar and marketing changes the ticket excludes.
- **Reverting skipped commits after a merge is a trap.** Reverts stay in history, so the next full merge would treat those upstream changes as already rejected. Restoring them would mean reverting the reverts by hand.
- **The take set is small and well bounded.** 12 commits (up to 24 with the optional fixes), with 5 non-trivial conflict sites. The cumulative trial applied every prerequisite chain.
- **Cost:** the merge base stays at `afa31774`, so the next full catch-up sees these commits again. Where our resolution matches upstream's text, git merges them silently. Where it differs (the wrapper and subagent in `pi-runtime.ts`, the rebrand copy in Slack code, the #1458 port), they conflict once more, and the resolution is "ours". The sync PR lists those files so that catch-up knows.

Mechanics, per commit:

```bash
git checkout -b cursor/caah-97-upstream-sync-9801 origin/main
git cherry-pick -x <sha>              # keeps upstream authorship and adds the source trailer
# on conflict: resolve, then
node scripts/upstream-rebrand.mjs $(git diff --name-only --cached --diff-filter=AM)
pnpm exec biome check --write <changed files>
git add -A && git cherry-pick --continue
```

A pick that applies cleanly can still add `@<old>/*` imports in new files. Run the rebrand sweep on the files that pick touched, and commit the result as `CAAH-97: rebrand <upstream #N>` right after it. Run `pnpm typecheck` and the package tests after each ticket pick, so a broken step is caught where it happens.

Merge the sync PR with "Create a merge commit" or "Rebase and merge". Squashing would lose the one-commit-per-upstream-PR record the ticket asks for.

## Tasks

- [ ] **Task 1.** Create the sync branch from `origin/main`, add the `upstream` remote, and record `upstream/main` in the PR.
- [ ] **Task 2.** Pick steps 1–2 (#1380 and the optional clean fixes). Run tests for `adapters` and `mobile` lib.
- [ ] **Task 3.** Pick #1392 and resolve: classifier phrase, CAAH-96 wrapper and subagent kept, and only the tests that hold. Run `pi-runtime-*` tests, all green and unedited apart from imports.
- [ ] **Task 4.** Pick #1396, #1408, the optional steps 6 and 8, then #1397 and #1430. Port classifier tests to `adapter-kit/src/model-errors.test.ts`. Run `adapter-kit`, `adapters`, `db` and `worker` tests, then `pnpm typecheck`.
- [ ] **Task 5.** Fork commit (step 19), test first: write the new wrapper tests, watch them fail, add step 3 and `provider-retried`, watch them pass.
- [ ] **Task 6.** Pick #1416 (optional), then add the Hub-mode tests below.
- [ ] **Task 7.** Pick #1450, then #1452, #1456 and #1457, #1458 (ported against the fixed limit) and #1460. Run `apps/api` and `adapters` tests.
- [ ] **Task 8.** Optional steps 12 and 18.
- [ ] **Task 9.** Full verification: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:pi`, Postgres tests via the testkit harness, and `product-identity.test.ts`. Push. CI must be green apart from the known mobile Expo check.
- [ ] **Task 10.** Draft PR listing every upstream commit taken or skipped, with reasons (this table), the files that will conflict again at the next full catch-up, and the smoke-test plan. Wait for review bots, address feedback, and don't merge without Sanjay's go.

## Tests

### Fork features that must stay unchanged (existing tests, unedited apart from import paths)

| Feature | Tests |
|---|---|
| CAAH-96 stall retry, sticky switch, subagent fallback, logs | `packages/adapters/src/pi-runtime-stall-retry.test.ts`, `pi-runtime-stream-idle.test.ts`, `pi-runtime-limits.test.ts`, `pi-runtime-fallback.test.ts` (including "switches after a Codex idle timeout before output", which switches on the 3rd attempt) |
| CAAH-95 spill | `tool-result-spill.test.ts`, `executor-tool-result-spill.test.ts`, `pi-runtime-tool-dispatch.test.ts`, `computer-support.test.ts`, `computer-workspace.test.ts`, `testkit/src/history-product-loop.postgres.test.ts`, `testkit/src/evals/wire-observer.test.ts` |
| CAAH-89 bounded MCP pages | `mcp-result-budget.test.ts`, `mcp-connector.test.ts`, `pi-runtime-limits.test.ts`, `pi-runtime-tool-dispatch.test.ts`, `testkit/src/pi-offline.test.ts` |
| Hub SSO and policy | `packages/auth/src/hub*.test.ts`, `hub.postgres.test.ts` ("never creates a session from direct OIDC in Hub mode"), `apps/api/src/env.test.ts` ("refuses direct OIDC and billing in Hub mode"), `apps/api/src/hub-policy.test.ts`, `apps/worker/src/hub-policy.test.ts`, `testkit/src/hub-policy-off.test.ts`, `contracts/src/auth.test.ts` |
| CAAH-72 attachments | `packages/core/src/attachments.test.ts`, `apps/api/src/artifacts.test.ts` |
| Branding | `testkit/src/product-identity.test.ts`, `scripts/upstream-rebrand.test.mjs` |

### New tests

Wrapper, in `pi-runtime-stall-retry.test.ts` or `pi-runtime-fallback.test.ts`, with fake timers:

1. No backups: a 503 before output retries the same model at 2 s, 8 s and 20 s, then fails with the first 503. 4 calls, logged as `provider-retried` ×3 and then `failed`.
2. With a backup: a 503 switches at once, with no backoff (CAAH-96 test 6 still holds).
3. Three Codex stalls with no backup: exactly 3 calls, no backoff, the run fails with `Codex stream idle timeout`.
4. A stall, then a 503, on the same call: one stall retry, then backoff. Neither budget draws on the other.
5. A provider timeout before output with no backup: no backoff, terminal on the first attempt.
6. An abort during a backoff delay: no further call, ends as aborted.
7. Passthrough: an attempt that forwarded a non-`start` event before a 503 isn't retried.
8. Subagent with no parent backup: backs off on its own model, and the parent's model and `onModelChange` are untouched. With a parent backup it still switches (CAAH-96 Task 4 cases stay green).
9. Kimi 403 with usage-limit wording switches to a backup. A plain 403, a 401 and Kimi wording on a 400 do not (`model-errors.test.ts`).

Routine retry and Hub:

10. A routine run that stalls 3 times throws `TransientModelError` and queues exactly one `routine.retry`.
11. When `authorizeUserWork` returns false for the user, the retry run is finalized without a model call. With `HUB_POLICY_ENFORCEMENT=off`, the retry runs as today.

#1416 in Hub mode:

12. `/sign-in/social` with `provider: "oidc"` and `reauthenticate: true`, and `/delete-user`, are rejected by `rejectHubAccountMutation` before any OIDC code runs.
13. `loadEnv` still refuses `OIDC_ISSUER` together with Hub mode. The existing test stays.

Slack:

14. A macro-enabled Office file shared in Slack is rejected, a zip is stored as download-only, and a file above 10 MB is rejected before it's fetched.

## Smoke test on TukaTek after deploy (from the ticket)

- SSO sign-in through Hub.
- A routine whose model fails transiently is retried once, 12 minutes later. Logs show `failed` for the first run, then a new run.
- A Fathom read whose result spills to the computer (CAAH-95) still returns a receipt the bot can read with `read_file`.
- A Slack thread with a shared file: the bot sees the file and earlier thread messages.

## Risks

1. **The backoff extends failing runs.** Worst case is 30 s extra per call, only for fast transient failures, and never for timeouts or stalls. The `provider-retried` log line shows how often it fires.
2. **Passthrough retries after forwarded events.** If a provider emits a non-output event (for example an empty `text_start`) before a 503, a retry could confuse the Agent's partial message. Step 3 refuses to retry in that case, and test 7 pins it.
3. **Routine retry timing.** The 12-minute delay and 30-minute skip window are upstream constants. A Hub-revoked user's retry fails closed, which is correct. Routine failure notices now follow each routine's `notify` setting (upstream fixed a stored setting that was never read), so some owners will get fewer notices.
4. **Concurrent index migration.** The `retry_of_run_id` unique index is created concurrently. A migration runner that wraps each migration in a transaction would fail. Check before deploying.
5. **Repeated conflicts at the next full catch-up.** Cherry-picks don't move the merge base. The reconciled files conflict once more, and the PR lists them.
6. **#1458 port drift.** Porting against the fixed limit means a later #1440 pick touches the same function. That's acceptable, and noted in the PR.
7. **Slack scopes.** Thread backfill needs history scopes on the Slack app. If they're missing, the backfill degrades to today's behavior, but the smoke test would not see history.
8. **Upstream changes again before this lands.** Re-run the inventory before Task 1. Commits after `39bcee47` are out of scope unless the PM adds them.

## Decisions for the PM

1. Approve the take set (12 commits, including prerequisites #1380, #1392, #1396, #1430, #1452, #1456 and #1457).
2. #1416: take (recommended).
3. The 11 optional bug and security fixes (#1362, #1344, #1369, #1393, #1384, #1406, #1410, #1411, #1444, #1472, #1473): take all (recommended), some, or none.
4. #1440: leave out, and port #1458 against the fixed 10 MB limit (recommended), or take it with its 15 conflicts.
5. #1459: next full sync (recommended), or include now.
6. Reconciliation: same-model backoff (2 s, 8 s, 20 s) as step 3 of the CAAH-96 wrapper, with a separate budget and a new `provider-retried` log outcome.
