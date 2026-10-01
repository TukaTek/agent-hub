import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { noSniff } from "./security-headers.js";

const app = new Hono()
  .use("*", noSniff)
  .post("/rpc/artifacts/get", (c) => c.json({ contentBase64: "UEs=" }))
  .get("/api/auth/capabilities", (c) => c.json({}))
  .get("/missing", (c) => c.notFound());

describe("API security headers", () => {
  it.each([
    ["POST", "/rpc/artifacts/get"],
    ["GET", "/api/auth/capabilities"],
    ["GET", "/missing"],
  ])("forbids MIME sniffing on %s %s", async (method, path) => {
    const response = await app.request(path, { method });
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });
});
