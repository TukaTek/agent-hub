import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Fixture drift check (F8). These files are authored in cortexai-hub and mirrored byte
 * for byte. A local edit, or a re-copy without updating the pins and fixtures/README.md,
 * fails CI here. Hub pins the same sha256 values on its side, so drift there fails too.
 */
const HUB_COMMIT = "5348df5354c869245bc43dfb909db23cfe0688fd";
const MIRRORED = [
  {
    file: "hub-agent-hub-service-config.v1.sample.json",
    source: "docs/agent-hub-service-config.v1.sample.json",
    sha256: "6d689c9828be64482f9afaa06da215fa9f2b2a9701e212ca24aed19cc74230a6",
  },
  {
    file: "hub-agent-hub-settings.v1.invalid-values.json",
    source: "docs/agent-hub-settings.v1.invalid-values.json",
    sha256: "e3f8ed44e90b7d7ded55a89682985788ad058b369c707a852ad2fa24af8aa817",
  },
] as const;

const fixtures = new URL("./fixtures/", import.meta.url);
const readme = readFileSync(new URL("README.md", fixtures), "utf8");

describe("mirrored Hub fixtures (cortexai-hub #103)", () => {
  it.each(MIRRORED.map((entry) => [entry.file, entry] as const))(
    "%s matches its pinned sha256",
    (_file, entry) => {
      const bytes = readFileSync(new URL(entry.file, fixtures));
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(entry.sha256);
    },
  );

  it.each(MIRRORED.map((entry) => [entry.file, entry] as const))(
    "%s has its source, commit and sha256 recorded in fixtures/README.md",
    (_file, entry) => {
      const section = readme.split(/^## /m).find((part) => part.startsWith(entry.file));
      expect(section, entry.file).toBeDefined();
      expect(section).toContain(entry.source);
      expect(section).toContain(HUB_COMMIT);
      expect(section).toContain(entry.sha256);
    },
  );
});
