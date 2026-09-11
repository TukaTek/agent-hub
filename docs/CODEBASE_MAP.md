# Codebase Map: CortexAI Agent Hub (Rakazo foundation)

> Historical snapshot of the reviewed commit below. Later branding, authentication, and upstream changes supersede statements about current implementation. Consult the current code and documentation before acting on this snapshot.
_Last updated: 2026-09-02_
_Source: read-only repository and GitHub inspection at `0f5c4cefd59cdbe440deb7e05fd3f503164a6068` (`main`, `origin/main`, and `upstream/main`)_

## Executive Summary

`TukaTek/agent-hub` is currently an unmodified-at-head fork of `elie222/rakazo`: a TypeScript/pnpm/Turborepo application for persistent personal AI Assistants (internally still named `Bot`) across web, Electron, Expo mobile, voice, and external messaging. It owns its persistent execution state rather than delegating core conversation/run durability to a hosted agent framework.

The deployable product is not a static UI. The signed-in stack is a Hono/oRPC API, PostgreSQL/Prisma, Graphile Worker, React web client, and one selected computer/sandbox provider. The Pi runtime executes in the API/worker process and calls provider-neutral model, connector, memory, artifact, voice, web, and computer interfaces. A background reconciler recovers queued/expired work and scheduled routines.

This codebase fits CortexAI Agent Hub's accepted Phase 1 model well: one isolated deployment per customer, each user owning private persistent Assistants and Assistant teams. It is **not yet CortexAI-branded or Hub-integrated**. Hub OAuth/JWT/JWKS, CortexAI product entitlement, Hub policy/config delivery, and deployment registration are roadmap work, not current implementation.

The architecture is unusually broad and mature for the product stage, but three concentration points are high-risk: `apps/web/src/pages/Shell.tsx` (6,887 physical lines), `apps/api/src/router.ts` (4,146), and `packages/adapters/src/executor.ts` (3,875). The current approval model is connector-oriented and deliberately exempts shell, file, desktop, schedule, and subagent tools; it is not a universal governed effect gateway.

## Repository Identity

- GitHub fork: `https://github.com/TukaTek/agent-hub`
- Upstream: `https://github.com/elie222/rakazo`
- License: Apache-2.0
- Package/product name in code: Rakazo / `@rakazo/*`
- Reviewed commit: `0f5c4cefd59cdbe440deb7e05fd3f503164a6068`
- Baseline state: local `main`, `origin/main`, and `upstream/main` matched; worktree was clean before documentation was added.
- GitHub repository description still says “Open-source Grok Bot alternative.”
- The repository contains 999 tracked files. Physical tracked-line counts include 625 TypeScript files / 126,667 lines and 83 TSX files / 28,156 lines. These are physical lines, not semantic LOC.
- Test-like inventory: 313 tracked test/spec/E2E files; the largest test concentration is `packages/adapters` (106), followed by `apps/web` (66).

## Technology Stack

- Monorepo: pnpm 9.15 + Turborepo
- Runtime: Node `^22.22.2 || ^24 || >=26`
- Language: TypeScript 5.9
- Web: React 19, Vite, Tailwind, React Router, Lingui i18n, oRPC client
- Desktop: Electron/electron-builder; hosts the same web UI and adds server-selection/local-stack/update/native integration
- Mobile: Expo/React Native with Expo Router and secure native storage
- Marketing: Astro + React islands
- API: Hono + oRPC + Zod contracts
- Auth: Better Auth with email/password, bearer-session support, and organization plugin
- Database: PostgreSQL + Prisma; 69 tracked SQL migration files
- Durable jobs: Graphile Worker; in-memory queue only for deterministic test/emulated paths
- Agent runtime: Pi (`PiAgentRuntime`); scripted runtime for deterministic tests
- Computer providers: Docker supervisor, E2B, Daytona, Box, trusted desktop, fake, none
- Connectors: Composio, Pipedream Connect, user-installed MCP/Treg/OpenAPI sources
- Memory: durable Markdown/Prisma memory plus optional semantic-memory provider (currently Supermemory adapter)
- Voice: ElevenLabs, OpenAI, Cartesia, scripted adapter
- Messaging: Slack, WhatsApp, Telegram, Sendblue/iMessage-SMS through a provider-neutral messaging surface

## Top-Level Folder Map

