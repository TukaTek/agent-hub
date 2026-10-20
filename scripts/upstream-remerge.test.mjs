import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { remerge } from "./upstream-remerge.mjs";

const old = ["ra", "kazo"].join("");
const repos = [];

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function write(cwd, files) {
  for (const [path, text] of Object.entries(files)) writeFileSync(join(cwd, path), text);
}

function commit(cwd, message) {
  git(cwd, "add", "-A");
  git(cwd, "commit", "-q", "-m", message);
}

/** A fork (`main`) and an upstream (`up`) that diverged from one base, mid-merge. */
function forkMidMerge({ base, ours, upstream, oursRemoved = [], upstreamRemoved = [] }) {
  const cwd = mkdtempSync(join(tmpdir(), "remerge-"));
  repos.push(cwd);
  git(cwd, "init", "-q", "-b", "main");
  git(cwd, "config", "user.email", "fixture@example.test");
  git(cwd, "config", "user.name", "Fixture");
  git(cwd, "config", "commit.gpgsign", "false");
  write(cwd, {
    "biome.json": JSON.stringify({ formatter: { indentStyle: "space", lineWidth: 100 } }),
    ...base,
  });
  commit(cwd, "base");
  git(cwd, "checkout", "-q", "-b", "up");
  write(cwd, upstream);
  for (const path of upstreamRemoved) rmSync(join(cwd, path));
  commit(cwd, "upstream");
  git(cwd, "checkout", "-q", "main");
  write(cwd, ours);
  for (const path of oursRemoved) rmSync(join(cwd, path));
  commit(cwd, "ours");
  try {
    git(cwd, "merge", "--no-ff", "--no-commit", "up");
  } catch {
    // Conflicts are the point.
  }
  return cwd;
}

function unmerged(cwd) {
  return git(cwd, "diff", "--name-only", "--diff-filter=U").split("\n").filter(Boolean);
}

afterEach(() => {
  for (const cwd of repos.splice(0)) rmSync(cwd, { recursive: true, force: true });
});

describe("remerge", () => {
  it("resolves a conflict that only differs by branding", () => {
    const cwd = forkMidMerge({
      base: { "a.ts": `import { x } from "@${old}/core";\nexport const a = x;\n` },
      ours: { "a.ts": `import { x } from "@cortexai-agent-hub/core";\nexport const a = x;\n` },
      upstream: { "a.ts": `import { x } from "@${old}/core";\nexport const a = x + 1;\n` },
    });
    expect(unmerged(cwd)).toEqual(["a.ts"]);

    const report = remerge({ cwd, format: false });

    expect(report.resolved).toEqual(["a.ts"]);
    expect(unmerged(cwd)).toEqual([]);
    expect(readFileSync(join(cwd, "a.ts"), "utf8")).toBe(
      'import { x } from "@cortexai-agent-hub/core";\nexport const a = x + 1;\n',
    );
  });

  it("resolves a conflict that only differs by import order once formatted", () => {
    const cwd = forkMidMerge({
      base: { "b.ts": 'import { b, a } from "./x";\nexport const v = [a, b];\n' },
      ours: { "b.ts": 'import { a, b } from "./x";\nexport const v = [a, b];\n' },
      upstream: { "b.ts": 'import { b, a } from "./x";\nexport const v = [a, b, 1];\n' },
    });

    const report = remerge({ cwd });

    expect(report.resolved).toEqual(["b.ts"]);
    expect(readFileSync(join(cwd, "b.ts"), "utf8")).toBe(
      'import { a, b } from "./x";\nexport const v = [a, b, 1];\n',
    );
  });

  it("leaves a real conflict in diff3 form with the upstream side rebranded", () => {
    const cwd = forkMidMerge({
      base: { "c.ts": `export const name = "${old}";\nexport const n = 1;\n` },
      ours: { "c.ts": `export const name = "cortexai-agent-hub";\nexport const n = 2;\n` },
      upstream: { "c.ts": `export const name = "${old}";\nexport const n = 3;\n` },
    });

    const report = remerge({ cwd, format: false });

    expect(report.conflicted).toEqual(["c.ts"]);
    const text = readFileSync(join(cwd, "c.ts"), "utf8");
    expect(text).toContain("<<<<<<< ours");
    expect(text).toContain("||||||| base");
    expect(text).toContain(">>>>>>> upstream");
    expect(text).toContain("export const n = 3;");
    expect(text.toLowerCase()).not.toContain(old);
    expect(unmerged(cwd)).toEqual(["c.ts"]);
  });

  it("keeps a file the fork deleted, even when upstream changed it", () => {
    const cwd = forkMidMerge({
      base: { "gone.ts": "export const a = 1;\n", "keep.ts": "export const k = 1;\n" },
      ours: {},
      oursRemoved: ["gone.ts"],
      upstream: { "gone.ts": "export const a = 2;\n" },
    });

    const report = remerge({ cwd, format: false });

    expect(report.keptDeleted).toEqual(["gone.ts"]);
    expect(existsSync(join(cwd, "gone.ts"))).toBe(false);
    expect(unmerged(cwd)).toEqual([]);
  });

  it("leaves a file upstream deleted but the fork changed for a person to decide", () => {
    const cwd = forkMidMerge({
      base: { "d.ts": "export const d = 1;\n" },
      ours: { "d.ts": "export const d = 2;\n" },
      upstream: {},
      upstreamRemoved: ["d.ts"],
    });

    const report = remerge({ cwd, format: false });

    expect(report.manual).toEqual(["d.ts: deleted upstream, changed in the fork"]);
    expect(unmerged(cwd)).toEqual(["d.ts"]);
  });

  it("takes either side of an add/add conflict that only differs by branding", () => {
    const cwd = forkMidMerge({
      base: { "keep.ts": "export const k = 1;\n" },
      ours: { "new.ts": 'export const label = "cortexai-agent-hub";\n' },
      upstream: { "new.ts": `export const label = "${old}";\n` },
    });

    const report = remerge({ cwd, format: false });

    expect(report.resolved).toEqual(["new.ts"]);
    expect(readFileSync(join(cwd, "new.ts"), "utf8")).toBe(
      'export const label = "cortexai-agent-hub";\n',
    );
  });

  it("rebrands upstream files that merged cleanly and reports the old domain", () => {
    const cwd = forkMidMerge({
      base: { "keep.ts": "export const k = 1;\n" },
      ours: { "keep.ts": "export const k = 2;\n" },
      upstream: {
        "added.ts": `import { x } from "@${old}/core";\nexport const y = x;\n`,
        "mail.md": `Write to security@${old}.com\n`,
      },
    });

    const report = remerge({ cwd, format: false });

    expect(report.rebranded).toEqual(["added.ts"]);
    expect(readFileSync(join(cwd, "added.ts"), "utf8")).toContain("@cortexai-agent-hub/core");
    expect(report.manual).toEqual([`mail.md: resolve by hand: security@${old}.com`]);
    expect(git(cwd, "diff", "--name-only")).toBe("");
  });
});
