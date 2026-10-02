import { Hono } from "hono";

/**
 * `/health` is public liveness, so it stays a constant body. Deployment details are for
 * operators on the API port; a reverse proxy adds forwarding headers, so a request that
 * carries them came through the public edge and gets no details.
 */
export function healthRoutes(
  details: () => Record<string, unknown> | Promise<Record<string, unknown>>,
) {
  const app = new Hono();
  app.get("/health", (c) => c.json({ ok: true }));
  app.get("/internal/health", async (c) => {
    if (c.req.header("x-forwarded-for") || c.req.header("forwarded")) return c.notFound();
    return c.json({ ok: true, ...(await details()) });
  });
  return app;
}

/**
 * Hub policy's part of `/internal/health`. Anything but an ok policy is `degraded`,
 * including Hub mode started without its tenant or service credential. Liveness
 * (`/health`) stays up so the process keeps serving its fail-closed refusals.
 */
export function hubPolicyHealth<T extends { state: string }>(
  status: T | null,
): { status: "ok" | "degraded"; hubPolicy: T | null } {
  return { status: !status || status.state === "ok" ? "ok" : "degraded", hubPolicy: status };
}
