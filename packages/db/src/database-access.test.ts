import { describe, expect, it } from "vitest";
import { databaseUrls, rowSecurityWarning } from "./database-access.js";

const owner = "postgres://cortexai-agent-hub:owner-password@postgres:5432/cortexai-agent-hub";
const runtime = "postgres://cortexai_agent_hub_app:app-password@postgres:5432/cortexai-agent-hub";

describe("databaseUrls", () => {
  it("migrates as the owner and runs the app as the runtime login", () => {
    expect(databaseUrls({ DATABASE_URL: runtime, DATABASE_MIGRATION_URL: owner })).toEqual({
      url: runtime,
      migrationUrl: owner,
      separate: true,
    });
  });

  it("falls back to one shared login when only DATABASE_URL is set", () => {
    expect(databaseUrls({ DATABASE_URL: owner })).toEqual({
      url: owner,
      migrationUrl: owner,
      separate: false,
    });
    expect(databaseUrls({ DATABASE_URL: owner, DATABASE_MIGRATION_URL: " " }).separate).toBe(false);
  });

  it("treats two URLs for the same login as shared", () => {
    const sameLogin =
      "postgres://cortexai-agent-hub:owner-password@127.0.0.1:5433/cortexai-agent-hub";
    expect(databaseUrls({ DATABASE_URL: sameLogin, DATABASE_MIGRATION_URL: owner }).separate).toBe(
      false,
    );
  });

  it("requires DATABASE_URL", () => {
    expect(() => databaseUrls({ DATABASE_MIGRATION_URL: owner })).toThrow("DATABASE_URL");
  });
});

describe("rowSecurityWarning", () => {
  it("is silent when the policies apply", () => {
    expect(rowSecurityWarning({ enforced: true, role: "cortexai_agent_hub_app" })).toBeUndefined();
  });

  it("names the login and why it bypasses the policies", () => {
    expect(
      rowSecurityWarning({ enforced: false, role: "cortexai-agent-hub", reason: "is a superuser" }),
    ).toContain("connects as cortexai-agent-hub, which is a superuser");
  });
});
