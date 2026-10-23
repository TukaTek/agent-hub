import { logSinkHealth } from "@cortexai-agent-hub/logging";
import { Hono } from "hono";

/**
 * `/health` is public liveness, so it stays a constant body. Deployment details are for
 * operators on the API port; a reverse proxy adds forwarding headers, so a request that
 * carries them came through the public edge and gets no details.
 */
export function healthRoutes(
  details: () => Record<string, unknown> | Promise<Record<string, unknown>>,
  database?: () => Promise<unknown>,
) {
  const app = new Hono();
  // One probe at a time: polls during a hung check wait on it instead of taking more connections.
  let inFlight: Promise<boolean> | null = null;
  const probe = (check: () => Promise<unknown>) => {
    inFlight ??= Promise.resolve()
      .then(check)
      .then(
        () => true,
        () => false,
      )
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };
  app.get("/ready", async (c) => {
    const degraded = (await details()).degraded === true;
    const databaseUp = database ? await withinDeadline(probe(database)) : true;
    const ok = !degraded && databaseUp;
    return c.json(
      { ok, degraded, ...(databaseUp ? {} : { database: "unreachable" }) },
      ok ? 200 : 503,
    );
  });
  app.get("/health", (c) => c.json({ ok: true }));
  app.get("/internal/health", async (c) => {
    if (c.req.header("x-forwarded-for") || c.req.header("forwarded")) return c.notFound();
    return c.json({ ok: true, ...(await details()), telemetry: logSinkHealth() });
  });
  return app;
}

/**
 * Hub policy's part of `/internal/health`. Anything but an ok or deliberately disabled
 * policy is `degraded`, including Hub mode started without its tenant or service
 * credential. Liveness (`/health`) stays up so the process keeps serving its fail-closed
 * refusals.
 */
export function hubPolicyHealth<T extends { state: string }>(
  status: T | null,
): { status: "ok" | "degraded"; hubPolicy: T | null } {
  const ok = !status || status.state === "ok" || status.state === "disabled";
  return { status: ok ? "ok" : "degraded", hubPolicy: status };
}

export const DATABASE_CHECK_TIMEOUT_MS = 1500;

/** Readiness callers poll with short timeouts, so a hung database counts as unreachable. */
async function withinDeadline(check: Promise<boolean>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), DATABASE_CHECK_TIMEOUT_MS);
  });
  try {
    return await Promise.race([check, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
