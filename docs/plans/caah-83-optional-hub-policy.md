# CAAH-83: Optional Hub Registration and Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Hub-mode deployment can explicitly turn off Hub tenant policy and run without Hub registration. Hub session sign-in, entitlement checks, the verification cache and bot runs then work as they did at `4306c218`. Registered deployments keep the full CAAH-36 behavior.

**Architecture:** `hubAuthFromEnv` is the one place both processes read Hub configuration. It parses a new `HUB_POLICY_ENFORCEMENT` setting (`on`, the default, or `off`). With `off` it skips the tenant and service-credential requirements and records `policyDisabled: true` on `HubAuthConfig`. A new `disabledHubPolicy()` implements the existing `HubPolicy` interface: it admits every sign-in, session and job, never contacts Hub, never reads or applies a stored snapshot, and reports `state: "disabled"`. The API startup, the worker startup and `createHubAuth` select it from the config, the same way they select `notConfiguredHubPolicy()` today. Every other code path, including Hub login, `/session` and `/config` verification, the verify cache, refresh, revoke and the optional `HUB_AUTH_TENANT_ID` pin in `hub-sessions.ts`, is unchanged.

**Tech Stack:** TypeScript, Node (Hono API, Graphile worker), better-auth, Prisma/PostgreSQL, Vitest. No web, desktop or mobile changes.

## Global Constraints

- The opt-out is explicit. With `HUB_POLICY_ENFORCEMENT` unset or `on`, a missing `HUB_AUTH_TENANT_ID`, `HUB_SERVICE_API_ID` or `HUB_SERVICE_SECRET_FILE` keeps today's locked `HUB_NOT_CONFIGURED` state, byte for byte.
- `HUB_POLICY_ENFORCEMENT=off` together with `HUB_SSO_ENABLED=true` stops startup with a clear error, in both the API and the worker.
- With the policy off, both processes log one startup warning, and `/internal/health` reports `hubPolicy.state: "disabled"`.
- Any value other than `on` or `off` stops the process at startup, like `HUB_POLICY_AUTO_RESTART`.
- No user-facing copy changes. Only operator logs, health JSON and docs change.
- Existing CAAH-36 tests pass unchanged. New tests are deterministic and offline. Postgres tests run only under `VERIFY_DATABASE=1`.
- Public repo: synthetic tenant ids, origins and secrets only.
- Do not run the desktop Playwright suite locally.

---

## What I found

1. **The lock is decided in `hubAuthFromEnv`** (`packages/auth/src/hub-client.ts:94-135`). If the tenant, API id or secret file is missing, it returns `{ origin, notConfigured: { missing } }`. Three consumers then switch to `notConfiguredHubPolicy()` (`packages/auth/src/hub-policy.ts:400`):
   - the API, in `startApiHubPolicy` (`apps/api/src/hub-policy.ts`);
   - the worker (`apps/worker/src/index.ts:89-127`), which also throws `Hub mode requires HUB_AUTH_TENANT_ID`;
   - `createHubAuth` (`packages/auth/src/hub.ts:205`), plus two direct `config.notConfigured` short-circuits in `hub-sessions.ts` (lines 36 and 144).
2. **At `4306c218` there was no policy object.** Sign-in called Hub login, and sessions and work used `createHubSessionAuthorizer`, which runs Hub `/session` and `/config` verification, the verify cache and refresh. `HUB_AUTH_TENANT_ID` was an optional pin, checked in the session authorizer (`hub-sessions.ts:52`, still present). That behavior is still all there. The policy only adds `check()` and `admit()` at sign-in, `sessionAllowed()` after a verify, and `workAllowed()` before work. A policy that always allows therefore reproduces `4306c218` exactly, with no change to the session code.
3. **Startup overlay.** `applyHubPolicyAtStartup` overlays Hub-managed env and deployment settings from the stored snapshot. With the policy off it must not run. Otherwise a deployment that was once registered would keep applying a stale stored snapshot. `setHubManagedDeploymentSettings` defaults to no managed settings, so skipping the runtime is enough.
4. **SSO** uses the service credential and the tenant (`hub-client.ts:105-106`). The worker parses with `readSecretFile` unset, so `ssoEnabled` is always false there today. The opt-out/SSO check must use the raw `HUB_SSO_ENABLED` flag, so the worker also refuses.
5. **Health.** `hubPolicyHealth` marks every state except `ok` as `degraded`. `disabled` is an intentional operator choice, not a fault, so it must report `status: "ok"`. The `hubPolicy` object makes the choice visible.
6. **Env reference.** The Hub settings are documented in `docs/hub-auth.md` (table under "Configuring Hub mode"), `.env.example` (lines 29-59), the overlay header in `infra/compose/docker-compose.hub.yml`, and the Hub paragraph in `docs/self-host.md` (around line 727). `infra/compose/.env.images.example` has no Hub settings.

