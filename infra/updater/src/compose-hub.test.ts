import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const repoRoot = path.resolve(import.meta.dirname, "../../..");

function loadCompose(rel: string) {
  return parse(readFileSync(path.resolve(repoRoot, rel), "utf8")) as {
    services: Record<string, Record<string, any>>;
    secrets?: Record<string, { file?: string }>;
  };
}

describe("Hub mode Compose overlay (CAAH-36 F1)", () => {
  const overlay = loadCompose("infra/compose/docker-compose.hub.yml");

  it("mounts the Hub service secret from a host file that must be set", () => {
    expect(overlay.secrets?.hub_service_secret?.file).toMatch(
      /^\$\{HUB_SERVICE_SECRET_HOST_FILE:\?[^}]+\}$/,
    );
    expect(overlay.services.api?.secrets).toEqual(["hub_service_secret"]);
    // Fixed, so a host path left in .env never reaches the container.
    expect(overlay.services.api?.environment?.HUB_SERVICE_SECRET_FILE).toBe(
      "/run/secrets/hub_service_secret",
    );
  });

  it("gives the secret to the API only; the worker never contacts Hub", () => {
    expect(Object.keys(overlay.services)).toEqual(["api"]);
  });

  it("layers onto both the image and production stacks without replacing the image", () => {
    for (const base of [
      "infra/compose/docker-compose.images.yml",
      "infra/compose/docker-compose.prod.yml",
    ]) {
      expect(loadCompose(base).services.api, base).toBeDefined();
    }
    expect(overlay.services.api).not.toHaveProperty("image");
    expect(overlay.services.api).not.toHaveProperty("build");
  });
});
