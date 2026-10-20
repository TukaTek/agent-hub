# CAAH-107: Upstream Sync #2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** Plan only (phase 1). No conflict is resolved until the PM approves this plan and the decisions in "Decisions for the PM".

**Goal:** Merge all of upstream `main` (`08ee8cfb`, 157 commits past our `afa31774` merge base) into `TukaTek/agent-hub` in one real merge commit. Only the Honcho memory provider (#1361) and the Dutch locale (#1535) are skipped, plus any technical skips the PM approves below. Every fork feature listed under "Must stay intact" survives.

**Architecture:** `git merge --no-ff upstream/main` on this branch, resolved with a rebrand-aware re-merge: each conflicted file is merged again after rebranding and formatting the base and upstream sides, which removes every branding-only and formatting-only conflict. The remaining conflicts are resolved by hand, area by area, inside the merge commit. The two skips, the security skip (if approved) and the Hub guard for upstream's owner bootstrap land as separate fork commits on top, each with its own tests. The merge commit keeps both parents, so the next sync starts from `08ee8cfb`.

**Tech Stack:** git (`merge`, `merge-file --diff3`), pnpm workspaces, Turbo, Biome, TypeScript, Vitest, Prisma migrations on Postgres, Lingui, Expo/EAS, Playwright (web), Electron.
    10|
## Global Constraints

- Notation: `<old>`, `<Old>` and `<OLD>` stand for upstream's retired product name in lower, title and upper case. `packages/testkit/src/product-identity.test.ts` fails on any tracked file that spells it out (except `LICENSE` and `NOTICE`) or uses the old competitor-positioning phrase, so this plan never does. Upstream PRs are written "#N".
- Ours wins on branding: `@cortexai-agent-hub/*`, "CortexAI Agent Hub", `cortexai-agent-hub` paths, headers, labels, scheme, CSS prefixes and performance marks, `ghcr.io/tukatek/agent-hub/*` images, mobile id `com.tukatek.cortexai.agenthub`.
- Hub mode stays fail closed (CAAH-36). `HUB_POLICY_ENFORCEMENT=on|off` (CAAH-83) and its health output keep working. Direct OIDC and Stripe billing stay startup errors in Hub mode.
- Every new env var or feature flag defaults to off, or to today's behavior.
- Real merge commit: no squash, no rebase. **When this PR is merged, use "Create a merge commit".** Squash or rebase drops the upstream parent, and the next sync would conflict on all 157 commits again.
- The PR stays a draft. The agent never merges, deploys or touches production.
- Public repo: no secrets, hostnames, account names or personal data in commits, logs or the PR.
- Tests stay deterministic and offline. The desktop Electron Playwright suite runs only in CI.
    20|
---

## Inventory (taken Oct 20, 2026)

- `origin/main` = `3538284f` (CAAH-103, #52). `upstream/main` = `08ee8cfb` (#1535). Merge base = `afa31774` (#1355), the commit CAAH-88 merged.
- `main` is **157 commits behind** upstream (157 non-merge commits) and **80 ahead**. CAAH-97 (#50) cherry-picked 24 of the 157, so those come in again as duplicates.
- Trial merge (`git merge --no-commit --no-ff upstream/main`): **267 conflicting files**, of which 244 are content conflicts (**456 hunks**), 7 add/add and 16 modify/delete.
- **Rebrand-aware re-merge** (rebrand base and upstream with `scripts/upstream-rebrand.mjs`, then `git merge-file` against ours): **123 of the 244 content conflicts resolve cleanly**. **121 files with 210 hunks** remain, and 13 of those hunks are in `pnpm-lock.yaml`, which gets regenerated. About 30 of the rest only differ in import order or line wrapping (our files are Biome-formatted, and rebranded upstream lines are longer), so adding a Biome pass to the re-merge should clear most of them.
- **146 files merge cleanly but still contain upstream names** (workflows, compose, new upstream files). The sweep has to cover them too.
    30|- **Gap in the sweep:** our tree also renamed upstream's `rk-` CSS prefix (`rk-scroll`, `rk-chat-markdown*`, `rk-space-*`, `--rk-diagram-width`) and `rk:` keys (`rk:renderer:*` performance marks, `rk:preload-recovery*` storage keys) to `cortexai-agent-hub-` and `cortexai-agent-hub:`. `scripts/upstream-rebrand.mjs` has no rule for them, and upstream uses them in about 32 files. **The desktop app waits for `cortexai-agent-hub:renderer:shell-ready`**, so an unrenamed `rk:` mark in `Shell.tsx` breaks window-ready detection, and the CSS would silently fail to apply.

Reproduce:

```bash
git remote add upstream "$(grep -oE 'https://github.com/[^)]+' NOTICE).git"
git fetch upstream main
git merge-base origin/main upstream/main                 # afa31774
git rev-list --count afa31774..upstream/main             # 157
git merge --no-commit --no-ff upstream/main
    40|git diff --name-only --diff-filter=U | wc -l             # 267
git merge --abort
```

### Duplicates from CAAH-97

The 24 commits CAAH-97 cherry-picked (#1380, #1362, #1344, #1369, #1392, #1393, #1384, #1396, #1406, #1408, #1410, #1411, #1397, #1416, #1430, #1444, #1450, #1452, #1456, #1457, #1458, #1460, #1472, #1473) mostly merge as no-ops, because both sides contain the same change. They conflict only where upstream edited the same lines again later (for example #1412 and #1476 on top of #1458 and #1460 in `chat-sdk-surface.ts` and `team-chat-bridge.ts`), or where CAAH-97 deliberately diverged. **The one deliberate divergence is the model fallback:** CAAH-97 kept CAAH-96's `fallbackAwareModelStream`, kept the subagents' own fallback state, and resolved #1392's wrapper and `executeSubagent` hunks to ours (see `docs/plans/caah-97-upstream-sync.md`, "One fallback path"). This merge keeps that resolution.

The two migrations CAAH-97 brought in (`20261014120000_run_retry_of_run` and `20261014120001_runs_retry_of_run_id_key_concurrent`) are byte-identical on both sides, so the merge doesn't change them.

---
    50|
## Merge strategy

1. **One real merge of `upstream/main`.** It records `08ee8cfb` as merged, so the next sync only sees commits after it. Cherry-picking or merging up to `08ee8cfb^` would leave the 157 commits (or the Dutch commit) "unmerged" for git, and the next sync would face them again.
2. **Skips are fork commits on top of the merge, not omitted hunks.** Honcho and Dutch are removed in their own commits after the merge commit. Resolving them away inside the merge would hide the skip from reviewers and from the next sync. Cost on future syncs: when upstream edits a removed file (for example `apps/web/src/locales/nl/messages.po` after a copy change), git reports a modify/delete conflict, which is resolved with `git rm`. The re-merge script does that automatically for a fixed list of skipped paths.
3. **Rebrand-aware re-merge, kept as a reusable script.** `scripts/upstream-remerge.mjs` does what the trial did by hand: for each content conflict it takes stages 1, 2 and 3, rebrands and Biome-formats stages 1 and 3 (and Biome-formats stage 2), runs `git merge-file --diff3`, and stages the file if it resolves cleanly. For conflicts it can't resolve, it writes the diff3 result into the working tree. It also `git rm`s skipped paths and rebrands every file that merged cleanly. The next sync starts with this script.
4. **Behavior reconciliations that the merge alone can't make** (CAAH-72 attachment checks, health, Auth.tsx, the lazy computer in `executor.ts`) are resolved inside the merge commit so the merge commit builds. Each one is listed below with the test that proves it.

---

## Must stay intact, and how each one is proven
    60|
| Fork feature | Where the merge touches it | Resolution | Proof |
|---|---|---|---|
| Hub SSO and email-first sign-in (CAAH-58, #20) | `apps/web/src/pages/Auth.tsx` (3 hunks), `apps/mobile/lib/api.ts`, `apps/mobile/lib/android-platform-contract.test.ts`; Better Auth 1.7.7 → 1.7.10 (#1500, `packages/auth/package.json`, branding-only conflict) | Keep all our Hub and email-first code. Upstream #1385 moved the show/hide password button into the shared `Input`, so our own Eye toggle in the email-first password block must go (a manual edit outside the conflict), or the field shows two toggles. Never downgrade Better Auth; fix the Hub plugin if 1.7.10 breaks it. | `apps/web/src/pages/Auth.sso.test.tsx`, `Auth.test.tsx`, `e2e/login-card.spec.ts` (one "Show password" button), `packages/auth/src/hub*.test.ts`, `hub.postgres.test.ts`, the CAAH-88 Hub e2e in `settings-shell.spec.ts`, and a kept Hub-only case in `android-platform-contract.test.ts` (upstream #1553 deleted the test that held our two mobile Hub assertions). |
| Hub policy enforcement (CAAH-36, CAAH-83) | `apps/api/src/app.ts`, `apps/worker/src/index.ts`, `apps/api/src/health.ts`, `health.test.ts` | Keep `authorizeUserWork: createUserWorkAuthorizer(...)` in the API and the worker next to upstream's new `maxUploadSizeBytes`. Merge `/ready` as `healthRoutes(details, database?)`: `details` stays async and keeps `hubPolicyHealth(...)`, and `/ready` awaits it and also runs upstream's database probe (#1517). Taking upstream's synchronous `details().degraded` would read `.degraded` off a Promise, so `/ready` would never report degraded. | `health.test.ts` (both Hub cases and upstream's database cases), `packages/auth/src/hub.test.ts`, `executor-routine-failure.test.ts` (Hub retry authorization), `apps/api/src/env.test.ts`. |
| Rebranding | Everywhere | Sweep with the new `rk-`/`rk:` rules, our `app.json` and package names, our `www` deletions (CAAH-88 D4). | `product-identity.test.ts`, `scripts/upstream-rebrand.test.mjs`, `rg -nP '(?<![\w-])rk[-:]' apps packages` prints nothing. |
| CAAH-95 tool-result spill | `executor.ts` (8 hunks), `pi-runtime.ts` (17 hunks), `boat-sandbox.ts` | **Three hidden breaks.** (1) Upstream #1465 made the run's computer lazy (`runComputer.get()`), so there is no `computer` variable any more. Our spill setup (`computer.kind === "desktop"` becomes `computerKind`), `spillToolResult`, the `list_files`/`read_file` handlers and the PR #27 download target must call `await runComputer.get()`, and keep the `unavailable: "no-computer"` path when it throws. (2) #1317 wrapped each tool call in `withPiTelemetrySpan` and re-indented the body, so our `resultLimit`, `delivered`, `spillTarget` and `deliverAgentToolResult`/`deliverSerializedToolResult` must be re-applied inside the span by hand. Taking upstream there silently drops the spill. (3) The auto-merged spill line in `boat-sandbox.ts` refers to `BOX_WORKSPACE`, which #1550 renamed to `BOAT_WORKSPACE`. | `executor-tool-result-spill.test.ts`, `tool-result-spill.test.ts`, `pi-runtime-tool-dispatch.test.ts`, `pi-runtime-limits.test.ts`, `boat-sandbox.test.ts`, `computer-support.test.ts`. |
| CAAH-96 idle-timeout retry | `pi-runtime.ts`, `pi-runtime-fallback.test.ts` | Keep our `fallbackAwareModelStream`, its stall budget, its sticky switch, our `provider-retried` step and our subagent `FallbackStreamState`. Drop upstream's subagent `retryState`. Graft #1515 (retry once without thinking blocks bound to a different conversation) into our wrapper: add `dropThinkingBlocks` to `FallbackStreamState`, use upstream's `requestContext()` in `resolveNext` and both `state.stream` calls, and add one before-output branch that sets the flag and retries. The branch logs one `model call` line per attempt. | `pi-runtime-stall-retry.test.ts`, `pi-runtime-stream-idle.test.ts`, `pi-runtime-fallback.test.ts` (ours plus upstream's 3 thinking-block tests), `thinking-signatures.test.ts`, `model-errors.test.ts`. |
| CAAH-98 memory failure reporting, with upstream `36499e52` | `memory-tools.ts`, `memory-tools.test.ts`, `executor.ts` imports | No collision. `36499e52` changes the file-memory `remember` tool: it appends a fact with `appendMemoryFact`, commits with `expectedRevision`, retries on a revision conflict, and runs `remember` sequentially. CAAH-98 wraps the semantic `save_memory`/`recall_memory`/`forget_memory` tools in `runMemoryTool` and audits them with `memoryToolAuditSummary`. Union: keep all three functions and both sets of tests. | `memory-tools.test.ts`, `executor-memory-tools.test.ts`, `supermemory-client.test.ts`, `executor-effect-idempotency.test.ts`. |
| CAAH-103 mobile `app.json`/EAS and the Mobile EAS config job | `apps/mobile/app.json`, `apps/mobile/package.json`, `.github/workflows/ci.yml` (clean merge) | Keep our owner, slug, `extra.eas.projectId`, updates URL and `version` `1.0.4` (upstream is at 1.0.6). EAS reads the version remotely, and the runtime version follows the app version, so the release line stays ours. Keep our Expo package versions (CAAH-67 already took the same bumps). The `mobile-eas-config` job is ours and isn't touched. | `apps/mobile/lib/eas-project.test.ts`, `release-apk-workflow.test.ts`, CI "Mobile EAS config". |
| PR #28 Composio stack | `apps/api/src/app.ts`, `apps/worker/src/index.ts` | Not in a conflict hunk; the stack wiring auto-merges. Check that `createIntegrationConnectorStack` is still used in both. | `integration-provider-settings.test.ts`, `packages/testkit/src/composio-health.test.ts`, `apps/api/src/router.test.ts`. |
| CAAH-72 attachments (not in the ticket, but a security rule) | `apps/api/src/artifacts.ts`, `packages/core/src/attachments.ts`, `packages/contracts/src/attachments.ts` | **Two macro-Office bypasses if taken as upstream.** (1) Upstream's inbound `storeInboundAttachment` falls back to the reported MIME type when `inferAttachmentMimeType` returns nothing. It returns nothing for blocked extensions, so a Slack `.docm` reported as a `.docx` type would be stored. Keep our check, which throws on an empty inferred type. (2) Upstream's audio-alias early return (#1474) now runs before our blocked-extension check, so a `.docm` reported as `audio/mp3` would be stored. Move the blocked-extension check first. Keep both the Office and the audio MIME lists. | `apps/api/src/artifacts.test.ts` ("refuses a macro-enabled Office file before downloading it"), `packages/core/src/attachments.test.ts`, `packages/contracts/src/attachments.test.ts`, `ArtifactFileCard.test.tsx`, plus a new case: a `.docm` reported as `audio/mpeg` is rejected. |
| CAAH-87 modern desktop, CAAH-89 MCP pages, PR #27 file download | supervisor `index.ts`, `lazy-tool-catalog.ts`, `mcp-connector.ts`, `executor.ts` | Supervisor hunks are #1544 `restoreControl` additions, so take upstream; the desktop build list stays ours. In `lazy-tool-catalog.ts`, put #1508's group-qualified names into our `findCatalogEntry`. The page budget binds a name only when exactly one tool matches, and never throws. PR #27: see the lazy-computer note above. | `desktop-config.test.ts`, `desktop-runtime.test.ts`, `lazy-tool-catalog.test.ts`, `mcp-result-budget.test.ts`, `bot-secrets.test.ts` (100 MB cap), `executor-secret-pi.test.ts`. |
    72|
---

## Skips

| Item | Upstream | Kind | Technical reason | How |
|---|---|---|---|---|
| Honcho memory provider | #1361 (`7d327344`) | **Planned** (ticket) | Policy skip from the ticket. It's self-contained: no DB column or contract enum, and only #1553 (a test cleanup) touches it later. | A fork commit after the merge deletes `honcho-client.ts`, `honcho-memory-provider.ts` and their tests, `HonchoSettingsForm.tsx`, the registry entry, the factory case, the `index.ts` export, the `ai-consent.ts` entry, the Honcho cases in `persist-memory-provider-config.test.ts` and `ai-consent.test.ts`, and the Honcho e2e in `settings-shell.spec.ts`. Then it re-extracts the catalogs. |
| Dutch locale | #1535 (`08ee8cfb`, upstream's tip) | **Planned** (ticket) | It can be separated cleanly, so it's skipped rather than left unexposed. The commit also carries two general fixes, which are kept: dictation follows the UI language when that isn't English, and a `translationIds` scanner in the mobile i18n test. | A fork commit after the merge deletes `apps/web/src/locales/nl/messages.po` and `apps/mobile/lib/locales/nl.ts`, and removes `nl` from `lingui.config.ts`, both `ui-locale.ts`, both `i18n.ts`, `SPEECH_LOCALE_TAGS` in `dictation.ts` (typed by the locale list, so an extra key fails typecheck), the nl test cases and the README language list. CI's "Check translation catalogs are current" job needs `nl` gone from `lingui.config.ts`, or `intl:extract` recreates the catalog. |
| Android cleartext HTTP for LAN servers | #1376 (`890073f0`) | **Proposed technical skip, needs approval** (D1) | CAAH-97 skipped it on purpose: it lets release Android builds talk plain HTTP to LAN and local hosts, which weakens transport security for a hosted product. Our builds always use the HTTPS Hub-hosted API, so nothing depends on it. No later upstream commit depends on the plugin. | Inside the merge: `git rm apps/mobile/plugins/with-lan-cleartext.js`, drop its auto-merged line from `app.json`, and keep our `sed … usesCleartextTraffic` line in `.github/workflows/mobile-android-screenshots.yml`. Keep upstream's JS guard in `computer.ts` (it only rejects public `http:` screens). |
| Upstream marketing pages | #1358, #1368, #1407, the #1550 edits to deleted pages | Standing decision (CAAH-88 D4) | We deleted these pages because they describe upstream's company and product. The comparison pages also fail `product-identity.test.ts`. The 14 modify/delete files are pages and assets we already deleted, and upstream's new images under `apps/www/public/graphics/grok/` and `RichText.astro` are only used by those pages. | Keep our deletions. Don't add the new orphaned images or `RichText.astro`. Take `LandingBotAvatar.tsx` (#1407 organic avatars), which is on our landing page. |

Nothing else is skipped. Railway computers (#1530, #1445, #1342), desktop releases and local computer access (#1545, #1548, #1519), search providers (#1522, #1439), all UI polish, voice calls and the self-hosted voice provider (#1398, #1495), fleet tools (#1502), the Box to Boat rename (#1550), Hebrew (#1491) and the rest all come in.

---

## Conflict resolution, file by file
    90|
These are the 121 files (210 hunks) left after the rebrand-aware re-merge, plus the 23 add/add and modify/delete files. "Take upstream, format" means the only difference is import order or wrapping. The re-merge script's Biome pass should clear most of these before anyone opens them.

### Adapters and adapter-kit (32 files)

| File | Hunks | Resolution |
|---|---|---|
| `packages/adapters/src/pi-runtime.ts` | 17 | Port (CAAH-95 and CAAH-96 rows above). Imports: keep our adapter-kit block, and add `BOT_INSTRUCTIONS_MAX_LENGTH`, `canonicalPiProviderId` and `FLEET_TOOL_NAMES` to the contracts import and `MISSING_TOOL_FINAL_RESPONSE_ERROR` to the core import. Take upstream's sequential `remember`. Drop the old local `errorFacts`/`isRetryableProviderUnavailable` and keep `logModelCall`. |
| `packages/adapters/src/executor.ts` | 8 | Port. Union every import and dependency (`authorizeUserWork` with `maxUploadSizeBytes`; `appendMemoryFact`, `memoryToolAuditSummary`, `runMemoryTool`, `selectMemoryTools`). Take upstream `hostEnvironment`/`hostInstruction` but keep our `WORKSPACE_DELIVERY_INSTRUCTION`. Keep our spill block, then upstream `fleetRun`. Rename our `applyTool` to upstream's `dispatchTool` and keep both `spillToolResult` and upstream's `applyTool` wrapper. Move every use of the eager `computer` to the lazy computer. |
| `packages/adapters/src/lazy-tool-catalog.ts` | 2 | Port #1508 into our `findCatalogEntry`/`catalogResultBudgets` split (CAAH-89 row above). |
| `packages/adapters/src/chat-sdk-surface.ts` | 4 | Take upstream (#1412 mounted platforms and #1476 build on our cherry-picked #1460). |
| `packages/adapters/src/chat-sdk-surface.test.ts` | 3 | Take upstream (a superset of our cherry-picked tests). |
| `packages/adapters/src/pi-runtime-fallback.test.ts` | 3 | Union: our CAAH-96/97 tests, plus upstream's thinking-block `describe`. Drop the classifier `describe` (it lives in `model-errors.test.ts`). |
| `packages/adapters/src/pi-runtime-tool-dispatch.test.ts` | 3 | Take upstream (superset: the sequential test now includes `remember`, plus the #1504 `spawn_bot` test). Keep our CAAH-95 dispatch tests, which are outside the hunks. |
| `packages/adapters/src/memory-tools.ts`, `memory-tools.test.ts` | 1, 2 | Union (CAAH-98 row above). |
| `packages/adapters/src/pi-usage.ts`, `pi-usage.test.ts` | 2, 1 | Union imports: our sorted adapter-kit block, one undici `Agent`, and upstream's `pi-telemetry.js` and `AgentRuntimeEvent`. |
| `packages/adapters/src/messaging-platforms.ts` | 2 | Take upstream (both sides removed the Slack mention helpers; upstream adds `slackPlatformError`). |
| `packages/adapters/src/boat-sandbox.ts`, `boat-sandbox.test.ts` | 1, 1 | Take upstream, then change the auto-merged CAAH-95 line to `workspaceRoot: BOAT_WORKSPACE` and delete our leftover `BOX_*` constants. Also fix an existing bug: `terminateCommand`'s bracketed process pattern was never rebranded, so it never matches. It becomes `"[c]ortexai-agent-hub"`. |
| `packages/adapters/src/mcp-connector.ts`, `mcp-connector.test.ts` | 1, 1 | Union: `readOnly` (upstream) and `...mcpResultBudget(tool)` (CAAH-89). Keep our test fixture type. |
| `packages/adapters/src/builtin-tools.ts` | 1 | Union imports (`messageUserMaxLength` and `SPILL_PAGE_CHARS`). |
| `packages/adapters/src/history-compaction.ts` | 1 | Union: `escapePromptData` and `withHubModelDefaults`. |
| `packages/adapters/src/model-selection.ts`, `model-selection.test.ts` | 1, 1 | Union: upstream's contracts block and our `withHubModelDefaults` / `setHubManagedDeploymentSettings`. |
| `packages/adapters/src/model-connect.ts`, `pi-credentials.ts` | 1, 1 | Union imports. |
| `packages/adapters/src/pi-models.ts`, `pi-session.ts` | 1, 1 | Take upstream (#1501 removed `pi-current-models.ts` and the old session imports). |
| `packages/adapters/src/job-reconciler.ts` | 1 | Take upstream (superset: adds `reconcileCallRequests`). |
| `packages/adapter-kit/src/index.ts` | 1 | Union: `media-generation.js` and `model-errors.js` exports. |
| `packages/adapters/src/child-bots.ts`, `e2b-sandbox.ts`, `executor-readonly-approval.test.ts`, `host-aware-sandbox.ts`, `thread-artifacts.ts`, `wakeup.ts` | 1 each | Take upstream, format. In `e2b-sandbox.ts`, keep a single `@e2b/desktop` import. |
| add/add `packages/adapter-kit/src/model-errors.test.ts` | – | Keep ours (one extra test). `model-errors.ts` is identical on both sides. |
| add/add `packages/adapters/src/executor-routine-failure.test.ts` | – | Union: upstream's two new mocks (`acquireDedicatedScreenLeaseFence`, `user.findUnique`) and all of our Hub authorization fields and tests. |
| add/add `packages/adapters/src/pi-runtime-helper-framing.test.ts` | – | Take upstream (ours mocks the removed `pi-current-models.js`; upstream adds the fleet-tool cases). |
| add/add `automated-messages.ts`, `automated-messages.test.ts`, `pi-runtime-truncated-stream.test.ts` | – | Identical apart from formatting. Keep ours. |

### API, worker, supervisor, db, core, contracts, chat-ui (29 files)

| File | Hunks | Resolution |
|---|---|---|
| `apps/api/src/app.ts` | 5 | Drop the unused `randomUUID`. Union `storeInboundAttachment` and `authCapabilities`. Keep `authorizeUserWork` and add `maxUploadSizeBytes`. Take upstream `storeInboundAttachment(…, maxUploadSizeBytes)`. Port `healthRoutes` (Hub policy row above). |
| `apps/api/src/health.ts`, `health.test.ts` | 2, 1 | Port (Hub policy row above). Union the test imports and keep both test sets. |
| `apps/api/src/env.ts` | 1 | Union: `readFileSync` (Hub secret files) and `TelegramBotCredentials` (#1412). Our Hub/OIDC/Stripe guards are outside the hunk and survive. |
| `apps/api/src/artifacts.ts`, `artifacts.test.ts` | 5, 7 | Take upstream (#1440 limit, #1474 audio), but keep our empty-type rejection in `storeInboundAttachment` (CAAH-72 row above). In the tests, union upstream's audio and limit suites with our macro-Office and zip tests. |
| `apps/api/src/team-chat-bridge.ts`, `team-chat-bridge.test.ts` | 3, 2 | Take upstream (#1476 acknowledge, and the #1465 lazy computer in tests, on top of our cherry-picked #1458/#1460/#1452). |
| `apps/api/src/models-backups.test.ts`, `routine-runs.ts`, `voice.test.ts` | 1 each | Take upstream, format. |
| `apps/worker/src/index.ts` | 3 | Union imports (`createUserWorkAuthorizer`, `phoneCallSettings`). Take upstream's env helpers. Keep `authorizeUserWork` and add `maxUploadSizeBytes: uploadSizeFromEnv(process.env)`. |
| `infra/sandboxes/supervisor/src/index.ts` | 4 | Take upstream (#1544 `restoreControl`). Check that the CAAH-87 image build list is still ours. |
| `infra/sandboxes/supervisor/src/computer-loopback.test.ts`, `page-browser-route.test.ts` | 5, 1 | Take upstream (supersets of our cherry-picked tests), format. |
| `infra/sandboxes/supervisor/package.json` | 1 | Union: our `ui-tokens` dev dependency and `@types/dockerode` 4.0.2. |
| `packages/chat-ui/src/markdown.web.tsx`, `markdown.web.css` | 1, 2 | Take upstream (#1423 Mermaid), with every new `rk-` class and variable renamed. CAAH-72 link handling auto-merges intact. |
| `packages/contracts/src/attachments.ts`, `attachments.test.ts` | 1, 2 | Union: Office and audio MIME lists, and both test sets. |
| `packages/core/src/attachments.ts`, `attachments.test.ts` | 3, 1 | Keep importing `ATTACHMENT_ALLOWED_MIME_TYPES` and drop `ATTACHMENT_MAX_BASE64_LENGTH`. Take upstream `call_request` and `reaction`. Move the blocked-extension check above the audio aliases. |
| `packages/core/src/index.ts` | 1 | Union exports (`instruction-diff.js`, `hub-managed-deployment.js`). |
| `packages/core/src/messaging-prompts.test.ts` | 1 | Take upstream's deletion (#1553) but keep our CAAH-72 "attached files are not mirrored" test. |
| `packages/core/src/node/desktop-runtime.test.ts` | 1 | Union: our CAAH-87 tests and upstream's #1542/#1544 tests. |
| `packages/db/src/client.test.ts` | 1 | Take upstream's deletion (#1553). |
| `packages/db/src/events.ts`, `events.test.ts`, `repos.ts` | 1, 2, 1 | Take upstream (supersets of our cherry-picked code), format. |
| add/add `apps/api/src/takeover-chat.postgres.test.ts` | – | Identical apart from import order. Keep ours. |
| add/add `packages/db/src/steering-replay.postgres.test.ts` | – | Take upstream (adds 3 #1502 tests; the helpers they import already exist). |

### Web, mobile, www, docs, root (60 files plus 16 add/add and modify/delete)

| File | Hunks | Resolution |
|---|---|---|
| `apps/web/src/pages/Auth.tsx` | 3 | Keep ours, minus `Eye`/`EyeOff`/`showPassword`. Replace our password wrapper with `<Input ref={passwordRef} type="password" …>` (Hub SSO row above). |
| `apps/web/src/pages/Shell.tsx` | 3 | Take upstream for imports. Union `markShellReady()` with our `cortexai-agent-hub:renderer:shell-ready`/`shell-painted` marks. Union `HoldToTalkControls` with our brand button classes. Also fix our leftover `rk-scroll`. |
| `apps/web/src/pages/AccountSettingsOverlay.tsx` | 2 | Take upstream (#1438 `ListboxSelect`, #1446 timezone). Our Hub account controls are outside the hunks. Rename `rk-scroll` in the new `ListboxSelect.tsx`. |
| `apps/web/src/pages/ModelSettingsOverlay.tsx` | 2 | Union imports (`ImageOff`). Take upstream's Popover picker and rename its `rk-scroll` uses. |
| `apps/web/src/pages/SettingsOverlay.tsx`, `apps/web/src/styles.css` | 1, 1 | Take upstream (#1438, #1446, #1466), with `rk-scroll`/`rk-space-*` renamed to match `lib/space-switch.ts`. Keep `.cortexai-agent-hub-scroll`. |
| `apps/web/src/lib/bootstrap.ts`, `main.tsx`, `preload-recovery.ts` | 1 each | Take upstream (#1466, #1349, #1543), with the `rk:` marks and storage keys renamed. |
| `apps/web/src/lib/dictation.ts` | 1 | Take upstream (#1374, #1491, #1535 recognition language). The Dutch commit removes `nl`. |
| `apps/web/src/components/ArtifactFileCard.tsx` | 1 | Union imports (#1474 audio). Check that CAAH-72 download-only still wraps the new audio branch. |
| add/add `apps/web/src/components/ArtifactFileCard.test.tsx` | – | Union on upstream's harness: our `DOWNLOAD_ONLY_TYPES` and PDF tests, and upstream's audio tests. |
| modify/delete `apps/web/src/components/AskCard.test.tsx` | – | Take upstream's deletion (#1553). |
| `AskCard.tsx`, `CallCard.tsx`, `VoiceChatCard.tsx`, `FilesApp.tsx`, `GroupPanel.tsx`, `KnowledgeSection.tsx`, `RoutineEditor.tsx`, `ActivityList.tsx`, `bot-profile-patch.ts`, `call-session.test.ts`, `e2e/fixtures/marketing-shots.tsx` | 1–2 each | Take upstream, format. In `FilesApp.tsx`, drop `ATTACHMENT_MAX_BYTES`; in `ActivityList.tsx`, drop the `@lingui/core` import. |
| `apps/web/e2e/settings-shell.spec.ts` | 1 | Keep ours (the Hub account test). Drop upstream's Honcho test (planned skip). |
| `apps/web/src/locales/*/messages.po` (10) | 1 each | Union, then run `intl:extract` and `intl:compile` after `nl` is out of `lingui.config.ts`. Fork-only messages stay untranslated in the new `he` catalog, as in other catalogs. |
| `apps/mobile/app.json` | 1 | Keep ours (`1.0.4`). Drop the auto-merged cleartext plugin line (D1). |
| `apps/mobile/package.json` | 1 | Keep ours (the same versions, already bumped by CAAH-67). No duplicate keys. |
| `apps/mobile/lib/android-platform-contract.test.ts` | 1 | Take upstream's deletions (#1553), but keep a small "routes Hub accounts through Hub sign-in" test with our two assertions. |
| `apps/mobile/lib/api.ts` | 1 | Union: our `hub/sign-in` URL and upstream's `invalidJson` (#1488). |
| `apps/mobile/lib/bot-lifecycle.ts`, `app/routine.tsx` | 1, 1 | Union: upstream's guards and conditionals with our "Assistant" wording. |
| `apps/mobile/app/(settings)/_layout.tsx`, `account.tsx`, `archived-bots.tsx` | 1 each | Take upstream (#1359: "Archived" now lists chats and groups). Keep "Could not restore Assistant" at the auto-merged call site. |
| `apps/mobile/lib/account-delete.test.ts` | 1 | Take upstream's deletion (#1553). |
| `apps/mobile/app/_layout.tsx`, `app/index.tsx`, `lib/computer.ts` | 1, 2, 1 | Take upstream (#1435/#1442/#1510 split view and search; the #1376 JS guard). Keep the index screen title "CortexAI Agent Hub". |
| `apps/mobile/lib/i18n.test.ts`, `lib/locales/{de,ru,zh}.ts` | 1, 2 each | Union keys. Drop "Archived Assistants" (no longer used) and the "server address" string #1484 removed. Dutch references go in the Dutch commit. |
| `apps/www/src/components/LandingBotAvatar.tsx` | 1 | Take upstream (#1407). |
| `apps/www/src/styles/global.css` | 1 | Keep ours (the new rules only style deleted pages). |
| modify/delete: 14 `apps/www` pages and assets (`alternatives.ts`, `grok-alternative.ts`, `guide.ts`, `roundup.ts`, three blog posts including `openclaw-vs-hermes-vs-<old>.md`, the comparison and self-hosting pages, `ArchitectureDiagram.astro`, `CaptionedImage.astro`, `public/graphics/architecture.svg`) | – | Keep our deletions (CAAH-88 D4). |
| `.env.example`, `docs/self-host.md`, `docs/computer-runtime.md`, `SETUP_PROMPT.md`, `README.md`, `CHANGELOG.md` | 1–2 each | Union: our CAAH-95/96 settings, image names and "Assistant" wording, plus upstream's Boat, Docker-retention and message-cap text. README takes Boat; the Dutch commit removes "Nederlands". CHANGELOG keeps both sets of entries. |
| `package.json`, `pnpm-lock.yaml` | 1, 13 | Keep our `sharp` and take upstream's versions. Regenerate the lockfile with `pnpm install`, never hand-merge it. |

---

## Database migrations (for DevOps)

Upstream adds 10 migrations. Two are already in our tree from CAAH-97 and are byte-identical, so **8 are new** for a database that has CAAH-97 deployed, and 10 for one that doesn't. None touch a Hub table. `packages/db/prisma/schema.prisma` merges cleanly.

| Migration | New? | Effect | Deploy note |
|---|---|---|---|
| `20261011120000_bot_instruction_history` | yes | `bots.selfUpdateInstructions` (default `false`), `instructionHistory` (default `[]`), `pendingInstructionsRunId` | Dated before the CAAH-97 migrations, so it applies out of order. `prisma migrate deploy` applies it; `migrate dev` may report drift on developer databases. |
| `20261014120000_run_retry_of_run` | already applied by CAAH-97 | `runs.retryOfRunId` | No-op if CAAH-97 is deployed. |
| `20261014120001_runs_retry_of_run_id_key_concurrent` | already applied by CAAH-97 | `CREATE UNIQUE INDEX CONCURRENTLY` | No-op if CAAH-97 is deployed. |
| `20261015120000_organic_avatar_default` | yes | `user.avatarStyle` default becomes `organic` | Only new users; existing rows unchanged. |
| `20261017120000_computer_running_since` | yes | `computers.runningSince`, set to now for running computers | Starts the uptime clock for the cap (see `COMPUTER_MAX_ACTIVE_MS`, D2). |
| `20261017120001_user_timezone` | yes | `user.timezone` (nullable) | – |
| `20261018120000_bot_fleet_management` | yes | `bots.fleetManagement` (default `false`) | Fleet tools stay off for every bot. |
| `20261019000000_routine_watch` | yes | `routines.watch`, `watchState` (nullable, `IF NOT EXISTS`) | Existing routines keep their triggers. |
| `20261019010000_call_recovery_index` | yes | Partial expression index on `messages` | **Not `CONCURRENTLY`**: it blocks writes to `messages` while it builds. The partial predicate keeps it small, but DevOps should time it on a production-sized copy first. |
| `20261020000000_rename_box_computers_to_boat` | yes | `UPDATE computers SET kind = 'boat' WHERE kind = 'box'` | Keeps existing Box computers reconnecting. A no-op if we never used Box. Rolling back the app after this runs leaves those rows unknown to the old code. |

---

## New env vars and feature flags (for DevOps)

Every new flag defaults to off or to today's behavior, except one (D2). Upstream names with `<OLD>_` become `CORTEXAI_AGENT_HUB_` through the sweep.

| Setting | Default | Notes |
|---|---|---|
| `PHONE_CALLS_ENABLED`, `PHONE_CALL_COOLDOWN_MINUTES`, `PHONE_CALL_RING_SECONDS` | `false`, 2, 45 | Voice calls and hold-to-talk (#1398). Set on the API and the worker together. |
| Self-hosted voice provider (#1495) | not configured | Chosen in settings; nothing changes until configured. |
| `bots.fleetManagement` | `false` per bot | Fleet tools (#1502). They also only run on owner-started runs. |
| `bots.selfUpdateInstructions` | `false` per bot | Bots proposing instruction updates (#1316). |
| `MEDIA_GENERATION_PROVIDER` and its `_BASE_URL`, `_API_KEY`, `_IMAGE_MODEL`, `_VIDEO_MODEL` | `disabled` | Image and video generation (#1441). |
| `KEENABLE_API_KEY` (#1522), Parallel key (#1439) | unset | Optional web search providers. |
| `RAILWAY_API_TOKEN`, `RAILWAY_ENVIRONMENT_ID`, `RAILWAY_SANDBOX_REGION`, `RAILWAY_MAX_WORKSPACE_FILE_BYTES` | unset, 64 MiB | Railway computers (#1341, #1445, #1530). Used only with `SANDBOX_PROVIDER=railway`. |
| `BOAT_API_KEY`, `BOAT_API_URL` | unset | Replace `BOX_*`. `SANDBOX_PROVIDER=box`, `BOX_API_KEY`, `BOX_API_URL` and `BOX_BASE_URL` still work. The default API is now Boat's; a deployment that set `BOX_API_URL` to the old Box URL should drop it. CI's manual Boat e2e reads a `BOAT_API_KEY` repository secret. |
| `SANDBOX_HOST_URL`, `SANDBOX_HOST_TOKEN` | unset | Local computer access (#1519). Set only by the desktop app for its own local stack, and only after the user consents. Never for a remote server. |
| `SANDBOX_COMPUTER_DNS` | unset | Docker computers only (#1521). |
| `COMPUTER_MAX_ACTIVE_MS` | off (`0`) | Caps uptime on billing providers (#1465). Upstream defaults to 2 hours; D2 keeps it off here. |
| `MAX_UPLOAD_SIZE_MB` | 10 | Today's fixed limit (#1440). |
| `CORTEXAI_AGENT_HUB_MESSAGE_USER_MAX_CHARS` | 500 | Today's cap (#1453). |
| `CORTEXAI_AGENT_HUB_BROWSER_UPLOAD_MAX_BYTES` | upstream default | Bots attaching files to upload fields (#1469). |
| `OTEL_EXPORTER_OTLP_ENDPOINT` and related `OTEL_*` | unset | Telemetry export is off without an endpoint (#1317). `OTEL_CAPTURE_CONTENT=false`. The sweep renames the default service name. |
| `SENTRY_DSN`, `SENTRY_BROWSER_DSN`, `SENTRY_ENVIRONMENT`, `SENTRY_RELEASE` | unset | Error reporting is off without a DSN (#1349). |
| `TELEGRAM_BOT_TOKEN_<NAME>` and its webhook secret | unset | Extra Telegram bots (#1412). |
| `OWNER_EMAIL`, `OWNER_PASSWORD`, `MIN_FREE_GB` | unset | Railway template (#1342) and deploy disk checks (#1516). See D3. |

Behavior that changes without a flag: Slack adds 👀 to a mention or DM when the reply is more than a minute late (#1476, needs the `reactions:write` scope; Task 7 checks that a missing scope doesn't break the reply). Computers start only when a run uses them (#1465). New users get organic avatars. Routines can run on a watched change (#1462). The bot sees the user's saved timezone (#1446). Group chats allow up to 10 bots (#1405). Upstream also adds a `native-computer` CI job on macOS and Windows runners (#1519).

---

## Decisions for the PM

Approving the plan approves these defaults, unless you mark one otherwise.

- **D1. Keep skipping Android cleartext HTTP (#1376).** This is the only proposed technical skip (reason in "Skips"). If declined, the plugin comes in and release Android builds allow plain HTTP to LAN and local hosts.
- **D2. `COMPUTER_MAX_ACTIVE_MS` defaults to off in our fork.** Upstream caps computers on billing providers at 2 hours by default, which breaks the ticket's "new flags default to off" rule and could stop a long routine mid-run. Proposal: a one-line fork change making the code default `0`, with the setting documented so DevOps can opt in. It conflicts only if upstream edits that constant. The alternative is to take upstream's default and have DevOps set `0`.
- **D3. Upstream's Railway owner bootstrap refuses Hub mode.** `apps/api/src/cli/bootstrap-owner.ts` (#1342) creates a local password owner and turns sign-ups off. It runs only from the Railway template's `start.sh`, never from our compose deploy, but in Hub mode it would create a password user Hub can't use. Proposal: a fork commit that makes it exit with an error when `HUB_*` settings are present, with a test. The root `railway.json` comes in too. DevOps: if this repository is connected to a Railway project, check that the new file doesn't change its build settings.
- **D4. Mobile version stays `1.0.4`.** Our release line is ours (CAAH-103). Upstream's 1.0.5 and 1.0.6 bumps are dropped.
- **D5. Product copy.** Where upstream changed a string we had renamed to "Assistant", we keep our wording. New upstream strings keep upstream wording (CAAH-88 D7). Upstream's new mobile "Archived" title replaces our "Archived Assistants", because the screen now lists chats and groups.

---

## Tasks (phase 2, after approval)

### Task 1: Extend the rebrand sweep and add the re-merge script

**Files:** `scripts/upstream-rebrand.mjs`, `scripts/upstream-rebrand.test.mjs`, create `scripts/upstream-remerge.mjs` and `scripts/upstream-remerge.test.mjs`.

- [ ] Write failing tests for the new rules: `rk-scroll` → `cortexai-agent-hub-scroll`, `--rk-diagram-width` → `--cortexai-agent-hub-diagram-width`, `"rk:renderer:shell-ready"` → `"cortexai-agent-hub:renderer:shell-ready"`. Also test that words like `work-tree`, `fork-` and `dark-` don't change (the rule must not match `rk` inside a word).
- [ ] Add the rules: `(?<![\w-])rk-` → `cortexai-agent-hub-`, `--rk-` → `--cortexai-agent-hub-`, and `(?<![\w-])rk:` → `cortexai-agent-hub:`.
- [ ] Write `upstream-remerge.mjs`, which does the following for each unmerged path:
  - For a content conflict: write stages 1, 2 and 3 to a temp dir, rebrand stages 1 and 3, run `biome format` on all three, run `git merge-file --diff3`, and `git add` the file if it resolves cleanly. Otherwise write the diff3 result into the tree.
  - `git rm` paths on a fixed skip list (Honcho, Dutch, cleartext plugin, the CAAH-88 D4 `apps/www` pages).
  - Rebrand every file that merged cleanly, and report files that need a manual fix.
- [ ] Test the script on a fixture repository built in a temp dir (base, ours and upstream commits with a branding-only conflict and a real conflict). Expected: the branding conflict is staged, and the real one is left with diff3 markers.
- [ ] Commit: `CAAH-107: rebrand-aware re-merge for upstream syncs`.

### Task 2: The merge commit

- [ ] `git fetch upstream main` and check that `upstream/main` is still `08ee8cfb`. If upstream moved, stop and redo the inventory.
- [ ] `git merge --no-ff --no-commit upstream/main`, then `node scripts/upstream-remerge.mjs`. Expected: about 120 files left, or fewer after the Biome pass.
- [ ] Resolve by area, in this order: adapters, then API/worker/core, then web/mobile/docs, using the tables above. Regenerate `pnpm-lock.yaml` with `pnpm install`, then `pnpm install --frozen-lockfile` must succeed with no changes.
- [ ] Apply the hidden fixes the hunks don't show: the lazy computer in `executor.ts`, spill inside the telemetry span, `BOAT_WORKSPACE`, the Auth password field, the attachment check order, the `rk` sweep, and removing the cleartext plugin line from `app.json` (D1).
- [ ] `pnpm db:generate && pnpm lint && pnpm check`. Expected: PASS.
- [ ] `git diff --cached --check` and a search for conflict markers print nothing. `product-identity.test.ts` passes.
- [ ] Commit the merge: `Merge upstream main (08ee8cfb) into CortexAI Agent Hub (CAAH-107)`. `git log -1 --format=%P | wc -w` must print 2.

### Task 3: Skip Honcho (#1361)

- [ ] Delete the files and entries listed under "Skips", re-extract and compile the catalogs, and run `pnpm exec vitest run packages/adapters/src apps/api/src apps/web/src`. Expected: PASS, and `git grep -i honcho` prints nothing.
- [ ] Commit: `CAAH-107: skip the Honcho memory provider`.

### Task 4: Skip Dutch (#1535)

- [ ] Remove `nl` as listed under "Skips", keeping the dictation and scanner fixes. Run `intl:extract` (the catalog must not come back), `intl:compile`, and the web and mobile i18n, ui-locale and dictation tests. Expected: PASS.
- [ ] Commit: `CAAH-107: skip the Dutch locale`.

### Task 5: Fork guards from the decisions

- [ ] D2: test-first, `COMPUTER_MAX_ACTIVE_MS` unset means no cap. Change `DEFAULT_COMPUTER_MAX_ACTIVE_MS` to `0` and update `computer-idle.test.ts`, `.env.example` and `docs/self-host.md`.
- [ ] D3: test-first, `bootstrap-owner.ts` exits with "Owner bootstrap can't be combined with Hub sign-in" when `hubAuthFromEnv` finds Hub settings. Extend `bootstrap-owner.postgres.test.ts`.
- [ ] Add a regression test that a `.docm` reported as `audio/mpeg` is rejected, in `packages/core/src/attachments.test.ts`.
- [ ] One commit per guard.

### Task 6: Env documentation

- [ ] Add the flags from "New env vars and feature flags" to `.env.example`, `infra/compose/.env.images.example` and `docs/self-host.md`, with the defaults shown there. Commit.

### Task 7: Verification (this gates the push)

Record the results in words in the PR, with no pasted output.

- [ ] `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm db:generate && pnpm check`, `pnpm build`, `pnpm test`. Expected: PASS.
- [ ] Every test named in "Must stay intact" passes on its own, by name.
- [ ] Migrations on our current schema: start Postgres, check out `origin/main`, run `pnpm db:migrate` and seed with fixtures (including one `computers` row with `kind = 'box'` and one running computer). Then check out the branch and run `prisma migrate deploy` and `prisma migrate status`. Expected: 8 new migrations applied, the schema up to date, no drift, the `box` row now `boat`, and the running computer has `runningSince` set.
- [ ] `pnpm test:integration` (Postgres journeys, including Hub). Expected: PASS.
- [ ] Image checks: `pnpm sandbox:build`, the computer smoke tests and `pnpm test:compose-smoke`. Expected: CAAH-87 desktop processes running, and the image runs as uid 1000.
- [ ] Targeted checks against a local stack:
  - `HUB_POLICY_ENFORCEMENT=off`: Hub sign-in works and `/health` shows the policy as disabled. With `on` and Hub unreachable, sign-in fails closed and `/ready` reports degraded. With the database down, `/ready` fails.
  - `OIDC_ISSUER` or `STRIPE_SECRET_KEY` set in Hub mode: the API refuses to start.
  - A Slack `.docm` attachment is refused, and a `.docx` attachment is stored download-only.
  - An oversized tool result spills to the computer; a model stream stall retries twice and then switches to a backup; a rejected memory save reports failure; `remember` appends a fact without replacing memory.
  - A Slack bot token without `reactions:write`: a late reply still arrives, and the failed 👀 doesn't fail the run.
  - With phone calls, fleet tools, media generation, Sentry and OTel all unset, none of their UI or tools appear.
- [ ] CI on the pushed branch: all jobs green, including Mobile EAS config, Web E2E (screenshots of sign-in, settings and the computer view linked in the PR), desktop e2e, and upstream's new `native-computer` job.
- [ ] QA smoke on TukaTek after approval, run by QA, not the agent: SSO sign-in, chat, a routine run, a Slack thread with a file, memory recall, and a mobile build.

### Task 8: Push and update the draft PR

- [ ] Push, then update the PR with the resolution log (one line per file), the migrations, the env table for DevOps, test results in words and the CI screenshot links. Put **"Merge with 'Create a merge commit'. Do not squash or rebase."** at the top.
- [ ] Stay with CI and review bots at roughly 60-second intervals, and fix actionable feedback in new commits. Keep the PR a draft and never merge it.

---

## Risks

| Risk | Where | Mitigation |
|---|---|---|
| Spill silently lost | `pi-runtime.ts` telemetry span, `executor.ts` lazy computer | Port by hand; `executor-tool-result-spill.test.ts` and `pi-runtime-tool-dispatch.test.ts` are the gate. `tsc` catches the lazy-computer uses. |
| Idle-timeout retry regresses | `pi-runtime.ts` fallback wrapper | Keep ours; graft #1515; stall-retry and stream-idle tests are the gate. |
| Macro Office files through Slack or audio aliases | `artifacts.ts`, `core/attachments.ts` | Keep our checks, plus a new regression test. |
| Hub policy health or enforcement dropped | `app.ts`, `worker/index.ts`, `health.ts` | Union resolutions; health and Hub tests are the gate. |
| Better Auth 1.7.10 breaks the Hub plugin | `packages/auth` | Hub unit tests and Postgres journeys. Fix Hub code, never downgrade. |
| Desktop window never shows ready | `rk:` marks | New sweep rule, plus the `rg` check. |
| Branding leaks through 146 cleanly merged files | everywhere | Sweep plus `product-identity.test.ts`. |
| Write lock while the call-recovery index builds | `messages` table | DevOps times it on a production-sized copy. |
| A computer stopped after 2 hours | `COMPUTER_MAX_ACTIVE_MS` | D2. |
| Upstream moves before phase 2 | `upstream/main` | Task 2 checks the SHA; if it moved, redo the inventory and get re-approval. |
| PR squash-merged | GitHub merge button | Callout at the top of the PR and in this plan. |