## Decisions

**Explicit flag (recommended) vs. inferring the opt-out from "all three unset".**

- *Inference: skip when all three `HUB_*` are unset, error when only some are set.*
  - It needs no new setting.
  - But a registered deployment that loses its whole env, for example a dropped `.env` line, a lost secret mount plus a missing tenant, or a template reset, would silently fall back to "no policy" and admit every entitled Hub user. That is fail-open on exactly the failure CAAH-36 F1 was built to catch.
  - It also changes today's documented `not_configured` contract for the all-unset case, which is the case the existing tests and docs describe.
- *Explicit flag (chosen).* The operator states the intent. A missing env never turns enforcement off, and the default stays fail closed. The cost is one setting, documented in one table.

**Name and values: `HUB_POLICY_ENFORCEMENT=on|off`, default `on`.** It names what is switched (enforcement of Hub tenant policy) rather than registration, which is a Hub-side concept. `on`/`off` reads better than `true`/`false` for a mode. I considered `HUB_POLICY_ENABLED=false` to match the `true`/`false` style of `HUB_SSO_ENABLED` and `HUB_POLICY_AUTO_RESTART`, and it is an easy rename if the PM prefers it.

**With the policy off, `HUB_*` service values are ignored, not rejected.** `HUB_SERVICE_API_ID` and `HUB_SERVICE_SECRET_FILE` are not read, so a half-registered deployment can turn the policy off without deleting them. `HUB_AUTH_TENANT_ID`, if set, is still length-validated and keeps its pre-CAAH-36 role as an optional tenant pin. `disabledHubPolicy` also refuses a sign-in for another tenant with `HUB_ACCESS_DENIED`. That is slightly stricter than `4306c218`, which created the session and then refused it on the first request, and it creates no orphan session.

**Health shape: `hubPolicy: { state: "disabled", code: null, tenant, ... }` with `status: "ok"`.** The ticket's example is `hubPolicy: "disabled"`. I keep the existing object shape so monitors that read `hubPolicy.state` keep working.

**Worker startup gets a small extracted function** (`apps/worker/src/hub-policy.ts`, `startWorkerHubPolicy`), mirroring `startApiHubPolicy`. Today the worker branch is inline in `main()` and untested. Extracting it is the smallest way to unit-test acceptance criteria 1-3 for the worker.

## File Structure

| File | Change |
| --- | --- |
| `packages/auth/src/hub-client.ts` | Parse `HUB_POLICY_ENFORCEMENT`, add `policyDisabled?: true`, reject `off` together with SSO |
| `packages/auth/src/hub-policy.ts` | `disabledHubPolicy()`, add `"disabled"` to `HubPolicyStatus["state"]` |
| `packages/auth/src/hub-policy-runtime.ts` | `hubPolicyDisabledLogEntry()` |
| `packages/auth/src/hub.ts` | `createHubAuth` selects `disabledHubPolicy` when `config.policyDisabled` |
| `packages/auth/src/index.ts` | Export the two new functions |
| `apps/api/src/hub-policy.ts` | Disabled branch: warn, no DB pool, no Hub fetch |
| `apps/api/src/health.ts` | `disabled` counts as `ok` |
| `apps/worker/src/hub-policy.ts` (new) | `startWorkerHubPolicy`, extracted from `index.ts`, with a disabled branch |
| `apps/worker/src/index.ts` | Call `startWorkerHubPolicy` |
| Tests | `hub-client.test.ts`, `hub-policy.test.ts`, `hub.test.ts`, `hub-sessions.test.ts`, `hub.postgres.test.ts`, `apps/api/src/hub-policy.test.ts`, `apps/api/src/health.test.ts`, `apps/worker/src/hub-policy.test.ts` (new) |
| Docs | `docs/hub-auth.md`, `docs/self-host.md`, `.env.example`, `infra/compose/docker-compose.hub.yml` header |