- `apps/api` — Hono server, auth mounting, oRPC implementation, voice/webhook/messaging endpoints, health and composition root.
- `apps/worker` — Graphile job host, run executor, reconciliation leadership, scheduled/background operations.
- `apps/web` — primary React application and Playwright journeys.
- `apps/desktop` — Electron shell, local/remote server connection, local-stack lifecycle, packaging/update behavior.
- `apps/mobile` — Expo Router app and native notification/storage/voice integrations.
- `apps/www` — public Astro marketing site.
- `packages/contracts` — Zod domain and oRPC contracts shared across clients/server.
- `packages/core` — deterministic domain rules: run transitions, approvals, cron, attachments, secrets guards, UI-neutral utilities.
- `packages/adapter-kit` — provider-neutral interfaces and adapter context.
- `packages/adapters` — concrete Pi, sandbox, connector, messaging, voice, web, memory, jobs, artifacts, approvals, and orchestration adapters.
- `packages/db` — Prisma client, repositories, scoping, event/message transaction helpers, credentials, groups, spaces.
- `packages/auth` — Better Auth composition and new-user bootstrap hooks.
- `packages/memory` — durable Markdown memory store.
- `packages/chat-ui`, `packages/ui-tokens`, `packages/ui-web` — cross-client/rendering/design primitives.
- `packages/testkit` — integration, authorization, topology, canary, computer, and E2E harnesses.
- `infra/sandboxes` — computer image plus Docker supervisor.
- `infra/compose` — development, published-image, and production single-VM topologies plus hardening/backup files.
- `infra/updater` — opt-in root-equivalent Compose updater sidecar.
- `docs` — self-hosting, computer runtime, mobile release, and performance guidance.
- `packages/db/src/generated/prisma` — generated Prisma client; do not hand-edit.

## Entry Points

- API process: `apps/api/src/index.ts`; loads root env, calls `createApp`, serves Hono, and gracefully terminates SSE sockets (`apps/api/src/index.ts:1-39`).
- API composition: `apps/api/src/app.ts`; constructs DB/realtime/secrets/sandbox/MCP/connectors/runtime/worker handlers/auth/router, then mounts HTTP surfaces (`apps/api/src/app.ts:87-470`).
- Worker: `apps/worker/src/index.ts`; mirrors the production adapters, starts Graphile handlers, and elects one reconciliation leader through a PostgreSQL advisory lock (`apps/worker/src/index.ts:45-185`).
- RPC contract: `packages/contracts/src/rpc.ts`; typed surface for Spaces, Assistants, groups, threads, computers, memory, routines, skills, connectors, MCP, messaging, approvals, artifacts, usage, search, runs, and voice.
- RPC implementation: `apps/api/src/router.ts`.
- Run engine: `packages/adapters/src/executor.ts`.
- Web: `apps/web/src/main.tsx` → `apps/web/src/App.tsx` → `apps/web/src/pages/Shell.tsx`.
- Desktop: `apps/desktop/src/main.ts` with preload/static output.
- Mobile: `apps/mobile/app/_layout.tsx`; main Assistant list in `app/index.tsx`, thread experience in `app/thread.tsx`.
- Marketing: `apps/www/src/pages/*` and `apps/www/src/components/HomePage.astro`.

## Commands

From the repository root:

- `pnpm dev` — API + worker + web + sandbox supervisor.
- `pnpm build` — Turborepo production build.
- `pnpm check` — monorepo typecheck; mobile also runs `expo install --check`.
- `pnpm lint` — Biome lint/format verification.
- `pnpm test` — unit/property/in-process contracts.
- `pnpm test:integration` — PostgreSQL/Testcontainers, Graphile, LISTEN/NOTIFY product journeys.
- `pnpm test:e2e` — Playwright against deterministic emulated stack.
- `pnpm test:topology` — Docker + worker recovery smoke; not standard PR CI.
- `pnpm test:canary` — live provider canaries; keys required, not PR CI.
- `pnpm test:computer` — real vision model + managed computer; keys required, opt-in.
- `pnpm db:generate`, `pnpm db:migrate` — Prisma generation/deploy migrations.
- `pnpm sandbox:build` — local computer image.
- `pnpm compose:up`, `pnpm compose:down` — local full stack; down removes volumes.

Local verification on 2026-09-02 could not run because the machine had Node 22.14.0, below the repository's minimum 22.22.2. Exact-head GitHub CI is therefore the application verification source for this review.

