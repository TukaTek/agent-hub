# Hub Session Recovery (CAAH-108) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** A Hub timeout, abort, network failure, malformed reply, 408, 429 or 5xx keeps the Agent Hub session and answers 503. Only a definitive Hub rejection ends the session. Hub I/O never runs inside a DB transaction, and a stale outcome can never overwrite or delete a newer grant.

**Architecture:** `createHubSessionAuthorizer` stops wrapping Hub calls in a `FOR UPDATE` transaction. It reads the rows, calls Hub with no connection held, and classifies failures with one allowlist, `isHubRejection` in `hub-client.ts`. Definitive rejections delete through a compare-and-swap on the stored refresh-token ciphertext, which is unique per write. Anything else throws `HubSessionUnavailableError`. Refresh is single-flight: in-process via a promise map, and across processes via a new nullable `hub_session.refreshLeaseUntil` lease claimed by a conditional `UPDATE`. Better Auth's `findSession` override maps `HubSessionUnavailableError` to `APIError("SERVICE_UNAVAILABLE", { code: "HUB_UNAVAILABLE" })`. The API maps that to oRPC `SERVICE_UNAVAILABLE` (HTTP 503). Web and mobile already keep the session and retry on 503, so no client code changes.

**Tech Stack:** TypeScript (tsc 7), Better Auth 1.7.11, Prisma + PostgreSQL, oRPC, Hono, Vitest 4.1.

**Spec:** The CAAH-108 Linear contract and its diagnosis (verified root cause, current and proposed mapping tables).

## Global Constraints

- Transient (TimeoutError / AbortError / network `TypeError` / malformed body / 408 / 429 / 5xx / DB error during authorize) → **retain session, 503**, never anonymous or 401.
- Delete only on a definitive Hub rejection (`HubRequestError` 4xx except 408/429, or `HubRejectedError`), or a local decrypt failure of the stored grant, and only via CAS on the grant the request used.
- No Hub HTTP inside `prisma.$transaction` or while holding `FOR UPDATE`.
- Refresh rotation security preserved: never call `/refresh` twice with the same refresh token concurrently, and an orphaned grant from a lost CAS is revoked at Hub.
- Explicit sign-out, revoke-session paths and tenant isolation behave exactly as today.
- Out of scope: tool-completion audit / transaction-pool errors, executor copy, production, merge, deploy.
- Fake credentials only. New test values use the `test-fake-` prefix. Never log tokens, emails or Hub bodies.
- No new user-facing copy. Reuse `HUB_UNAVAILABLE` and `HUB_SIGN_IN_UNAVAILABLE_MESSAGE` from `@cortexai-agent-hub/core`.
- Migration is additive only (nullable column), so it keeps working with the previous release during the side-by-side deploy window.
- Tests: scoped, serial, offline. `pnpm exec vitest run --maxWorkers=2 <files>`. No full monorepo test or build. Never run the desktop Playwright suite locally.
- Never touch other checkouts or an existing local Postgres. A scratch Postgres (optional, Task 8) uses a separate, unused port.

## File Structure

| File                                                                                                                        | Responsibility                               | Change                                                                                                                                       |
| --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/auth/src/hub-client.ts`                                                                                           | Hub transport and response validation        | Add `HubRejectedError`, `isHubRejection`; throw `HubRejectedError` for semantic denials                                                      |
| `packages/auth/src/hub-client.test.ts`                                                                                      | Client contract tests                        | Add classification tests over a fake `fetch`                                                                                                 |
| `packages/auth/src/hub-sessions.ts`                                                                                         | Session and work authorization against Hub   | Rewrite `authorize`: no tx, classification, CAS end, lease refresh; add `HubSessionUnavailableError`                                         |
| `packages/auth/src/index.ts`                                                                                                | Better Auth composition                      | `findSession` maps unavailable → 503 `APIError`; export `isHubSessionUnavailable`, `HubSessionUnavailableError`                              |
| `packages/auth/src/hub.test.ts`                                                                                             | In-memory end-to-end auth tests              | Extend Prisma fake (`updateMany`, CAS `deleteMany`, open-tx counter); new behaviour tests; migrate generic-`Error` tests to real error types |
| `packages/auth/src/hub.postgres.test.ts`, `packages/auth/src/hub-sessions.test.ts`                                          | Postgres-gated tests (CI `test:integration`) | Real-DB lease, CAS and retention tests; migrate generic errors                                                                               |
| `packages/db/prisma/schema.prisma` + `packages/db/prisma/migrations/20261105120000_hub_session_refresh_lease/migration.sql` | Schema                                       | Add nullable `refreshLeaseUntil`                                                                                                             |
| `apps/api/src/router.ts`, `apps/api/src/router.test.ts`                                                                     | RPC auth middleware                          | `sessionUnavailable` context → `SERVICE_UNAVAILABLE`                                                                                         |
| `apps/api/src/app.ts`                                                                                                       | HTTP composition                             | Map `getSession` unavailability to context flag / HTTP 503                                                                                   |
| `apps/web/src/lib/session-gate.test.ts`                                                                                     | Web gate contract                            | Pin: established session + 503 stays authenticated and recovers                                                                              |
| `docs/hub-auth.md`                                                                                                          | Ops docs                                     | Replace "outage deletes the session" and "row lock" text                                                                                     |

---

### Task 0: Workspace setup (no commit)

**Files:** none.

- [x] **Step 1: Confirm branch and clean tree**

Run: `git status --short --branch`
Expected: the CAAH-108 branch and no changes, apart from this plan file if it has not been committed yet.

- [x] **Step 2: Install with this worktree's own lockfile (shared pnpm store, no symlinks to another checkout)**

Run: `df -h . && pnpm install --frozen-lockfile`
Expected: completes. Stop if free disk drops below ~8 GB.

- [x] **Step 3: Generate the Prisma client (no database needed)**

Run: `DATABASE_URL=postgres://unused:unused@127.0.0.1:1/unused pnpm --filter @cortexai-agent-hub/db generate`
Expected: "Generated Prisma Client".

- [x] **Step 4: Baseline the scoped suites**

Run: `pnpm exec vitest run --maxWorkers=2 packages/auth/src/hub.test.ts packages/auth/src/hub-client.test.ts packages/auth/src/hub-sessions.test.ts packages/auth/src/hub-verify-cache.test.ts packages/auth/src/hub.postgres.test.ts`
Expected: all pass. The Postgres-gated tests are reported as skipped. Record the counts.

---

### Task 1: Classify definitive Hub rejections in the client

**Files:**

- Modify: `packages/auth/src/hub-client.ts:170-316` (new class next to `HubUnsupportedIdpError`; throw sites in `identity`, `expiry`, `verify`, `grant`)
- Test: `packages/auth/src/hub-client.test.ts`

**Interfaces:**

- Produces: `export class HubRejectedError extends Error` (constructor `(message: "Hub access denied" | "Hub identity changed" | "Hub session expired")`), and `export function isHubRejection(error: unknown): boolean`.

