import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createHealthPayload, mountHealthRoute } from "./health.js";

describe("createHealthPayload", () => {
  it("projects immutable deployment identity and exact source revision", () => {
    expect(
      createHealthPayload({
        deploymentId: "0198f2ce-7d11-7a41-8b5c-7d1dfd62c551",
        revision: "22d7eb598c3cc72c047025df6d7a72d3612067a9",
        runtime: "pi",
        sandbox: "e2b",
        composio: false,
        pipedream: false,
        jobs: "graphile",
        realtime: "postgres",
      }),
    ).toEqual({
      ok: true,
      deploymentId: "0198f2ce-7d11-7a41-8b5c-7d1dfd62c551",
      revision: "22d7eb598c3cc72c047025df6d7a72d3612067a9",
      runtime: "pi",
      sandbox: "e2b",
      composio: false,
      pipedream: false,
      jobs: "graphile",
      realtime: "postgres",
    });
  });

  it("does not accept or project secret-bearing fields", () => {
    const payload = createHealthPayload({
      deploymentId: "0198f2ce-7d11-7a41-8b5c-7d1dfd62c551",
      revision: null,
      runtime: "scripted",
      sandbox: "fake",
      composio: false,
      pipedream: false,
      jobs: "memory",
      realtime: "memory",
    });

    expect(Object.keys(payload)).not.toContain("secrets");
    expect(Object.keys(payload)).not.toContain("environment");
  });

  it("serves deployment identity and revision from GET /health", async () => {
    const app = new Hono();
    mountHealthRoute(app, {
      deploymentId: "0198f2ce-7d11-7a41-8b5c-7d1dfd62c551",
      revision: "22d7eb598c3cc72c047025df6d7a72d3612067a9",
      runtime: "pi",
      sandbox: "e2b",
      composio: false,
      pipedream: false,
      jobs: "graphile",
      realtime: "postgres",
    });

    const response = await app.request("/health");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      deploymentId: "0198f2ce-7d11-7a41-8b5c-7d1dfd62c551",
      revision: "22d7eb598c3cc72c047025df6d7a72d3612067a9",
    });
  });
});