## Frontend Architecture

### Web

`App.tsx` performs Better Auth session gating and routes unauthenticated users through welcome/sign-in/sign-up/password recovery. Authenticated users enter one shell for `/app`, `/app/:botId`, or `/app/g/:groupId` (`apps/web/src/App.tsx:29-99`). The shell owns most desktop-class product behavior: Space/Assistant/group navigation, threads, streaming events, composer mentions, activity/runs, computer screen/takeover, settings overlays, routine editing, skills, connections, artifacts, voice, and responsive layout.

The client uses shared oRPC/Zod contracts rather than handwritten REST DTOs. Authentication is cookie-based in browser and can be bridged from bearer session tokens. UI state is primarily React local/context-style state plus URL state; no Redux-like global store was found. Server state is fetched through thin RPC helpers; durable orchestration remains server-owned.

The web/Electron UI supports English, German, Korean, Turkish, Hindi, Brazilian Portuguese, and Simplified Chinese through Lingui. Appearance is System/Light/Dark with shared tokens. Beautiful UI primitives live under `apps/web/src/components/beautiful-ui` and shared primitives under `packages/ui-web`.

### Electron

Electron hosts the web UI rather than reimplementing product flows. It adds a first-run choice between a local Rakazo stack and an existing server, health-checks and persists the selected server, enforces HTTPS except for trusted local/private addresses, manages local Compose lifecycle, exposes native menus, and supports update/download packaging behavior. Shared contracts and UI remain in packages/web wherever practical.

### Mobile

Expo Router supplies native navigation and storage/permission boundaries. Mobile implements sign-in, Space/Assistant list, thread chat, Assistant settings, routines, models, integrations, voice, account settings, artifacts, and computer maintenance. It shares contracts/core/chat UI/tokens, but large native screens are separate implementations (`apps/mobile/app/thread.tsx` is 2,664 physical lines), so parity must be checked explicitly for product changes.

### Marketing

`apps/www` is an independently buildable Astro site. It describes Rakazo, not CortexAI Agent Hub, and can be hosted separately from the authenticated long-running stack.

## Backend/API Architecture

The API is a composition root around replaceable interfaces. `AdapterContext` carries `operationId`, `traceId`, `spaceId`, `userId`, optional `botId`/`runId`, cancellation, and connected accounts (`packages/adapter-kit/src/types.ts:3-17`). The adapter kit defines boundaries for runtime, sandbox, connectors, memory, semantic memory, jobs, home/artifact/secret stores, realtime, notifications, email, voice, messaging, and web (`packages/adapter-kit/src/interfaces.ts`).

The API creates PostgreSQL-backed realtime fanout, an encrypted secret store, durable thread events, selected sandbox, MCP OAuth/transport, managed connector stack, selected Pi/scripted runtime, local home/artifact stores, memory providers, notifications, auth, and router. Production uses Graphile; the in-memory job queue exists for tests/emulation (`apps/api/src/app.ts:108-304`).

Every `/rpc/*` request resolves the Better Auth session, reads an optional `x-rakazo-space-id`, and calls `requireMembership`; the actor is then passed into the oRPC context (`apps/api/src/app.ts:377-389`). RPC errors intentionally preserve `ORPCError` decisions but flatten unexpected errors to clients and log their cause chain (`apps/api/src/app.ts:498-519`).

## Database and Data Model

Core hierarchy:

- `User` ↔ `Organization` through `Member`.
- `Organization` owns `Space`; `SpaceMember` is a composite organization/Space/user membership boundary.
- New app signups receive a one-person `Personal` organization and default `Personal` Space; the first app signup can claim deployment ownership (`packages/db/src/bootstrap-user.ts:19-138`).
- `Space` is the primary product/privacy scope for Assistants, threads, runs, routines, skills, connections, memory, computers, artifacts, MCP, approval rules, and usage (`packages/db/prisma/schema.prisma:146-190`).

Assistant operations:

- `Bot` is user-owned within a Space and has optional parent/child delegation, model config, computer, one thread, one home, one browser profile, routines, skills, artifacts, tasks/runs, and MCP assignments (`schema.prisma:312-364`).
- `ChatGroup` is user-owned and contains multiple Assistants; it has one group thread (`398-455`).
- `Thread` contains ordered `Message` and `Event` sequences plus compaction state (`432-500`).
- `Task` is the user request. `Run` is a durable execution with status, trigger, model, lease/fence/checkpoint, source/routine links and timestamps. `Attempt` records fenced retry executions (`503-600`).
- `ExternalEffect` provides idempotency and stores request/result/review outcome for approval-mediated effects (`602-621`).
- `Routine` stores cron arrays, timezone, webhook toggle, activation and next/last run (`624-648`).