- [x] **Step 1: Write the failing test** (append to `hub-client.test.ts`; reuse the file's existing imports and `config` style)

```ts
describe("Hub rejection classification (CAAH-108)", () => {
  const origin = "https://hub.example.test";
  const expected = { subject: "test-fake-subject", tenant: "test-fake-tenant" };
  const clientWith = (fetcher: typeof fetch) =>
    createHubClient({ origin, tenantId: expected.tenant }, fetcher);
  const verifyError = async (fetcher: typeof fetch) =>
    clientWith(fetcher)
      .verify("test-fake-access", expected)
      .then(
        () => undefined,
        (error: unknown) => error,
      );

  it.each([
    ["timeout", () => Promise.reject(new DOMException("timed out", "TimeoutError"))],
    ["abort", () => Promise.reject(new DOMException("aborted", "AbortError"))],
    ["network", () => Promise.reject(new TypeError("fetch failed"))],
    ["408", async () => new Response("{}", { status: 408 })],
    ["429", async () => new Response("{}", { status: 429 })],
    ["500", async () => new Response("{}", { status: 500 })],
    ["502", async () => new Response("<html>", { status: 502 })],
    ["503", async () => Response.json({ error: "unavailable" }, { status: 503 })],
    ["504", async () => new Response("", { status: 504 })],
    ["malformed 200", async () => new Response("<html>maintenance</html>", { status: 200 })],
  ])("treats %s as not a rejection", async (_name, reply) => {
    const error = await verifyError(vi.fn(reply) as never);
    expect(error).toBeDefined();
    expect(isHubRejection(error)).toBe(false);
  });

  it.each([
    ["401", async () => Response.json({ error: "invalid_token" }, { status: 401 })],
    ["403", async () => Response.json({ error: "access_denied" }, { status: 403 })],
    ["400 invalid_grant", async () => Response.json({ error: "invalid_grant" }, { status: 400 })],
    ["valid:false", async () => Response.json({ valid: false })],
    [
      "other tenant",
      async () =>
        Response.json({ valid: true, userId: expected.subject, tenantId: "test-fake-other" }),
    ],
    [
      "other subject",
      async () =>
        Response.json({ valid: true, userId: "test-fake-other", tenantId: expected.tenant }),
    ],
  ])("treats %s as a definitive rejection", async (_name, reply) => {
    const error = await verifyError(vi.fn(reply) as never);
    expect(isHubRejection(error)).toBe(true);
  });

  it("treats a refresh refused with invalid_grant as definitive", async () => {
    const client = clientWith(
      vi.fn(async () => Response.json({ error: "invalid_grant" }, { status: 400 })) as never,
    );
    await expect(client.refresh("test-fake-refresh")).rejects.toSatisfy(isHubRejection);
  });

  it("keeps the existing messages so sign-in callers are unchanged", async () => {
    const error = await verifyError(vi.fn(async () => Response.json({ valid: false })) as never);
    expect(error).toBeInstanceOf(HubRejectedError);
    expect((error as Error).message).toBe("Hub access denied");
  });
});
```

Add `HubRejectedError, isHubRejection` to the file's import from `./hub-client.js`.

- [x] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run --maxWorkers=2 packages/auth/src/hub-client.test.ts -t "CAAH-108"`
Expected: FAIL, because `isHubRejection` / `HubRejectedError` are not exported.

- [x] **Step 3: Implement**

In `hub-client.ts`, after `HubUnsupportedIdpError`:

```ts
/** Hub answered and refused this identity, token or entitlement; never an outage. */
export class HubRejectedError extends Error {
  constructor(message: "Hub access denied" | "Hub identity changed" | "Hub session expired") {
    super(message);
    this.name = "HubRejectedError";
  }
}

/**
 * Whether Hub definitively refused: an explicit denial, or a 4xx other than 408 and 429.
 * Timeouts, aborts, network errors, malformed replies, 408, 429 and 5xx are not refusals.
 */
export function isHubRejection(error: unknown): boolean {
  if (error instanceof HubRejectedError) return true;
  return (
    error instanceof HubRequestError &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 408 &&
    error.status !== 429
  );
}
```

`HubRequestError` is declared below this point. Move the `HubRequestError` class above `HubRejectedError` so both are declared before `isHubRejection`.

Replace these throws, and only these, with `HubRejectedError` (same message). Leave `"Invalid Hub response"` as `Error`:

- `expiry()`: `throw new HubRejectedError("Hub session expired");`
- `identity()`: `throw new HubRejectedError("Hub access denied");`
- `verify()`: the four `throw new Error("Hub access denied")` and the `throw new Error("Hub identity changed")`.
- `grant()`: `body.success !== true`, `expectedTenant` mismatch (`"Hub identity changed"`), `!enabled(body.products)`.
- `lookup()` tenant mismatch, `ssoExchange` tenant/deployment mismatch, `login` tenant mismatch: switch these too, with the same messages, so every Hub denial has one type.

- [x] **Step 4: Run tests**

Run: `pnpm exec vitest run --maxWorkers=2 packages/auth/src/hub-client.test.ts packages/auth/src/hub.test.ts`
Expected: PASS (messages unchanged; `hub.test.ts` still uses generic errors and the old authorizer).

- [x] **Step 5: Typecheck and commit**

Run: `pnpm --filter @cortexai-agent-hub/auth check`
Expected: no errors.

```bash
git add packages/auth/src/hub-client.ts packages/auth/src/hub-client.test.ts
git commit -m "CAAH-108: Classify definitive Hub rejections apart from outages

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Verify path keeps the session on outages and answers 503

**Files:**

- Modify: `packages/auth/src/hub-sessions.ts` (whole `createHubSessionAuthorizer` body; the refresh branch keeps today's logic until Task 4 but moves out of the transaction)
- Modify: `packages/auth/src/index.ts:489-496` (`findSession` override) and its exports near line 84
- Test: `packages/auth/src/hub.test.ts`

**Interfaces:**

- Consumes: `isHubRejection`, `HubRejectedError` (Task 1).
- Produces:
  - `export class HubSessionUnavailableError extends Error` from `hub-sessions.ts`.
  - `authorize(sessionId, userId): Promise<boolean>` that **throws** `HubSessionUnavailableError` for unavailability.
  - `export function isHubSessionUnavailable(error: unknown): boolean` from `index.ts`, true for the Better Auth `APIError` that `findSession` throws.
  - Fixture additions in `hub.test.ts`: `openTransactions(): number`, `prisma.hubSession.updateMany`, and CAS-aware `prisma.session.deleteMany` returning `{ count }`.

- [x] **Step 1: Extend the Prisma fake in `hub.test.ts` `fixture()`**

Replace the `$transaction`, `hubSession` and `session.deleteMany` members:

```ts
  let open = 0;
  const prisma: any = {
    authData: data,
    $queryRaw: vi.fn(async () => []),
    $transaction: vi.fn((fn: (tx: any) => Promise<unknown>) => {
      // Simulate the database row lock without a network dependency.
      const result = transaction.then(async () => {
        open++;
        try {
          return await fn(prisma);
        } finally {
          open--;
        }
      });
      transaction = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    }),
```

```ts
    hubSession: {
      create: async ({ data: row }: any) => {
        grants.set(row.sessionId, { refreshLeaseUntil: null, ...row });
        return row;
      },
      findUnique: async ({ where }: any) => grants.get(where.sessionId),
      update: async ({ where, data: updates }: any) =>
        Object.assign(grants.get(where.sessionId), updates),
      // Conditional writes, as PostgreSQL would apply them to one row.
      updateMany: async ({ where, data: updates }: any) => {
        const row = grants.get(where.sessionId);
        const leaseFree =
          !where.OR ||
          row?.refreshLeaseUntil == null ||
          row.refreshLeaseUntil < where.OR[1].refreshLeaseUntil.lt;
        if (!row || (where.refreshToken !== undefined && row.refreshToken !== where.refreshToken) || !leaseFree)
          return { count: 0 };
        Object.assign(row, updates);
        return { count: 1 };
      },
    },
    session: {
      // ...findMany and findUnique unchanged...
      deleteMany: async ({ where }: any) => {
        const expected = where.hubSession?.is?.refreshToken;
        if (expected !== undefined && grants.get(where.id)?.refreshToken !== expected)
          return { count: 0 };
        const before = data.session!.length;
        data.session = data.session!.filter((row) => row.id !== where.id);
        grants.delete(where.id);
        return { count: before - data.session.length };
      },
    },
```

Add `openTransactions: () => open` to the object `fixture()` returns.

- [x] **Step 2: Write the failing tests** (new `describe` in `hub.test.ts`)

```ts
describe("Hub outages keep the session (CAAH-108)", () => {
  const outages: [string, () => unknown][] = [
    ["a timeout", () => new DOMException("timed out", "TimeoutError")],
    ["an abort", () => new DOMException("aborted", "AbortError")],
    ["a network failure", () => new TypeError("fetch failed")],
    ["a malformed reply", () => new Error("Invalid Hub response")],
    ["408", () => new HubRequestError(408, undefined)],
    ["429", () => new HubRequestError(429, undefined)],
    ["500", () => new HubRequestError(500, undefined)],
    ["502", () => new HubRequestError(502, undefined)],
    ["503", () => new HubRequestError(503, "unavailable")],
    ["504", () => new HubRequestError(504, undefined)],
  ];
  const getSessionStatus = (f: ReturnType<typeof fixture>, headers: Headers) =>
    f.auth.handler(new Request("http://web.example.test/api/auth/get-session", { headers }));

  async function afterWindow() {
    const f = fixture();
    const { headers } = await f.login();
    vi.useFakeTimers({ toFake: ["Date"] });
    expect(await f.auth.api.getSession({ headers })).not.toBeNull();
    vi.setSystemTime(Date.now() + 30_001); // past the CAAH-40 window
    return { f, headers };
  }
  afterEach(() => vi.useRealTimers());

  it.each(outages)(
    "answers 503 and keeps the session when verify fails with %s",
    async (_n, error) => {
      const { f, headers } = await afterWindow();
      f.client.verify.mockRejectedValueOnce(error());
      const response = await getSessionStatus(f, headers);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ code: "HUB_UNAVAILABLE" });
      expect(response.headers.get("set-cookie") ?? "").not.toMatch(/session_token=;/);
      expect(f.data.session).toHaveLength(1);
      expect(f.grants.size).toBe(1);
      // Hub returns: the same credentials work again without signing in.
      expect(await f.auth.api.getSession({ headers })).not.toBeNull();
    },
  );

  it("throws the unavailable error from auth.api.getSession for the API to map", async () => {
    const { f, headers } = await afterWindow();
    f.client.verify.mockRejectedValueOnce(new DOMException("timed out", "TimeoutError"));
    const error = await f.auth.api.getSession({ headers }).catch((e: unknown) => e);
    expect(isHubSessionUnavailable(error)).toBe(true);
  });

  it("never calls Hub while a database transaction is open", async () => {
    const { f, headers } = await afterWindow();
    f.client.verify.mockImplementation(async () => {
      expect(f.openTransactions()).toBe(0);
    });
    expect(await f.auth.api.getSession({ headers })).not.toBeNull();
    expect(f.client.verify).toHaveBeenCalledOnce();
  });

  it("serves the CAAH-40 window from cache without calling Hub, even while Hub is down", async () => {
    const f = fixture();
    const { headers } = await f.login();
    expect(await f.auth.api.getSession({ headers })).not.toBeNull();
    f.client.verify.mockClear();
    f.client.verify.mockRejectedValue(new HubRequestError(503, undefined));
    expect(await f.auth.api.getSession({ headers })).not.toBeNull();
    expect(f.client.verify).not.toHaveBeenCalled();
  });

  it.each([
    ["401", () => new HubRequestError(401, "invalid_token")],
    ["403", () => new HubRequestError(403, "access_denied")],
    ["a denial", () => new HubRejectedError("Hub access denied")],
    ["an identity change", () => new HubRejectedError("Hub identity changed")],
  ])("ends the session when Hub definitively refuses with %s", async (_n, error) => {
    const { f, headers } = await afterWindow();
    f.client.verify.mockRejectedValueOnce(error());
    expect(await f.auth.api.getSession({ headers })).toBeNull();
    expect(f.data.session).toHaveLength(0);
  });

  it("keeps a session another request refreshed while a stale verify was refused", async () => {
    const { f, headers } = await afterWindow();
    const grant = [...f.grants.values()][0];
    f.client.verify.mockImplementationOnce(async () => {
      // Another process rotated the grant while this verify was in flight.
      grant.refreshToken = await symmetricEncrypt({
        key: encryptionKey,
        data: "test-fake-refresh-2",
      });
      grant.accessToken = await symmetricEncrypt({
        key: encryptionKey,
        data: "test-fake-access-2",
      });
      throw new HubRequestError(401, "invalid_token");
    });
    expect(await f.auth.api.getSession({ headers })).not.toBeNull();
    expect(f.data.session).toHaveLength(1);
    expect(f.client.verify).toHaveBeenLastCalledWith("test-fake-access-2", expect.anything());
  });
});
```

Imports to add at the top of `hub.test.ts`: `HubRejectedError` from `./hub-client.js` and `isHubSessionUnavailable` from `./index.js`. `symmetricEncrypt` and `HubRequestError` are already imported.

- [x] **Step 3: Run them to verify they fail**

Run: `pnpm exec vitest run --maxWorkers=2 packages/auth/src/hub.test.ts -t "CAAH-108"`
Expected: FAIL. Outage cases get `200` with `null` and the session deleted; the definitive cases may pass; the stale case deletes.

- [x] **Step 4: Spike — confirm Better Auth propagates a thrown `APIError` from `findSession`**

Make the `index.ts` change first (Step 5b), then rerun the 503 test with a temporary stub authorizer (`throw new HubSessionUnavailableError()`):

- If `/get-session` answers 503 and the cookie is not cleared, continue.
- **If Better Auth swallows it** (status 200, `null`, or cookie cleared): stop and record the observed behaviour in the PR. Implement the fallback instead: in `hooks.before` (`index.ts:383`), for `ctx.path === "/get-session"`, resolve the session token, call `hub.authorizeSession` once per request, and throw the 503 `APIError` there. Memoize the result per request with a `WeakMap<Request, Promise<boolean>>` so `findSession` reuses it. Keep everything else in this plan unchanged.

- [x] **Step 5a: Implement the authorizer (verify path; refresh still in-line but with no transaction)**

Replace the body of `packages/auth/src/hub-sessions.ts` from the imports to the end of `createHubSessionAuthorizer` with:

```ts
import type { PrismaClient } from "@cortexai-agent-hub/db";
import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import {
  createHubClient,
  type HubAuthConfig,
  HubRejectedError,
  isHubRejection,
} from "./hub-client.js";
import { disabledHubPolicy, type HubPolicy } from "./hub-policy.js";
import { createHubVerifyCache, logCacheMetrics } from "./hub-verify-cache.js";

/** Hub could not confirm the session right now. The session is kept; callers answer 503. */
export class HubSessionUnavailableError extends Error {
  constructor(options?: { cause?: unknown }) {
    super("CortexAI Hub can't be reached", options);
    this.name = "HubSessionUnavailableError";
  }
}

/** `false` ends access; "stale" means the stored grant changed under this request. */
type Outcome = boolean | "stale";

// (HubSessionAuthorizerConfig and HubSessionPolicy unchanged)

export function createHubSessionAuthorizer(/* signature unchanged */) {
  const { policy } = options;
  const verifyCache = /* unchanged */;
  // metricsTimer unchanged
  const decrypt = (data: string) => symmetricDecrypt({ key: encryptionKey, data });
  const encrypt = (data: string) => symmetricEncrypt({ key: encryptionKey, data });

  /** Ends the session only while it still holds the grant this request used. */
  async function end(sessionId: string, used: string): Promise<Outcome> {
    const { count } = await prisma.session.deleteMany({
      where: { id: sessionId, hubSession: { is: { refreshToken: used } } },
    });
    return count ? false : "stale";
  }

  /** A definitive Hub answer ends the session; anything else keeps it for when Hub returns. */
  async function failed(error: unknown, sessionId: string, used: string): Promise<Outcome> {
    if (isHubRejection(error)) return end(sessionId, used);
    throw new HubSessionUnavailableError({ cause: error });
  }

  async function authorizeOnce(sessionId: string, userId: string): Promise<Outcome> {
    const grantSession = await prisma.hubSession.findUnique({ where: { sessionId } });
    const session = await prisma.session.findUnique({ where: { id: sessionId } });
    const identity = await prisma.hubIdentity.findUnique({ where: { userId } });
    if (
      !grantSession ||
      !session ||
      session.userId !== userId ||
      session.expiresAt.getTime() <= Date.now() ||
      !identity ||
      identity.origin !== config.origin ||
      (config.tenantId && identity.tenant !== config.tenantId) ||
      !grantSession.accessToken
    )
      return false;
    const used = grantSession.refreshToken;
    if (grantSession.accessUntil.getTime() > Date.now()) {
      let accessToken: string;
      try {
        accessToken = await decrypt(grantSession.accessToken);
      } catch {
        return end(sessionId, used);
      }
      const tokenHash = verifyCache.hashToken(accessToken);
      const tokenExpiresAt = grantSession.accessUntil.getTime();
      // Within the CAAH-40 window the session runs on last-known-good.
      if (verifyCache.get(tokenHash, tokenExpiresAt)) return true;
      const verifyStart = Date.now();
      try {
        await client.verify(accessToken, identity);
      } catch (error) {
        return failed(error, sessionId, used);
      }
      verifyCache.recordVerifyLatency(Date.now() - verifyStart);
      // Once the window lapses, Hub policy must admit the session like a new
      // sign-in. A refusal is not a revocation, so the session is kept for
      // when Hub recovers.
      if (!(await policy.sessionAllowed(identity))) return false;
      verifyCache.set(tokenHash, tokenExpiresAt);
      return true;
    }
    return refresh(sessionId, grantSession, identity);
  }

  /** Task 2 interim: refresh without a transaction, CAS on the grant used. Task 4 adds the lease. */
  async function refresh(
    sessionId: string,
    grantSession: { refreshToken: string; accessToken: string | null },
    identity: { subject: string; tenant: string },
  ): Promise<Outcome> {
    const used = grantSession.refreshToken;
    let refreshToken: string;
    try {
      refreshToken = await decrypt(used);
    } catch {
      return end(sessionId, used);
    }
    let grant: Awaited<ReturnType<typeof client.refresh>>;
    try {
      grant = await client.refresh(refreshToken);
      if (grant.subject !== identity.subject || grant.tenant !== identity.tenant)
        throw new HubRejectedError("Hub identity changed");
    } catch (error) {
      return failed(error, sessionId, used);
    }
    const stored = await prisma.hubSession.updateMany({
      where: { sessionId, refreshToken: used },
      data: {
        refreshToken: await encrypt(grant.refreshToken),
        accessToken: await encrypt(grant.accessToken),
        accessUntil: grant.accessUntil,
      },
    });
    if (!stored.count) {
      // The session ended or changed meanwhile; nothing local holds this grant.
      await client.revoke(grant.refreshToken).catch(() => undefined);
      return "stale";
    }
    if (grantSession.accessToken) {
      const old = await decrypt(grantSession.accessToken).catch(() => undefined);
      if (old) verifyCache.invalidate(verifyCache.hashToken(old));
    }
    return policy.sessionAllowed(identity);
  }

  const authorize = async (sessionId: string, userId: string): Promise<boolean> => {
    // Hub mode without its tenant or service credential admits no session (F1).
    if (config.notConfigured) return false;
    try {
      // A stale outcome means another request changed the grant: decide again on the new one.
      for (let attempt = 0; attempt < 2; attempt++) {
        const outcome = await authorizeOnce(sessionId, userId);
        if (outcome !== "stale") return outcome;
      }
    } catch (error) {
      if (error instanceof HubSessionUnavailableError) throw error;
      // A database failure is not a sign-out either.
      throw new HubSessionUnavailableError({ cause: error });
    }
    throw new HubSessionUnavailableError();
  };

  return Object.assign(authorize, {
    /** Access to the verify cache for testing and observability */
    _cache: verifyCache,
  });
}
```

Notes for the implementer:

- `client.revoke` exists on the real client and on every test client. The Postgres test client at `hub.postgres.test.ts:519` already has `revoke`.
- `createUserWorkAuthorizer` is changed in Task 5. Until then a thrown unavailability propagates from it. That is acceptable between commits.

- [x] **Step 5b: Map unavailability in `findSession`** (`packages/auth/src/index.ts:492-496`)

```ts
                  if (session.user.id.startsWith("hub_")) {
                    if (!hub) return null;
                    try {
                      return (await hub.authorizeSession(session.session.id, session.user.id))
                        ? session
                        : null;
                    } catch (error) {
                      // Hub could not answer: keep the session and say so, never sign out.
                      if (error instanceof HubSessionUnavailableError)
                        throw new APIError("SERVICE_UNAVAILABLE", {
                          code: HUB_UNAVAILABLE,
                          message: HUB_SIGN_IN_UNAVAILABLE_MESSAGE,
                        });
                      throw error;
                    }
                  }
```

Add to `index.ts`. Import `HUB_UNAVAILABLE` and `HUB_SIGN_IN_UNAVAILABLE_MESSAGE` from `@cortexai-agent-hub/core` (extend the existing core import), and `HubSessionUnavailableError` from `./hub-sessions.js`. `APIError` is already imported.

```ts
export { createUserWorkAuthorizer, HubSessionUnavailableError } from "./hub-sessions.js";

/** The error `auth.api.getSession` throws while Hub cannot confirm a kept session. */
export function isHubSessionUnavailable(error: unknown): boolean {
  return (
    error instanceof APIError &&
    error.status === "SERVICE_UNAVAILABLE" &&
    (error.body as { code?: unknown } | undefined)?.code === HUB_UNAVAILABLE
  );
}
```

Check `APIError`'s field names in `node_modules/better-call` (`status` string vs `statusCode` number, `body`) and adjust if they differ. The Step 2 test pins the behaviour.

- [x] **Step 6: Migrate the existing tests that relied on "any error deletes"**

In `hub.test.ts`, swap generic errors for real Hub errors. Expectations are unchanged.

- `:523` "removes access before token expiry…": `new Error("assignment removed")` → `new HubRejectedError("Hub access denied")`.
- `:576` refresh "denied": `new Error("invalid_grant")` → `new HubRequestError(400, "invalid_grant")`.
- `:984` "drops an SSO session…": `new Error("user disabled")` → `new HubRequestError(403, "access_denied")`.
- `:2433` "still requires Hub login and current entitlement": `new Error("entitlement removed")` → `new HubRejectedError("Hub access denied")`.

Leave the sign-in-path tests at `:439-440, :509, :733-734, :909, :1392` unchanged; they exercise lookup and exchange, not the authorizer.

- [x] **Step 7: Run tests**

Run: `pnpm exec vitest run --maxWorkers=2 packages/auth/src/hub.test.ts packages/auth/src/hub-client.test.ts packages/auth/src/hub-verify-cache.test.ts`
Expected: PASS, including "rotates encrypted refresh once for concurrent expired-session checks" (`:555`). The fake's `$transaction` chain no longer serializes the authorizer. If `:555` fails because both requests now refresh, mark it `it.fails` temporarily, note it in the commit body, and remove the marker in Task 4, which fixes it.

- [x] **Step 8: Typecheck and commit**

Run: `pnpm --filter @cortexai-agent-hub/auth check`

```bash
git add packages/auth/src/hub-sessions.ts packages/auth/src/index.ts packages/auth/src/hub.test.ts
git commit -m "CAAH-108: Keep Hub sessions through outages and answer 503

A Hub timeout, network failure, malformed reply, 408, 429 or 5xx no
longer deletes the session. Only a definitive Hub refusal ends it, and
only while the stored grant is the one the request used. Hub calls no
longer run inside a row-locking transaction.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Additive refresh lease column

**Files:**

- Modify: `packages/db/prisma/schema.prisma:122-133`
- Create: `packages/db/prisma/migrations/20261105120000_hub_session_refresh_lease/migration.sql`

**Interfaces:**

- Produces: `HubSession.refreshLeaseUntil: Date | null` (Prisma field, column `"refreshLeaseUntil"`).

- [x] **Step 1: Schema**

```prisma
model HubSession {
  sessionId    String   @id
  session      Session  @relation(fields: [sessionId], references: [id], onDelete: Cascade)
  refreshToken String
  accessUntil  DateTime
  accessToken  String?
  /// One process refreshes a grant at a time; others wait for it (CAAH-108).
  refreshLeaseUntil DateTime?
  // Retained for old OAuth sessions, which must sign in again.
  audience     String?
  clientId     String?

  @@map("hub_session")
}
```

- [x] **Step 2: Migration** (`migration.sql`, nullable and additive; the previous release ignores it)

```sql
-- One refresh per Hub grant across processes, without holding a row lock over Hub I/O (CAAH-108).
ALTER TABLE "hub_session" ADD COLUMN "refreshLeaseUntil" TIMESTAMP(3);
```

Check the existing `20260907010000_hub_tenant_auth/migration.sql` for the table's RLS or grant statements. A new column inherits table grants, so no `GRANT` is needed unless that file grants per column.

- [x] **Step 3: Regenerate and typecheck**

Run: `DATABASE_URL=postgres://unused:unused@127.0.0.1:1/unused pnpm --filter @cortexai-agent-hub/db generate && pnpm --filter @cortexai-agent-hub/db check && pnpm --filter @cortexai-agent-hub/auth check`
Expected: no errors.

- [x] **Step 4: Run the db package's migration-shape tests, if any exist**

Run: `ls packages/db/src/*migration*.test.ts 2>/dev/null && pnpm exec vitest run --maxWorkers=2 $(ls packages/db/src/*migration*.test.ts)`
Expected: PASS, or no such files.

- [x] **Step 5: Commit**

```bash
git add packages/db/prisma/schema.prisma packages/db/prisma/migrations/20261105120000_hub_session_refresh_lease
git commit -m "CAAH-108: Add a nullable refresh lease to hub_session

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Single-flight, lease-guarded refresh with CAS

**Files:**

- Modify: `packages/auth/src/hub-sessions.ts` (`refresh`, new `awaitRefresh`, `release`, in-process map)
- Test: `packages/auth/src/hub.test.ts`

**Interfaces:**

- Consumes: `HubSession.refreshLeaseUntil` (Task 3), the fixture `updateMany` lease semantics (Task 2 Step 1).
- Produces: constants `REFRESH_LEASE_MS = 30_000`, `REFRESH_WAIT_MS = 10_000`, `REFRESH_POLL_MS = 100` (module-private).

- [x] **Step 1: Write the failing tests** (add to the CAAH-108 `describe` in `hub.test.ts`)

```ts
const expire = (f: ReturnType<typeof fixture>) => {
  [...f.grants.values()][0].accessUntil = new Date(0);
};

it.each(outages)(
  "answers 503, keeps the session and frees the lease when refresh fails with %s",
  async (_n, error) => {
    const f = fixture();
    const { headers } = await f.login();
    expire(f);
    f.client.refresh.mockRejectedValueOnce(error());
    expect((await getSessionStatus(f, headers)).status).toBe(503);
    expect(f.data.session).toHaveLength(1);
    expect([...f.grants.values()][0].refreshLeaseUntil).toBeNull();
    // Hub returns: the next request refreshes with the same stored token.
    expect(await f.auth.api.getSession({ headers })).not.toBeNull();
    expect(f.client.refresh).toHaveBeenLastCalledWith("refresh-secret-1");
  },
);

it("ends the session once Hub confirms a rotation lost to a timeout", async () => {
  const f = fixture();
  const { headers } = await f.login();
  expire(f);
  f.client.refresh.mockRejectedValueOnce(new DOMException("timed out", "TimeoutError"));
  expect((await getSessionStatus(f, headers)).status).toBe(503);
  expect(f.data.session).toHaveLength(1);
  f.client.refresh.mockRejectedValueOnce(new HubRequestError(400, "invalid_grant"));
  expect(await f.auth.api.getSession({ headers })).toBeNull();
  expect(f.data.session).toHaveLength(0);
});

it("refreshes once for concurrent requests and never refreshes outside the lease", async () => {
  const f = fixture();
  const { headers } = await f.login();
  expire(f);
  let finish!: () => void;
  f.client.refresh.mockImplementationOnce(async () => {
    expect(f.openTransactions()).toBe(0);
    expect([...f.grants.values()][0].refreshLeaseUntil).toBeInstanceOf(Date);
    await new Promise<void>((resolve) => (finish = resolve));
    return {
      subject: "subject-1",
      tenant: config.tenantId,
      accessToken: "test-fake-access-2",
      refreshToken: "test-fake-refresh-2",
      accessUntil: new Date(Date.now() + 900_000),
    };
  });
  const both = Promise.all([
    f.auth.api.getSession({ headers }),
    f.auth.api.getSession({ headers }),
  ]);
  await vi.waitFor(() => expect(f.client.refresh).toHaveBeenCalledOnce());
  finish();
  expect((await both).every(Boolean)).toBe(true);
  expect(f.client.refresh).toHaveBeenCalledExactlyOnceWith("refresh-secret-1");
  expect([...f.grants.values()][0].refreshLeaseUntil).toBeNull();
});

it("waits for another process's refresh instead of spending the same token", async () => {
  const f = fixture();
  const { headers } = await f.login();
  const grant = [...f.grants.values()][0];
  grant.accessUntil = new Date(0);
  grant.refreshLeaseUntil = new Date(Date.now() + 30_000); // held elsewhere
  setTimeout(async () => {
    grant.refreshToken = await symmetricEncrypt({
      key: encryptionKey,
      data: "test-fake-refresh-2",
    });
    grant.accessToken = await symmetricEncrypt({ key: encryptionKey, data: "test-fake-access-2" });
    grant.accessUntil = new Date(Date.now() + 900_000);
    grant.refreshLeaseUntil = null;
  }, 150);
  expect(await f.auth.api.getSession({ headers })).not.toBeNull();
  expect(f.client.refresh).not.toHaveBeenCalled();
});

it("answers 503 when another process holds the lease too long, keeping the session", async () => {
  const f = fixture();
  const { headers } = await f.login();
  const grant = [...f.grants.values()][0];
  grant.accessUntil = new Date(0);
  grant.refreshLeaseUntil = new Date(Date.now() + 30_000);
  vi.useFakeTimers({ toFake: ["Date", "setTimeout"] });
  const pending = getSessionStatus(f, headers);
  await vi.advanceTimersByTimeAsync(10_200);
  expect((await pending).status).toBe(503);
  expect(f.client.refresh).not.toHaveBeenCalled();
  expect(f.data.session).toHaveLength(1);
});

it("does not let a refusal for a spent token delete a grant another process stored", async () => {
  const f = fixture();
  const { headers } = await f.login();
  expire(f);
  const grant = [...f.grants.values()][0];
  f.client.refresh.mockImplementationOnce(async () => {
    // Another process won a lease that expired under us and rotated first.
    grant.refreshToken = await symmetricEncrypt({
      key: encryptionKey,
      data: "test-fake-refresh-2",
    });
    grant.accessToken = await symmetricEncrypt({ key: encryptionKey, data: "test-fake-access-2" });
    grant.accessUntil = new Date(Date.now() + 900_000);
    throw new HubRequestError(400, "invalid_grant");
  });
  expect(await f.auth.api.getSession({ headers })).not.toBeNull();
  expect(f.data.session).toHaveLength(1);
});

it("revokes a grant it could not store because the session changed meanwhile", async () => {
  const f = fixture();
  const { headers } = await f.login();
  expire(f);
  const grant = [...f.grants.values()][0];
  f.client.refresh.mockImplementationOnce(async () => {
    // Another process finished its own refresh first (its write also clears the lease).
    grant.refreshToken = await symmetricEncrypt({
      key: encryptionKey,
      data: "test-fake-refresh-3",
    });
    grant.accessToken = await symmetricEncrypt({ key: encryptionKey, data: "test-fake-access-3" });
    grant.accessUntil = new Date(Date.now() + 900_000);
    grant.refreshLeaseUntil = null;
    return {
      subject: "subject-1",
      tenant: config.tenantId,
      accessToken: "test-fake-access-orphan",
      refreshToken: "test-fake-refresh-orphan",
      accessUntil: new Date(Date.now() + 900_000),
    };
  });
  expect(await f.auth.api.getSession({ headers })).not.toBeNull();
  expect(f.client.revoke).toHaveBeenCalledWith("test-fake-refresh-orphan");
  expect(f.data.session).toHaveLength(1);
});
```

- [x] **Step 2: Run them to verify they fail**

Run: `pnpm exec vitest run --maxWorkers=2 packages/auth/src/hub.test.ts -t "CAAH-108"`
Expected: FAIL. No lease is set, concurrent requests refresh twice, and nothing waits.

- [x] **Step 3: Implement the lease** (in `hub-sessions.ts`)

Module scope, above `createHubSessionAuthorizer`:

```ts
/** One refresh per grant across processes; outlasts a refresh's three 8 s Hub requests. */
const REFRESH_LEASE_MS = 30_000;
/** How long a request waits for another request's refresh before answering unavailable. */
const REFRESH_WAIT_MS = 10_000;
const REFRESH_POLL_MS = 100;
```

Inside `createHubSessionAuthorizer`:

```ts
/** Requests in this process share one refresh per session. */
const refreshing = new Map<string, Promise<Outcome>>();

/** Lets the next request refresh at once after a failed attempt. */
const release = (sessionId: string, used: string) =>
  prisma.hubSession
    .updateMany({ where: { sessionId, refreshToken: used }, data: { refreshLeaseUntil: null } })
    .catch(() => undefined);

/** Another process holds the lease: wait for its grant instead of spending the same token. */
async function awaitRefresh(sessionId: string, used: string): Promise<Outcome> {
  const deadline = Date.now() + REFRESH_WAIT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, REFRESH_POLL_MS));
    const row = await prisma.hubSession.findUnique({ where: { sessionId } });
    if (
      !row ||
      row.refreshToken !== used ||
      !row.refreshLeaseUntil ||
      row.refreshLeaseUntil.getTime() <= Date.now()
    )
      return "stale";
  }
  throw new HubSessionUnavailableError();
}
```

Replace the interim `refresh` from Task 2 with:

```ts
async function refresh(
  sessionId: string,
  grantSession: { refreshToken: string; accessToken: string | null },
  identity: { subject: string; tenant: string },
): Promise<Outcome> {
  const used = grantSession.refreshToken;
  const now = new Date();
  const claimed = await prisma.hubSession.updateMany({
    where: {
      sessionId,
      refreshToken: used,
      OR: [{ refreshLeaseUntil: null }, { refreshLeaseUntil: { lt: now } }],
    },
    data: { refreshLeaseUntil: new Date(now.getTime() + REFRESH_LEASE_MS) },
  });
  if (!claimed.count) return awaitRefresh(sessionId, used);
  let refreshToken: string;
  try {
    refreshToken = await decrypt(used);
  } catch {
    return end(sessionId, used);
  }
  let grant: Awaited<ReturnType<typeof client.refresh>>;
  try {
    grant = await client.refresh(refreshToken);
    if (grant.subject !== identity.subject || grant.tenant !== identity.tenant)
      throw new HubRejectedError("Hub identity changed");
  } catch (error) {
    if (isHubRejection(error)) return end(sessionId, used);
    await release(sessionId, used);
    throw new HubSessionUnavailableError({ cause: error });
  }
  const stored = await prisma.hubSession.updateMany({
    where: { sessionId, refreshToken: used },
    data: {
      refreshToken: await encrypt(grant.refreshToken),
      accessToken: await encrypt(grant.accessToken),
      accessUntil: grant.accessUntil,
      refreshLeaseUntil: null,
    },
  });
  if (!stored.count) {
    // The session ended or changed meanwhile; nothing local holds this grant.
    await client.revoke(grant.refreshToken).catch(() => undefined);
    return "stale";
  }
  if (grantSession.accessToken) {
    const old = await decrypt(grantSession.accessToken).catch(() => undefined);
    if (old) verifyCache.invalidate(verifyCache.hashToken(old));
  }
  return policy.sessionAllowed(identity);
}
```

In `authorizeOnce`, replace `return refresh(sessionId, grantSession, identity);` with:

```ts
    let pending = refreshing.get(sessionId);
    if (!pending) {
      pending = refresh(sessionId, grantSession, identity).finally(() =>
        refreshing.delete(sessionId),
      );
      refreshing.set(sessionId, pending);
    }
    return pending;