---

### Task 1: Parse `HUB_POLICY_ENFORCEMENT` in `hubAuthFromEnv`

**Files:**
- Modify: `packages/auth/src/hub-client.ts:9-29` (interface), `:44-146` (parser)
- Test: `packages/auth/src/hub-client.test.ts`

**Interfaces:**
- Produces: `HubAuthConfig.policyDisabled?: true`. When it is set, `notConfigured`, `service` and `sso` are never set, and `tenantId` is set only if `HUB_AUTH_TENANT_ID` is.

- [ ] **Step 1: Write the failing tests**

```ts
describe("HUB_POLICY_ENFORCEMENT", () => {
  const hub = { AUTH_MODE: "hub", HUB_AUTH_ORIGIN: "https://hub.example.test" };
  const read = { readSecretFile: () => "synthetic-secret" };

  it("defaults to on: missing HUB_* values still start not configured", () => {
    expect(hubAuthFromEnv({ ...hub }, read)?.notConfigured?.missing.map((m) => m.name)).toEqual([
      "HUB_AUTH_TENANT_ID",
      "HUB_SERVICE_API_ID",
      "HUB_SERVICE_SECRET_FILE",
    ]);
    expect(hubAuthFromEnv({ ...hub, HUB_POLICY_ENFORCEMENT: "on" }, read)?.notConfigured).toBeDefined();
  });

  it("off needs no tenant or service credential, in the API and the worker", () => {
    for (const options of [read, {}]) {
      const config = hubAuthFromEnv({ ...hub, HUB_POLICY_ENFORCEMENT: "off" }, options);
      expect(config).toEqual({ origin: "https://hub.example.test", policyDisabled: true });
    }
  });

  it("off keeps an optional tenant pin and never reads the service secret", () => {
    const readSecretFile = vi.fn(() => "synthetic-secret");
    const config = hubAuthFromEnv(
      {
        ...hub,
        HUB_POLICY_ENFORCEMENT: "off",
        HUB_AUTH_TENANT_ID: "tenant-1",
        HUB_SERVICE_API_ID: "api-id-1",
        HUB_SERVICE_SECRET_FILE: "/run/secrets/synthetic",
      },
      { readSecretFile },
    );
    expect(config).toMatchObject({ tenantId: "tenant-1", policyDisabled: true });
    expect(config?.service).toBeUndefined();
    expect(readSecretFile).not.toHaveBeenCalled();
  });

  it("off with SSO stops startup in both processes", () => {
    const env = { ...hub, HUB_POLICY_ENFORCEMENT: "off", HUB_SSO_ENABLED: "true" };
    for (const options of [read, {}])
      expect(() => hubAuthFromEnv(env, options)).toThrow(
        "HUB_SSO_ENABLED=true requires HUB_POLICY_ENFORCEMENT=on",
      );
  });

  it("rejects any other value", () => {
    for (const value of ["false", "OFF", "disabled"])
      expect(() => hubAuthFromEnv({ ...hub, HUB_POLICY_ENFORCEMENT: value }, read)).toThrow(
        "HUB_POLICY_ENFORCEMENT must be on or off",
      );
  });

  it("is ignored in local mode", () => {
    expect(hubAuthFromEnv({ AUTH_MODE: "local", HUB_POLICY_ENFORCEMENT: "off" })).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `pnpm vitest run packages/auth/src/hub-client.test.ts -t HUB_POLICY_ENFORCEMENT`
Expected: FAIL. Without the flag, `policyDisabled` is undefined, and `off` still yields `notConfigured`.

- [ ] **Step 3: Implement**

Add the field to `HubAuthConfig`:

```ts
  /**
   * `HUB_POLICY_ENFORCEMENT=off`: an unregistered Hub-mode deployment. Hub sign-in and
   * entitlement checks still apply; Hub tenant policy is never fetched or enforced.
   */
  policyDisabled?: true;