Durability/resources:

- `MemoryDocument` + `MemoryRevision`; `AgentHome`; `BrowserProfile`; `Computer` + per-Bot execution leases; `Artifact`; `UsageRecord`; notifications; encrypted `Secret` references (`752-947`).
- User/Space connector and MCP entities occupy `Connection`, `CapabilityInstall`, `McpServer`, OAuth session, and Bot assignment models (`715-750`, `949-1010`).
- Messaging identity/channel/link/outbox and Agent-to-Agent connection entities are first class (`1013-1110`).

## Auth, Roles, and Deployment Boundaries

Implemented:

- Better Auth email/password sessions, bearer plugin, password reset, session revocation after reset, mutable signup policy, and user deletion hooks (`packages/auth/src/index.ts:38-130`).
- Public organization creation/invite/member-management auth routes are blocked in v1 (`packages/auth/src/index.ts:165-172`).
- New users are intentionally isolated into personal organizations/Spaces.
- Explicit Space selection is membership checked; absent selection deterministically prefers the default then oldest membership (`packages/db/src/scope.ts:11-35`).
- `scoped()` rejects mismatched Space and, when present, user ownership (`packages/db/src/scope.ts:38-48`).
- Many router/repository queries include both actor `spaceId` and `userId`; Space-wide resources deliberately omit the user check where collaboration is intended.

Not implemented:

- CortexAI Hub OAuth/JWT/JWKS.
- Hub product entitlement or tenant claims.
- Hub-delivered model/tool/skill/policy configuration.
- External-customer deployment registration/lifecycle integration.
- Organization-owned shared Assistants distinct from personal Assistants.

Boundary interpretation: CortexAI Phase 1 uses one Agent Hub deployment per customer tenant. Within that deployment, Space and user ownership are privacy scopes. The existing `Organization` model should not be advertised as CortexAI multi-tenant control-plane integration.

## Run and Event Flow

1. A web/mobile/messaging/webhook caller resolves a user and Space and sends a typed thread request.
2. The API transaction writes the user message, `Task`, queued `Run`, and ordered product events; idempotency uses client nonce/unique keys.
3. `run.continue` is published to Graphile (or the in-memory test queue).
4. The worker claims a run with a lease/fence and creates an `Attempt`.
5. The executor loads Assistant/thread/memory/skill/connection/model context; materializes attachments; provisions/reconnects a computer if needed; and streams Pi runtime events.
6. Tool execution routes through built-in or connector handlers. Approval-mediated effects are persisted and replayable; secret requests and human takeover pause/resume safely.
7. Messages/events/checkpoints/usage/effects are persisted during execution. Workspaces/browser state are checkpointed at boundaries.
8. Completion/failure closes the attempt/run, releases leases, schedules idle computer handling, publishes notifications, and optionally mirrors replies to messaging.
9. A 30-second reconciler scan re-enqueues queued/expired runs, due routines, expiring control leases, undelivered messaging, and unreturned delegated outcomes (`packages/adapters/src/job-reconciler.ts:99-348`). PostgreSQL advisory-lock leadership prevents duplicate production reconcilers.

## Computer/Sandbox Architecture

`SandboxProvider` is the contract for lifecycle, commands, screen, input, observe/act, files, workspace import/export, snapshot, stop/destroy (`packages/adapter-kit/src/interfaces.ts:64-135`). Pi remains in the application process; computers execute tools only (`docs/computer-runtime.md:3-28`).

- One Team Computer is default per Space; Assistants use per-Bot directories and can use separate screens, but the shared filesystem is not a security boundary.
- Private Computers give one Assistant the whole workspace.
- User takeover uses exclusive fenced control leases and normally requires stopping active computer work; `waiting_takeover` is the protected-input exception.
- Portable workspace + browser profile is the durable boundary. E2B/Daytona/Box/Docker machine IDs are acceleration references, not durable truth.
- Current production `LocalAgentHomeStore` and `LocalArtifactStore` rely on `DATA_DIR`; production must use persistent encrypted/off-host-backed storage. CortexAI's SeaweedFS integration is not implemented.
- The trusted desktop/“This Mac” provider runs commands on the service host and must not be enabled on a public/shared deployment.