```

- [x] **Step 4: Run tests**

Run: `pnpm exec vitest run --maxWorkers=2 packages/auth/src/hub.test.ts packages/auth/src/hub-client.test.ts packages/auth/src/hub-verify-cache.test.ts`
Expected: PASS, including `:555` "rotates encrypted refresh once…" (remove any `it.fails` added in Task 2), `:570-589` refresh denial and identity change, and `:2534` "checks policy again when an expired access token is refreshed".

- [x] **Step 5: Typecheck and commit**

Run: `pnpm --filter @cortexai-agent-hub/auth check`

```bash
git add packages/auth/src/hub-sessions.ts packages/auth/src/hub.test.ts
git commit -m "CAAH-108: Refresh Hub grants once under a lease, never inside a lock

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Background work keeps the session through outages

**Files:**

- Modify: `packages/auth/src/hub-sessions.ts` (`createUserWorkAuthorizer` loop, currently line 162)
- Test: `packages/auth/src/hub.test.ts`

- [x] **Step 1: Write the failing test** (CAAH-108 `describe`)

```ts
it("refuses new work but keeps the session while Hub is down, then resumes", async () => {
  const { f } = await afterWindow();
  f.client.verify.mockRejectedValueOnce(new DOMException("timed out", "TimeoutError"));
  expect(await f.work(userId)).toBe(false);
  expect(f.data.session).toHaveLength(1);
  expect(await f.work(userId)).toBe(true);
});
```