```

In `hubAuthFromEnv`, right after the `mode !== "hub"` check:

```ts
  const enforcement = source.HUB_POLICY_ENFORCEMENT?.trim() || "on";
  if (enforcement !== "on" && enforcement !== "off")
    throw configError("HUB_POLICY_ENFORCEMENT must be on or off");
  if (enforcement === "off" && ssoFlag === "true")
    throw configError("HUB_SSO_ENABLED=true requires HUB_POLICY_ENFORCEMENT=on");
```

The origin and cache parsing stay as they are. Then, before the `missing` block:

```ts
  if (enforcement === "off") {
    const tenantId = source.HUB_AUTH_TENANT_ID?.trim();
    if (tenantId && tenantId.length > 256)
      throw configError("HUB_AUTH_TENANT_ID must be at most 256 characters");
    return {
      origin: url.origin,
      ...(tenantId ? { tenantId } : {}),
      ...(deploymentId ? { deploymentId: deploymentId.toLowerCase() } : {}),
      ...(cacheTtlMs !== undefined ? { verifyCacheTtlMs: cacheTtlMs } : {}),
      ...(cacheEnabled !== undefined ? { verifyCacheEnabled: cacheEnabled } : {}),
      policyDisabled: true,
    };
  }
```

Move the `HUB_DEPLOYMENT_ID` parsing above this block so a session-bound deployment id still applies. It is validated the same way.

- [ ] **Step 4: Run the whole file and confirm it passes**

Run: `pnpm vitest run packages/auth/src/hub-client.test.ts`
Expected: PASS, including every existing CAAH-36 case.

- [ ] **Step 5: Commit** `feat(auth): parse HUB_POLICY_ENFORCEMENT for unregistered Hub deployments (CAAH-83)`

### Task 2: `disabledHubPolicy` and its startup log entry

**Files:**
- Modify: `packages/auth/src/hub-policy.ts` (status union, new function after `notConfiguredHubPolicy`)
- Modify: `packages/auth/src/hub-policy-runtime.ts` (new log entry)
- Modify: `packages/auth/src/index.ts` (exports)
- Test: `packages/auth/src/hub-policy.test.ts`, `packages/auth/src/hub-policy-runtime.test.ts`

**Interfaces:**
- Produces: `disabledHubPolicy(options: { tenantId?: string }): HubPolicy` and `hubPolicyDisabledLogEntry(): { message: string; attributes: Record<string, string> }`.

- [ ] **Step 1: Write the failing tests**

```ts
describe("disabledHubPolicy", () => {
  it("admits sign-in, sessions and work without contacting Hub", async () => {
    const policy = disabledHubPolicy({});
    const identity = { tenant: "any-tenant", subject: "user-1" };
    await expect(policy.check()).resolves.toBeUndefined();
    await expect(policy.admit(identity)).resolves.toBe("assigned");
    expect(await policy.sessionAllowed(identity)).toBe(true);
    expect(await policy.workAllowed(identity)).toBe(true);
    expect(await policy.needsRestart()).toBeNull();
  });

  it("still honours an optional tenant pin", async () => {
    const policy = disabledHubPolicy({ tenantId: "tenant-1" });
    const other = { tenant: "tenant-2", subject: "user-1" };
    await expect(policy.admit(other)).rejects.toMatchObject({ code: "HUB_ACCESS_DENIED" });
    expect(await policy.sessionAllowed(other)).toBe(false);
    expect(await policy.workAllowed(other)).toBe(false);
    await expect(policy.admit({ tenant: "tenant-1", subject: "u" })).resolves.toBe("assigned");
  });

  it("reports disabled", async () => {
    expect(await disabledHubPolicy({ tenantId: "tenant-1" }).status()).toEqual({
      state: "disabled",
      code: null,
      tenant: "tenant-1",
      hubRevision: null,
      appliedRevision: null,
      fetchedAt: null,
      checkedAt: null,
      source: null,
      assignments: "pending",
      toolkits: "unknown",
    });
  });
});
```

In `hub-policy-runtime.test.ts`:

```ts
it("warns that Hub policy is off without naming any value", () => {
  const entry = hubPolicyDisabledLogEntry();
  expect(entry.message).toContain("HUB_POLICY_ENFORCEMENT=off");
  expect(entry.message).toContain("docs/hub-auth.md#running-without-hub-registration");
  expect(entry.attributes).toEqual({ "hub.policy": "disabled", "hub.doc": "docs/hub-auth.md#running-without-hub-registration" });
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `pnpm vitest run packages/auth/src/hub-policy.test.ts packages/auth/src/hub-policy-runtime.test.ts`
Expected: FAIL, `disabledHubPolicy is not a function`.

- [ ] **Step 3: Implement**

In `hub-policy.ts`, extend the status union with `| "disabled"`, then add:

```ts
/**
 * The policy of a Hub-mode process run with `HUB_POLICY_ENFORCEMENT=off` (CAAH-83).
 * It never contacts Hub or reads the stored snapshot. Hub login and session
 * verification still gate every sign-in, session and job; only tenant policy is off.
 */
export function disabledHubPolicy(options: { tenantId?: string }): HubPolicy {
  const pinned = (identity: HubPolicyIdentity) =>
    !options.tenantId || identity.tenant === options.tenantId;
  const record = (): HubPolicyRecord => ({
    tenant: options.tenantId ?? "",
    document: null,
    revision: null,
    etag: null,
    digest: null,
    state: "ok",
    reason: "disabled",
    source: "hub",
    assignmentsSource: "hub",
    fetchedAt: null,
    checkedAt: null,
    attemptedAt: new Date(0),
  });
  return {
    refresh: async () => record(),
    check: async () => undefined,
    admit: async (identity) => {
      if (!pinned(identity)) throw new HubPolicyError(HUB_ACCESS_DENIED, "other_tenant");
      return "assigned";
    },
    sessionAllowed: async (identity) => pinned(identity),
    workAllowed: async (identity) => pinned(identity),
    needsRestart: async () => null,
    status: async () => ({
      state: "disabled",
      code: null,
      tenant: options.tenantId ?? "",
      hubRevision: null,
      appliedRevision: null,
      fetchedAt: null,
      checkedAt: null,
      source: null,
      assignments: "pending",
      toolkits: "unknown",
    }),
  };
}
```

In `hub-policy-runtime.ts`:

```ts
const HUB_POLICY_DISABLED_DOC = "docs/hub-auth.md#running-without-hub-registration";

/** The operator warning for a Hub-mode process run with `HUB_POLICY_ENFORCEMENT=off`. */
export function hubPolicyDisabledLogEntry(): {
  message: string;
  attributes: Record<string, string>;
} {
  return {
    message:
      "Hub policy is off (HUB_POLICY_ENFORCEMENT=off): Hub sign-in and entitlement still " +
      "apply, but tenant policy, assignments and Hub-managed settings are not enforced. " +
      `See ${HUB_POLICY_DISABLED_DOC}`,
    attributes: { "hub.policy": "disabled", "hub.doc": HUB_POLICY_DISABLED_DOC },
  };
}
```

Export both from `packages/auth/src/index.ts`, next to `notConfiguredHubPolicy` and `hubNotConfiguredLogEntry`.

- [ ] **Step 4: Run them and confirm they pass**

- [ ] **Step 5: Commit** `feat(auth): add the disabled Hub policy (CAAH-83)`

### Task 3: Sign-in and sessions use the disabled policy

**Files:**
- Modify: `packages/auth/src/hub.ts:202-207`
- Test: `packages/auth/src/hub.test.ts`, `packages/auth/src/hub-sessions.test.ts`, `packages/auth/src/hub.postgres.test.ts`

**Interfaces:**
- Consumes: `HubAuthConfig.policyDisabled` (Task 1) and `disabledHubPolicy` (Task 2).

- [ ] **Step 1: Write the failing tests**

In `hub.test.ts`, reuse the file's existing fake Hub client and auth helpers (the ones the CAAH-36 sign-in tests use). Build the config with `hubAuthFromEnv({ AUTH_MODE: "hub", HUB_AUTH_ORIGIN: "https://hub.example.test", HUB_POLICY_ENFORCEMENT: "off" })`, and pass no `hubPolicy`:

```ts
it("signs a Hub user in with policy off and no Hub registration", async () => {
  // Continue answers "password", password sign-in creates the hub_ session,
  // and the service-config endpoint is never requested.
  expect(await continueWith("user@example.test")).toEqual({ next: "password" });
  const response = await passwordSignIn("user@example.test", "synthetic-password");
  expect(response.status).toBe(200);
  expect(fetchedPaths()).not.toContain("/api/agent-hub/service-config");
});

it("still refuses a user Hub does not entitle when policy is off", async () => {
  // The fake Hub /config returns the product disabled: sign-in fails as at 4306c218.
});
```

In `hub-sessions.test.ts`: with `policy: disabledHubPolicy({})` and `config.policyDisabled`, `createUserWorkAuthorizer` returns `true` for a `hub_` user with a verified session. It still returns `false` when Hub `/session` verification fails, so the session is still Hub-verified.

In `hub.postgres.test.ts`, add a journey based on the existing "completes a native Hub login" test, without `tenantId`, service credential or `hubPolicy`. It signs in through `createAuth` with a fake `fetch`, then asserts that `createUserWorkAuthorizer(prisma, config, key, { policy: disabledHubPolicy({}) })(userId)` is `true`. That is the gate a bot run passes in the worker.

- [ ] **Step 2: Run them and confirm they fail**

Run: `pnpm vitest run packages/auth/src/hub.test.ts packages/auth/src/hub-sessions.test.ts`
Expected: FAIL with `Hub mode requires the Hub policy gate`.

- [ ] **Step 3: Implement** in `createHubAuth`:

```ts
  const policy = config.notConfigured
    ? notConfiguredHubPolicy({ missing: config.notConfigured.missing.map((item) => item.name) })
    : config.policyDisabled
      ? disabledHubPolicy({ tenantId: config.tenantId })
      : env.hubPolicy;
```

`hub-sessions.ts` needs no change. It already uses whatever policy it is given, and `notConfigured` is never set together with `policyDisabled`.

- [ ] **Step 4: Run the auth package tests and confirm they pass**

Run: `pnpm vitest run packages/auth`, then `VERIFY_DATABASE=1 pnpm test:integration`. The harness starts Postgres in a container and includes `hub.postgres.test.ts`.

- [ ] **Step 5: Commit** `feat(auth): Hub sign-in and sessions run without tenant policy when it is off (CAAH-83)`

### Task 4: API startup and health

**Files:**
- Modify: `apps/api/src/hub-policy.ts`, `apps/api/src/health.ts`
- Test: `apps/api/src/hub-policy.test.ts`, `apps/api/src/health.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
it("starts with policy off: warns once, opens no pool and never contacts Hub", async () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  // No DATABASE_URL: a disabled process never opens a policy pool.
  const runtime = await startApiHubPolicy({ ...hub, HUB_POLICY_ENFORCEMENT: "off" }, logger);
  expect((await runtime!.policy.status()).state).toBe("disabled");
  await expect(runtime!.policy.check()).resolves.toBeUndefined();
  expect(logger.warn).toHaveBeenCalledOnce();
  expect(logger.warn.mock.calls[0]![0]).toContain("HUB_POLICY_ENFORCEMENT=off");
  expect(logger.error).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  await runtime!.close();
});

it("refuses to start with policy off and SSO on", async () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  await expect(
    startApiHubPolicy({ ...hub, HUB_POLICY_ENFORCEMENT: "off", HUB_SSO_ENABLED: "true" }, logger),
  ).rejects.toThrow("HUB_SSO_ENABLED=true requires HUB_POLICY_ENFORCEMENT=on");
});
```

The existing "starts not configured" test stays as it is. It is acceptance criterion 2 for the API.

In `health.test.ts`:

```ts
it("reports ok with the disabled policy visible", () => {
  expect(hubPolicyHealth({ state: "disabled" })).toEqual({
    status: "ok",
    hubPolicy: { state: "disabled" },
  });
});
```

- [ ] **Step 2: Run them and confirm they fail**

- [ ] **Step 3: Implement**

In `startApiHubPolicy`, after the `notConfigured` branch:

```ts
  if (hub.policyDisabled) {
    const entry = hubPolicyDisabledLogEntry();
    logger.warn(entry.message, entry.attributes);
    return {
      policy: disabledHubPolicy({ tenantId: hub.tenantId }),
      applied: { revision: null, digest: "" },
      stop: () => undefined,
      close: async () => undefined,
    };
  }
```

In `hubPolicyHealth`: `status: !status || status.state === "ok" || status.state === "disabled" ? "ok" : "degraded"`. Update its doc comment to say so.

- [ ] **Step 4: Run them and confirm they pass:** `pnpm vitest run apps/api/src/hub-policy.test.ts apps/api/src/health.test.ts`

- [ ] **Step 5: Commit** `feat(api): start Hub mode with policy off and report it on health (CAAH-83)`

### Task 5: Worker startup

**Files:**
- Create: `apps/worker/src/hub-policy.ts`, `apps/worker/src/hub-policy.test.ts`
- Modify: `apps/worker/src/index.ts:87-127`

**Interfaces:**
- Produces: `startWorkerHubPolicy(source, logger, prisma, options: { onRestartRequired?: (restart: HubPolicyRestart) => void }): Promise<{ config: HubAuthConfig | undefined; policy: HubPolicy | undefined }>`. It moves the existing inline branch unchanged and adds the disabled branch.

- [ ] **Step 1: Write the failing tests**

```ts
const hub = { AUTH_MODE: "hub", HUB_AUTH_ORIGIN: "https://hub.example.test" };
const prisma = {} as PrismaClient; // the not-configured and disabled branches never touch it

it("runs work with policy off and no Hub values, warning once", async () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const { policy } = await startWorkerHubPolicy({ ...hub, HUB_POLICY_ENFORCEMENT: "off" }, logger, prisma);
  expect(await policy!.workAllowed({ tenant: "t", subject: "s" })).toBe(true);
  expect(logger.warn).toHaveBeenCalledOnce();
});

it("stays locked with policy on and no Hub values", async () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const { policy } = await startWorkerHubPolicy({ ...hub }, logger, prisma);
  expect((await policy!.status()).state).toBe("not_configured");
  expect(await policy!.workAllowed({ tenant: "t", subject: "s" })).toBe(false);
  expect(logger.error).toHaveBeenCalledOnce();
});

it("refuses to start with policy off and SSO on", async () => {
  await expect(
    startWorkerHubPolicy({ ...hub, HUB_POLICY_ENFORCEMENT: "off", HUB_SSO_ENABLED: "true" }, logger, prisma),
  ).rejects.toThrow("HUB_SSO_ENABLED=true requires HUB_POLICY_ENFORCEMENT=on");
});
```

- [ ] **Step 2: Run them and confirm they fail:** `pnpm vitest run apps/worker/src/hub-policy.test.ts`

- [ ] **Step 3: Implement.** Move lines 89-127 of `index.ts` into `startWorkerHubPolicy`, keeping the logging, restart callback and `startHubPolicyRuntime` call identical. Add:

```ts
  if (config?.policyDisabled) {
    const entry = hubPolicyDisabledLogEntry();
    logger.warn(entry.message, entry.attributes);
    return { config, policy: disabledHubPolicy({ tenantId: config.tenantId }) };
  }
```

`index.ts` calls it and passes `config` and `policy` to `createUserWorkAuthorizer` exactly as today. `restartForHubPolicy` stays in `index.ts` and is passed in as `onRestartRequired`.

- [ ] **Step 4: Run the worker and auth tests and confirm they pass.**

- [ ] **Step 5: Commit** `feat(worker): run bot work with Hub policy off (CAAH-83)`

### Task 6: Docs and env examples

**Files:** `docs/hub-auth.md`, `docs/self-host.md`, `.env.example`, `infra/compose/docker-compose.hub.yml`

- [ ] **Step 1:** In `docs/hub-auth.md`, add a `HUB_POLICY_ENFORCEMENT` row to the "Configuring Hub mode" table: process API and worker, value `on` (default) or `off`. Add a section `## Running without Hub registration` that covers:
  - It needs only `AUTH_MODE=hub`, `HUB_AUTH_ORIGIN` and `HUB_POLICY_ENFORCEMENT=off`, on both processes.
  - What stays: Hub email-first and password sign-in, product entitlement, the verify cache, refresh, revoke, and the optional `HUB_AUTH_TENANT_ID` pin.
  - What is off: the service-config fetch, assignments, Hub-managed settings and the `HUB_*` policy refusal codes.
  - SSO is refused at startup.
  - The startup warning, and `/internal/health` reporting `status: "ok"` and `hubPolicy.state: "disabled"`.
  - Leave the setting unset or `on` on registered deployments, so missing values still fail closed with `HUB_NOT_CONFIGURED`.
  - Do not layer `docker-compose.hub.yml`, which requires the service secret.

  Update the opening paragraph to say the tenant and service credential are required unless policy enforcement is off.
- [ ] **Step 2:** In `.env.example`, add a commented `# HUB_POLICY_ENFORCEMENT=on` block under the Hub settings, and adjust the "Required with AUTH_MODE=hub" comments to say "unless HUB_POLICY_ENFORCEMENT=off". In `docs/self-host.md`, add one sentence to the Hub paragraph that points an unregistered deployment to the new section and says it skips the overlay. In `infra/compose/docker-compose.hub.yml`, add one header line saying the overlay is for registered deployments only.
- [ ] **Step 3:** Run `pnpm lint`, and run `pnpm vitest run infra/updater/src/compose-hub.test.ts` to confirm the overlay comment change doesn't break the overlay test.
- [ ] **Step 4: Commit** `docs: document running Hub mode without Hub registration (CAAH-83)`

### Task 7: Full verification

- [ ] `pnpm lint` and `pnpm check` (turbo typecheck across packages)
- [ ] `pnpm test` (all unit tests, including the unchanged CAAH-36 suites: `hub-policy*.test.ts`, `hub.test.ts`, `hub-client.test.ts`, `apps/api/src/hub-policy.test.ts`, `health.test.ts`)
- [ ] `VERIFY_DATABASE=1 pnpm test:integration` (Postgres journeys, including `hub.postgres.test.ts` and `hub-policy.postgres.test.ts`)
- [ ] Relevant e2e: there is no UI change and no Hub-mode web e2e. Run `pnpm test:e2e` for the web auth specs (`auth-lifecycle.spec.ts`) as a regression check, and let CI run the full Playwright and desktop suites.
- [ ] Push, keep the PR a draft, and watch CI and review bots until there is no actionable feedback.

## Acceptance mapping

| Criterion | Covered by |
| --- | --- |
| 1. Opt-out with no `HUB_*`: API and worker start, a Hub user signs in, a bot run executes | Tasks 1, 3, 4 and 5 tests, and the Postgres journey in Task 3 (sign-in, then the work authorizer admits the run) |
| 2. Unset, no `HUB_*`: locked as today | Existing `not_configured` tests unchanged, plus the new "defaults to on" and worker "stays locked" tests |
| 3. Opt-out plus SSO fails startup clearly | Task 1 parser tests (both processes), and the Task 4 and Task 5 startup tests |
| 4. Registered behavior unchanged | All existing CAAH-36 suites pass unmodified. Registered-path code changes only by the extraction in Task 5 |
| 5. Tests and green CI | Task 7 |

## Risks and open questions

1. **Flag name and values.** I propose `HUB_POLICY_ENFORCEMENT=on|off`, with `HUB_POLICY_ENABLED=true|false` as the alternative. Which does the PM prefer?
2. **Policy off means fail-open on assignments.** Every Hub user whose tenant entitles the product can sign in, and with no tenant pin, any tenant can. This matches `4306c218`. Should the docs recommend setting `HUB_AUTH_TENANT_ID` as a pin when the policy is off? I lean yes, as a recommendation rather than a requirement, because the blocked deployment may not know its tenant id yet.
3. **A once-registered deployment switched to off** keeps its encrypted `hub_policy_snapshot` row, but nothing reads it. Turning enforcement back on refreshes from Hub at startup as usual. No migration is needed.
4. **Health is `ok` while the policy is disabled.** If monitoring should treat this as notable, the `hubPolicy.state` field carries it. I chose not to report `degraded`, because that would page on a deliberate configuration.
5. **Mismatched-tenant sign-in now fails earlier** than at `4306c218` (`HUB_ACCESS_DENIED` at sign-in instead of a 401 on the first request). That is strictly safer, but it is a small behavior difference to confirm.