## External Integrations

- Models: Pi provider catalog, per-user encrypted credentials, deployment model fallback, OpenAI-compatible endpoint support with public-host opt-in and SSRF protections.
- Connectors: Composio and Pipedream managed catalogs; installed OpenAPI/MCP/Treg paths; per-user `Connection` ownership.
- MCP: HTTPS remote MCP plus optional tightly allowlisted stdio; OAuth sessions are encrypted and scoped.
- Memory: local durable Markdown always exists; optional semantic provider augments rather than replaces it.
- Voice: provider-neutral credentials and synthesis/transcription surfaces.
- Messaging: deployment-level provider adapters, user/Bot link codes, DM/group routing, durable outbox and retries.
- Notifications: Expo push tokens stored under `DATA_DIR`.
- Email: SMTP transactional provider or loopback-only development emulator.
- Updater: optional private-network sidecar with a dedicated bearer token; API exposes check/apply to deployment owner but not rollback.

## Deployment and Runtime Assumptions

Supported primary shapes:

- Source development: Postgres + API + worker + web + Docker supervisor/computer.
- Published images: Compose with app, worker, web, Postgres, internal supervisor, and computer image.
- Public single VM: production Compose, Caddy TLS, Postgres, API, worker, web, optional updater; E2B is the documented hosted computer path.
- Electron connects to the same server/API and may manage a local stack.

The API is not meant to expose PostgreSQL, Docker socket, supervisor, or internal updater publicly. The production API start path applies Prisma migrations before serving. The backup contract includes PostgreSQL plus `DATA_DIR`; local snapshots are not a substitute for encrypted off-host backup. Upgrades are coordinated API/worker cutovers when migrations rename shared fields.

## Feature Map

Implemented product areas:

- Personal persistent Assistants and Assistant sections.
- Assistant teams/groups and peer/delegated runs.
- Threads, attachments, reactions, live streaming, steering and stop/follow-up.
- Durable tasks/runs/attempts/checkpoints and activity history.
- Scheduled/webhook routines.
- Team/private computers, browser sessions, shell/files/desktop tools, takeover.
- User-taught playbooks and Agent Skills (`SKILL.md` recipes).
- Scratchpad, durable memory, optional semantic memory.
- Model/voice credentials and defaults.
- Composio/Pipedream/MCP/OpenAPI/Treg connections.
- Artifacts and usage summaries.
- Voice and external messaging.
- Web, Electron, Expo mobile, and marketing site.
- Self-host install, backup/restore, host hardening, published images, updater.

## Safety and Risk Map

