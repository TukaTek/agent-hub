import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");

/** Images built on the official Node image (CVE-2026-111497 is fixed in 24.22.1). */
const NODE_IMAGES = [
  "infra/compose/Dockerfile",
  "infra/compose/Dockerfile.topology",
  "infra/railway/Dockerfile",
  "infra/sandboxes/supervisor/Dockerfile",
  "infra/updater/Dockerfile",
];

/** Every image that ships Debian's apt (CVE-2026-109518). */
const APT_IMAGES = [
  ...NODE_IMAGES,
  "infra/sandboxes/computer/Dockerfile",
  "infra/sandboxes/desktop/Dockerfile",
];

/** Each build context keeps its own copy of the helper; they must stay one file. */
const APT_HELPERS = [
  "infra/sandboxes/computer/apt-security.sh",
  "infra/compose/apt-security.sh",
  "infra/sandboxes/desktop/apt-security.sh",
];

describe("image security", () => {
  it.each(NODE_IMAGES)("%s builds on Node 24.22.1 pinned by digest", (file) => {
    const from = read(file).match(/^FROM node:(\S+)/m)?.[1];
    expect(from).toMatch(/^24\.22\.1-bookworm(-slim)?@sha256:[0-9a-f]{64}$/);
  });

  it.each(APT_IMAGES)("%s upgrades apt first and checks it in the last root step", (file) => {
    const dockerfile = read(file);
    const final = dockerfile.slice(dockerfile.lastIndexOf("\nFROM ") + 1);
    const upgrade = final.search(/RUN \/tmp\/apt-security\.sh(?! --check)/);
    expect(upgrade).toBeGreaterThan(-1);
    // Nothing installs packages before the patched apt is in place.
    expect(final.slice(0, upgrade)).not.toMatch(/apt-get install/);
    const check = final.lastIndexOf("/tmp/apt-security.sh --check");
    expect(check).toBeGreaterThan(upgrade);
    // No later step can change the filesystem that ships.
    expect(final.slice(check)).not.toMatch(/^(RUN|COPY|ADD) /m);
  });

  it("keeps one apt helper across the build contexts", () => {
    const [first, ...copies] = APT_HELPERS.map(read);
    for (const copy of copies) expect(copy).toBe(first);
  });

  it("sends the apt helper when the supervisor builds the computer image locally", () => {
    expect(read("infra/sandboxes/supervisor/src/index.ts")).toMatch(/"apt-security\.sh",/);
  });

  it.skipIf(!existsSync("/usr/bin/dpkg"))("passes the apt version gate smoke", () => {
    execFileSync("bash", [path.join(root, "infra/compose/apt-security.smoke.sh")], {
      stdio: "inherit",
    });
  });
});