- [x] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run --maxWorkers=2 packages/auth/src/hub.test.ts -t "refuses new work but keeps"`
Expected: FAIL, because `HubSessionUnavailableError` propagates out of `work`.

- [x] **Step 3: Implement**

```ts
    for (const session of sessions) {
      try {
        if (await authorize(session.id, userId)) return true;
      } catch (error) {
        // Hub could not answer: no new work now, and the session is kept for later.
        if (!(error instanceof HubSessionUnavailableError)) throw error;
      }
    }
    return false;
```

- [x] **Step 4: Run tests**

Run: `pnpm exec vitest run --maxWorkers=2 packages/auth/src/hub.test.ts`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add packages/auth/src/hub-sessions.ts packages/auth/src/hub.test.ts
git commit -m "CAAH-108: Keep the session when Hub is down during background work

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: API answers 503, not 401, while Hub cannot confirm a session

**Files:**

- Modify: `apps/api/src/router.ts:922-930` (context type) and `:1059-1063`, `:1082-1085` (the two `if (!actor) throw new ORPCError("UNAUTHORIZED")` middlewares)
- Modify: `apps/api/src/app.ts:85-90` (import), `:760` (monitoring), `:793-845` (`requestSession`, `sessionActor`, `/rpc` context)
- Test: `apps/api/src/router.test.ts`

**Interfaces:**

- Consumes: `isHubSessionUnavailable` (Task 2).
- Produces: router context field `sessionUnavailable?: boolean`.

- [x] **Step 1: Write the failing test** (`router.test.ts`, next to the anonymous `analytics.screen` case near line 99, reusing that test's `deps`)

```ts
it("answers service unavailable, not unauthorized, while Hub cannot confirm the session", async () => {
  const unavailable = createRouterClient(createRouter(deps), {
    context: { actor: null, sessionUnavailable: true } as never,
  });
  await expect(
    unavailable.analytics.screen({ screen: "chat", surface: "web" }),
  ).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE", status: 503 });
  const anonymous = createRouterClient(createRouter(deps), { context: { actor: null } as never });
  await expect(
    anonymous.analytics.screen({ screen: "chat", surface: "web" }),
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
});
```

If the `deps` there are local to that `it`, copy that test's `deps` setup into this one verbatim.

- [x] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run --maxWorkers=2 apps/api/src/router.test.ts -t "service unavailable, not unauthorized"`
Expected: FAIL with code `UNAUTHORIZED`.

- [x] **Step 3: Implement the router**

Context type:

```ts
const os = implement(appContract).$context<{
  actor: Actor | null;
  /** Hub could not confirm the session; it is kept, so answer 503 rather than 401. */
  sessionUnavailable?: boolean;
  /** The signed-in session, so a push token ends with the session that registered it. */
  sessionId?: string;
  signal?: AbortSignal;
  /** Re-runs the request's auth so a long-lived stream notices sign-out and revocation. */
  stillAuthorized?: () => Promise<boolean>;
}>();
```

Module-level helper (near other helpers in `router.ts`):

```ts
/** The request's actor, or 503 while Hub cannot confirm a kept session, else 401. */
function requireActor(context: { actor: Actor | null; sessionUnavailable?: boolean }): Actor {
  if (context.actor) return context.actor;
  throw new ORPCError(context.sessionUnavailable ? "SERVICE_UNAVAILABLE" : "UNAUTHORIZED");
}
```

In both middlewares, replace

```ts
const actor = context.actor;
if (!actor) throw new ORPCError("UNAUTHORIZED");
```

with

```ts
const actor = requireActor(context);
```

- [x] **Step 4: Implement `app.ts`**

Add `isHubSessionUnavailable` to the `@cortexai-agent-hub/auth` import, and `import { HTTPException } from "hono/http-exception";`.

```ts
const requestSession = async (request: Request) => {
  // The bearer plugin turns a signed `Authorization: Bearer` into the session cookie.
  let session: Awaited<ReturnType<typeof auth.api.getSession>>;
  try {
    session = await auth.api.getSession({ headers: request.headers });
  } catch (error) {
    if (isHubSessionUnavailable(error)) return "unavailable" as const;
    throw error;
  }
  if (!session?.user) return null;
  const actor = await actorFromMembership(
    requireMembership(
      prisma,
      session.user.id,
      request.headers.get("x-cortexai-agent-hub-space-id"),
    ),
  );
  return actor && { actor, sessionId: session.session.id };
};
const sessionActor = async (request: Request) => {
  const session = await requestSession(request);
  // Hub could not confirm the session: not a sign-out.
  if (session === "unavailable") throw new HTTPException(503);
  return session?.actor ?? null;
};
```

In the `/rpc/*` middleware:

```ts
const requested = await requestSession(c.req.raw);
const sessionUnavailable = requested === "unavailable";
const session = sessionUnavailable ? null : requested;
const actor = session?.actor ?? null;
```

Then add `sessionUnavailable` to the `rpc.handle` context object. `stillAuthorized` keeps calling `sessionActor`, which now rejects with a 503 during an outage. The stream errors out and the client reconnects with backoff (`thread-subscription.ts` retries 5xx). The stream never answers `UNAUTHORIZED` for an outage.

Monitoring (`:760`): keep attribution best-effort.

```ts
      async (request) =>
        (
          await auth.api.getSession({ headers: request.headers }).catch((error: unknown) => {
            if (isHubSessionUnavailable(error)) return null;
            throw error;
          })
        )?.user.id,
```

- [x] **Step 5: Run tests and typecheck**

Run: `pnpm exec vitest run --maxWorkers=2 apps/api/src/router.test.ts && pnpm --filter @cortexai-agent-hub/api check`
Expected: PASS, no type errors.

- [x] **Step 6: Commit**

```bash
git add apps/api/src/router.ts apps/api/src/router.test.ts apps/api/src/app.ts
git commit -m "CAAH-108: Answer 503 instead of 401 while Hub cannot confirm a session

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Pin client retention and recovery on 503

Clients already behave correctly (diagnosis §6). These are characterization tests that pin the contract this fix relies on. They are expected to pass on first run. If one fails, stop: the diagnosis was wrong and needs revisiting before any client change.

**Files:**

- Test: `apps/web/src/lib/session-gate.test.ts`
- Read only: `apps/mobile/lib/api.test.ts:2046-2053` (already asserts that 503 keeps the mobile token)

- [x] **Step 1: Add the web test**

```ts
it("keeps a signed-in user through a Hub outage and recovers without signing in", () => {
  // get-session answers 503 HUB_UNAVAILABLE while Hub is down (CAAH-108).
  expect(sessionGate({ data: user, isPending: false, error: { status: 503 } })).toBe(
    "authenticated",
  );
  expect(sessionGate({ data: null, isPending: false, error: { status: 503 } })).toBe("unreachable");
  // Hub returns: the same cookie resolves the session again.
  expect(sessionGate({ data: user, isPending: false, error: null })).toBe("authenticated");
});
```

- [x] **Step 2: Run web and mobile retention tests**

Run: `pnpm exec vitest run --maxWorkers=2 apps/web/src/lib/session-gate.test.ts apps/web/src/lib/rpc.test.ts apps/mobile/lib/api.test.ts packages/core/src/thread-subscription.test.ts`
Expected: PASS.

- [x] **Step 3: Commit**

```bash
git add apps/web/src/lib/session-gate.test.ts
git commit -m "CAAH-108: Pin that a signed-in user survives a 503 session check

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Sign-out, tenant isolation, and Postgres-gated tests

**Files:**

- Test: `packages/auth/src/hub.test.ts`, `packages/auth/src/hub.postgres.test.ts`, `packages/auth/src/hub-sessions.test.ts`

- [x] **Step 1: Add unit regressions** (CAAH-108 `describe` in `hub.test.ts`)

```ts
it("still signs out and revokes at Hub while Hub verification is down", async () => {
  const { f, headers } = await afterWindow();
  f.client.verify.mockRejectedValue(new DOMException("timed out", "TimeoutError"));
  await f.auth.api.signOut({ headers }).catch(() => undefined);
  expect(f.data.session).toHaveLength(0);
  expect(f.client.revoke).toHaveBeenCalledWith("refresh-secret-1");
});

it("refuses a session whose stored identity is another tenant without calling Hub or deleting", async () => {
  const f = fixture();
  const { headers } = await f.login();
  f.identities.get(userId).tenant = "test-fake-other-tenant";
  f.client.verify.mockClear();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + 30_001);
  expect(await f.auth.api.getSession({ headers })).toBeNull();
  expect(f.client.verify).not.toHaveBeenCalled();
  expect(f.data.session).toHaveLength(1);
});

it("ends the session when refresh returns another tenant's grant", async () => {
  const f = fixture();
  const { headers } = await f.login();
  expire(f);
  f.client.refresh.mockResolvedValueOnce({
    subject: "subject-1",
    tenant: "test-fake-other-tenant",
    accessToken: "test-fake-access-x",
    refreshToken: "test-fake-refresh-x",
    accessUntil: new Date(Date.now() + 900_000),
  });
  expect(await f.auth.api.getSession({ headers })).toBeNull();
  expect(f.data.session).toHaveLength(0);
});
```

If the sign-out test shows Better Auth's `/sign-out` calls `findSession` and rejects with 503 during an outage, that is a regression against "explicit sign-out unchanged". Fix it by letting `findSession` return the session unauthorized-but-present **only** for `ctx.path === "/sign-out"` (the before-hook `ctx` is in scope where the override is built), and add that branch with this test as its guard.

- [x] **Step 2: Run them**

Run: `pnpm exec vitest run --maxWorkers=2 packages/auth/src/hub.test.ts`
Expected: PASS.

- [x] **Step 3: Update the Postgres-gated tests** (run in CI by `pnpm test:integration`; see `packages/testkit/src/cli/harness.ts:107-121`)

- `hub.postgres.test.ts:568`: `refresh.mockRejectedValue(new Error("invalid_grant"))` → `refresh.mockRejectedValue(new HubRequestError(400, "invalid_grant"))` (import `HubRequestError` from `./hub-client.js`). Rename the test to "refreshes once across separate authorizers and ends the session on invalid_grant", since nothing serializes with a lock any more.
- After that test, add one in the same style:

```ts
it(
  "keeps the session and frees the lease when Hub times out during refresh",
  asAuth(async () => {
    const db = createDb(process.env.DATABASE_URL!);
    const id = `hub-test-${randomUUID()}`;
    const key = "offline-encryption-key-not-a-real-secret";
    const config = { origin: "https://hub.example.test", tenantId: "fixture-tenant" };
    const refresh = vi.fn(async () => ({
      subject: id,
      tenant: config.tenantId,
      accessToken: "test-fake-access-2",
      refreshToken: "test-fake-refresh-2",
      accessUntil: new Date(Date.now() + 900_000),
    }));
    const client = {
      refresh,
      login: refresh,
      lookup: vi.fn(async () => ({ tenant: config.tenantId, idpType: "native" as const })),
      verify: vi.fn(async () => undefined),
      revoke: vi.fn(async () => undefined),
      ssoStart: vi.fn(async () => "https://login.example.test/authorize"),
      ssoExchange: refresh,
      serviceConfig: vi.fn(async () => ({ status: 304 as const })),
    };
    try {
      await db.prisma.user.create({
        data: {
          id,
          name: "Hub test",
          email: `${id}@hub.invalid`,
          hubIdentity: {
            create: { origin: config.origin, tenant: config.tenantId, subject: id },
          },
          sessions: {
            create: {
              id,
              token: randomUUID(),
              expiresAt: new Date(Date.now() + 86_400_000),
              hubSession: {
                create: {
                  refreshToken: await symmetricEncrypt({ key, data: "test-fake-refresh-1" }),
                  accessUntil: new Date(0),
                  accessToken: await symmetricEncrypt({ key, data: "test-fake-access-1" }),
                },
              },
            },
          },
        },
      });
      const api = createHubSessionAuthorizer(db.prisma, config, key, client, {
        policy: admitAll,
      });
      refresh.mockRejectedValueOnce(new DOMException("timed out", "TimeoutError"));
      await expect(api(id, id)).rejects.toBeInstanceOf(HubSessionUnavailableError);
      expect(await db.prisma.session.findUnique({ where: { id } })).not.toBeNull();
      const kept = await db.prisma.hubSession.findUniqueOrThrow({ where: { sessionId: id } });
      expect(kept.refreshLeaseUntil).toBeNull();
      expect(await symmetricDecrypt({ key, data: kept.refreshToken })).toBe("test-fake-refresh-1");
      // Hub returns: the same stored token refreshes.
      expect(await api(id, id)).toBe(true);
      expect(refresh).toHaveBeenLastCalledWith("test-fake-refresh-1");
    } finally {
      await db.prisma.user.deleteMany({ where: { id } });
      await db.prisma.$disconnect();
      await db.pool.end();
    }
  }),
);
```

Import `HubSessionUnavailableError` from `./hub-sessions.js` (extend the existing import) and `HubRequestError` from `./hub-client.js`.

- `hub-sessions.test.ts:167`: `throw new Error("Hub access denied")` → `throw new HubRejectedError("Hub access denied")`.
- `hub-sessions.test.ts:299-362` "expired tokens never serve cached allow": the fetcher `vi.fn()` returns `undefined`, so refresh now throws a `TypeError`, which is unavailable. Change the expectation to `await expect(authorizer(sessionId, userId)).rejects.toBeInstanceOf(HubSessionUnavailableError)`, and assert the session row still exists.

- [x] **Step 4: Typecheck the gated files (they are skipped without a DB)**

Run: `pnpm exec vitest run --maxWorkers=2 packages/auth/src/hub.postgres.test.ts packages/auth/src/hub-sessions.test.ts && pnpm --filter @cortexai-agent-hub/auth check`
Expected: skipped, no type errors.

- [x] **Step 5 (optional): Run the gated tests on a scratch Postgres**

Only if Docker or `pg_ctl` is available. Never reuse an existing local Postgres or its data directory.

```bash
ss -ltn | grep -q ':55492 ' && echo "55492 busy: stop" && exit 1
D=$(mktemp -d /tmp/pgcaah108.XXXX)
initdb -D "$D/data" -U postgres --auth=trust >/dev/null
pg_ctl -D "$D/data" -o "-p 55492 -k $D" -l "$D/log" start
createdb -h 127.0.0.1 -p 55492 -U postgres caah108
DATABASE_URL=postgres://postgres@127.0.0.1:55492/caah108 DATABASE_MIGRATION_URL=postgres://postgres@127.0.0.1:55492/caah108 pnpm db:migrate
VERIFY_DATABASE=1 DATABASE_URL=postgres://postgres@127.0.0.1:55492/caah108 pnpm exec vitest run --maxWorkers=1 packages/auth/src/hub.postgres.test.ts packages/auth/src/hub-sessions.test.ts
pg_ctl -D "$D/data" stop -m fast
rm -rf "$D"
```

Expected: PASS. This runs as a superuser, so RLS is not exercised; CI's harness covers the runtime role. If skipped, say so in the PR. CI's `test:integration` runs them.

- [x] **Step 6: Commit**

```bash
git add packages/auth/src/hub.test.ts packages/auth/src/hub.postgres.test.ts packages/auth/src/hub-sessions.test.ts
git commit -m "CAAH-108: Cover sign-out, tenant isolation and real-database refresh

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Docs and final verification

**Files:**

- Modify: `docs/hub-auth.md:13`, `:203`

- [x] **Step 1: Update the docs**

Line 13: replace "Expired tokens refresh through `/api/tenant-auth/refresh` under a database row lock;" with "Expired tokens refresh through `/api/tenant-auth/refresh` once per grant across processes, under a short lease rather than a row lock held over Hub calls;".

Line 203: replace the sentences from "If the user's own Hub verification or token refresh fails…" to "…tell an outage from a revoked session." with:

> If Hub refuses the user's own verification or refresh (a `401`, `403` or other `4xx` such as `invalid_grant`, or a denied, changed or unentitled identity), the session is deleted and the user must sign in again. If Hub can't be reached (a timeout, a connection failure, a malformed reply, `408`, `429` or `5xx`), the session is kept and requests answer `503` `HUB_UNAVAILABLE` until Hub returns. Clients keep the user signed in and retry.

- [x] **Step 2: Scoped verification (serial)**

Run:

```bash
pnpm exec vitest run --maxWorkers=2 \
  packages/auth/src/hub.test.ts packages/auth/src/hub-client.test.ts \
  packages/auth/src/hub-sessions.test.ts packages/auth/src/hub-verify-cache.test.ts \
  packages/auth/src/hub.postgres.test.ts packages/auth/src/index.test.ts \
  apps/api/src/router.test.ts apps/web/src/lib/session-gate.test.ts apps/web/src/lib/rpc.test.ts \
  apps/mobile/lib/api.test.ts packages/core/src/thread-subscription.test.ts
pnpm --filter @cortexai-agent-hub/auth check
pnpm --filter @cortexai-agent-hub/api check
pnpm --filter @cortexai-agent-hub/db check
pnpm exec biome check packages/auth/src apps/api/src/router.ts apps/api/src/app.ts docs/hub-auth.md packages/db/prisma
```
Expected: all pass. Report any failure verbatim to the coordinator in words, not pasted output.

- [x] **Step 3: Secrets and privacy scan of the diff**

Run: `git diff origin/main --stat && git diff origin/main | grep -nEi "secret|token|@[a-z0-9-]+\.(com|io|net)" | grep -v "test-fake-\|example.test\|hub.invalid\|not-a-real\|refreshToken\|accessToken\|tokenHash\|session_token" || true`
Expected: only fixtures and identifiers. No real keys, emails, hostnames or local paths.

- [x] **Step 4: Commit and leave the branch ready**

```bash
git add docs/hub-auth.md
git commit -m "CAAH-108: Document that Hub outages keep sessions and answer 503

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git status --short --branch
git log --oneline origin/main..HEAD
```
Expected: clean tree, branch ahead of `origin/main`. **Do not push, merge or deploy.** The coordinator opens the draft PR.

PR notes for the coordinator:

- No new user-facing copy (reuses `HUB_SIGN_IN_UNAVAILABLE_MESSAGE`).
- No visible UI change, so no screenshot.
- Remaining manual QA gap: a staging smoke that slows or blocks Hub, checks that a signed-in user stays signed in with 503s, then recovers without signing in.

---

## Self-review

- **Spec coverage:**
  - AC1 transient retention: Tasks 2, 4, 5.
  - AC2 503: Tasks 2 and 6.
  - AC3 delete only on definitive rejection, with CAS: Tasks 1, 2, 4.
  - AC4 no Hub I/O in a transaction: Task 2 (`openTransactions` assertion) and Task 4.
  - AC5 CAS and lease: Tasks 3 and 4.
  - AC6 tests:
    - transient classes: Tasks 2 and 4;
    - definitive invalidation: Tasks 2 and 4;
    - races: Tasks 2 and 4;
    - cache window: Task 2;
    - UI retention and recovery: Tasks 2 and 7;
    - sign-out and tenant isolation: Task 8.
  - AC7 fake credentials: Global Constraints and Task 9 Step 3.
  - AC8 staging gap: Task 9 PR notes.
  - AC9 scope: Global Constraints.
- **Type consistency:**
  - `HubRejectedError`, `isHubRejection` (Task 1) are used in Tasks 2, 4 and 8.
  - `HubSessionUnavailableError` (Task 2) is used in Tasks 5 and 8.
  - `isHubSessionUnavailable` (Task 2) is used in Task 6.
  - `refreshLeaseUntil` (Task 3) is used in Task 4 and in the fixture.
  - `Outcome` is used consistently.
- **Known decision points:**
  - Task 2 Step 4: Better Auth propagation spike, with a fallback.
  - Task 8 Step 1: whether sign-out reads `findSession`, with a fallback.