1. **Governance gap:** `APPROVAL_EXEMPT_TOOLS` includes desktop actions, file reads/writes, shell, app launch, takeover/secret requests, subagents, Assistant spawning, and schedule operations. No matching rule defaults to allow (`packages/core/src/action-approval.ts:3-23`, `117-136`). This is implemented behavior, not a CortexAI governed-by-default policy layer.
2. **Critical trusted-host risk:** “This Mac”/desktop is process execution, not a host sandbox. It bounds the requested working directory but then spawns agent-selected `argv` as the API/worker OS account; a command can address host paths or resources independently of `cwd` (`packages/adapters/src/desktop-sandbox.ts:118-145`). Enable only on a single-user trusted machine with explicit user intent—never on a public/shared Agent Hub host.
3. **Screen capability lifetime/binding gap:** proxied screen URLs are view/control capabilities valid for one hour and cryptographically bind destination, policy, and expiry, but the token itself does not bind the authenticated actor, Assistant, computer, or active control lease (`apps/api/src/screen-proxy.ts:3-37`). Treat copied/stale control URLs as a P0 acceptance area until HTTP/WebSocket enforcement proves actor/resource/lease binding and immediate revocation.
4. **No Hub trust contract:** current identity is Better Auth session + Space membership. Do not claim Hub SSO, entitlement, or tenant policy readiness.
5. **Shared Team Computer:** per-Bot folders organize work but do not isolate Assistants from the Team filesystem (`docs/computer-runtime.md:15-19`).
6. **Secret referential-integrity gap:** several secret pointers are plain strings without Prisma foreign-key ownership constraints (`UserModelCredential`, `UserVoiceCredential`, `Connection`, `CapabilityInstall`, `BrowserProfile`, `Bot.webhookSecretId`). Application lookups usually recheck owner/Space, but database-level defense in depth is uneven (`packages/db/prisma/schema.prisma:243-271`, `312-364`, `715-749`, `800-811`).
7. **High-capability services:** Docker supervisor controls the host Docker daemon and updater is root-equivalent. Keep them private and separately credentialed.
8. **Local durability:** homes/artifacts/push tokens are filesystem-backed under `DATA_DIR`. Backup, encryption, off-host restore, and SeaweedFS are external operational gates.
9. **Large concentration points:** Shell/router/executor/mobile thread amplify regression and review risk. Mobile uses a separate string-addressed RPC wrapper, so the shared oRPC contract does not provide the same compile-time endpoint coverage as web.
10. **GitHub supply-chain state:** exact-head core CI passed, but GitHub showed 25 open Dependabot alerts: 8 high, 15 medium, 2 low. An open clean PR updates Nodemailer; several automated update workflows failed. Severity does not prove exploitability, but this blocks a clean customer release assessment.
11. **Branch policy unknown:** GitHub branch-protection read returned 404 (absent or inaccessible to the current token). Do not claim main is protected.
12. **Marketing overreach risk:** marketing mentions an “audit log,” but current `ExternalEffect`/approval evidence is not a comprehensive append-only platform audit gateway.
13. **Coverage gaps:** Biome excludes Astro and all of `apps/www`; marketing has Astro checks plus a single homepage E2E rather than the same lint surface as the app. Electron runtime E2E is Linux-based; macOS/Windows tagged-release jobs primarily prove packaging/signing, not interactive runtime parity.
14. **No releases in TukaTek fork:** `gh release list` returned none. Main/edge image publication is not the same as a supported CortexAI release.
15. **Private-network SSRF by design:** authenticated users may configure OpenAI-compatible endpoints on loopback, `host.docker.internal`, or RFC1918 addresses. Metadata/link-local destinations are blocked, but a user on a shared deployment can deliberately reach other internal HTTP services through model probe/runtime requests (`packages/adapters/src/openai-compatible-url.ts:42-99`; `packages/adapters/src/pi-openai-compatible-provider.ts:285-294`). Production needs an operator policy that disables or allowlists this local-development capability.
16. **Database tenant invariants are incomplete:** many linked rows repeat `spaceId`/`userId` but use bare-ID foreign keys rather than composite keys proving that Bot, Thread, Task, Run, Computer, MCP server, and related rows share the same Space. The worker loads claimed-run companions by bare IDs, so corruption or a future unscoped write can cross-wire context despite normal API predicates (`packages/db/prisma/schema.prisma:312-364`, `398-480`, `503-567`, `786-860`, `994-1010`; `packages/adapters/src/executor.ts:823-874`).
17. **Composio identity is user-wide:** local Connection rows are Space/user scoped, but Composio sessions and external connections are keyed only by `userId`. An authorization made in one Space exists in the same external Composio identity used by the user's other Spaces; intended sharing must be explicit or the external principal must include Space/deployment identity (`packages/adapters/src/composio-connector.ts:196-233`, `279-305`, `323-370`).
18. **Residual identity and memory caveats:** custom-scheme CORS trusts any `rakazo://` or `exp://` origin; exploitability depends on native scheme/cookie behavior. Better Auth cookie/CSRF/rate-limit details depend on library behavior not established here. Conversation clear only best-effort purges semantic-provider history, so a failed third-party purge can leave stale recallable memory (`apps/api/src/app.ts:345-353`, `473-486`; `apps/api/src/router.ts:1115-1137`).
19. **Schema/implementation drift:** persisted Task/Run/Attempt/ExternalEffect statuses are unconstrained strings, and exported `EffectStatus` omits active implementation states including `approved`, `denied`, `executing`, and `uncertain` (`packages/contracts/src/ids.ts:36-37`; `packages/adapters/src/approval-effect.ts:344-366`).

## Testing and Quality Gates

Exact-head GitHub CI run: `33708092517` at reviewed SHA.

Passed:

- Lint.
- Typecheck/Prisma generation.
- Production builds plus Electron smoke.
- Unit suite: 253 files passed, 18 skipped; 2,283 tests passed, 109 skipped.
- PostgreSQL journeys: 11 files / 76 tests passed.
- Web Playwright: 49 passed; marketing Playwright: 1 passed.
- Server-image validation/publishing workflow succeeded.

Separate report-publication workflow `33708401403` failed because its S3/AWS publication configuration was absent. This did **not** make the underlying Playwright tests fail, but it prevents publication of the visual report gallery.

Not covered by standard PR CI:

- Live OpenRouter/provider canaries.
- Real E2B/Daytona/Box computer acceptance.
- Real vision-model computer test.
- Topology/recovery smoke.
- Customer-specific Hub integration, backup/restore, disaster recovery, or deployment acceptance.
- Dependency-audit/secret-scan gate in the core CI workflow.
- The worker entry/composition itself: `apps/worker` has no test files, its script permits no tests, and root Vitest discovery excludes it.
- Coverage thresholds; none are configured.
- Most mobile route/component behavior; normal Vitest includes only `apps/mobile/lib`, while the opt-in Maestro smoke stays outside PR CI.
- Interactive macOS/Windows Electron behavior; tagged releases validate packaging/signing but runtime E2E is Linux-based.

Additional maintainability gaps:

- API and worker duplicate most runtime/sandbox/connector/memory/executor composition, creating configuration-drift risk.
- Direct route coverage is thin relative to the 4,146-line multi-domain router; many paths rely on lower-level tests.
- Graphile retry/backoff uses library defaults rather than an explicit product policy.
- Biome excludes Astro and all of `apps/www`.

## Unknowns / Needs Confirmation

- Which computer provider will be the qualified CortexAI Phase 1 provider.
- Whether web remains the only supported pilot surface or Electron/mobile are in launch scope.
- Final Hub identity/config/entitlement contract and internal-pilot exception expiry.
- SeaweedFS home/artifact adapter ownership and migration plan.
- Required governance policy for shell/file/desktop/schedule/subagent effects.
- Production SLOs, telemetry stack, support ownership, cost ceilings, and retention.
- Whether TukaTek will intentionally track upstream at zero divergence or begin a product-owned release branch/tag strategy.
- Whether private/loopback OpenAI-compatible endpoints are disabled, allowlisted, or isolated for multi-user deployments.
- Whether Composio connections are intentionally shared across a user's Spaces and how the principal is namespaced across customer deployments.
- Where the production screen-capability verifier/proxy implementation lives; it is not present in the reviewed TypeScript source.
- Whether `BrowserProfile.secretId` is roadmap residue or has a required lifecycle; the model is created but otherwise effectively unused.
- How `deploy-main` is provisioned and audited; the CI workflow invokes this external SSH command, but its implementation is not versioned here.
- Whether the public mobile identifiers in `apps/mobile/app.json` are intentionally public; this conflicts with `docs/mobile-release.md` saying production project/store identifiers are absent.
- Missing configuration documentation for `MCP_STDIO_ENABLED` and `MCP_STDIO_ALLOWED_COMMANDS`, plus the README's broad “Node 22+” claim versus the manifest's Node 22.22.2 minimum.

## Appendix: Evidence

Primary evidence files:

- `AGENTS.md`
- `README.md`
- `CONTRIBUTING.md`
- `package.json`, `pnpm-workspace.yaml`, `turbo.json`
- `apps/api/src/index.ts`, `app.ts`, `router.ts`, `env.ts`
- `apps/worker/src/index.ts`
- `apps/web/src/App.tsx`, `pages/Shell.tsx`
- `apps/desktop/src/main.ts`
- `apps/mobile/app/_layout.tsx`, `index.tsx`, `thread.tsx`
- `packages/contracts/src/rpc.ts`, `domain.ts`, `events.ts`
- `packages/adapter-kit/src/interfaces.ts`, `types.ts`
- `packages/adapters/src/executor.ts`, `background-job-handlers.ts`, `job-reconciler.ts`
- `packages/auth/src/index.ts`
- `packages/db/prisma/schema.prisma`, `src/bootstrap-user.ts`, `src/scope.ts`
- `packages/core/src/action-approval.ts`
- `docs/computer-runtime.md`, `docs/self-host.md`
- `.github/workflows/ci.yml`, `.github/workflows/playwright.yml`
- GitHub CI: `https://github.com/TukaTek/agent-hub/actions/runs/33708092517`
