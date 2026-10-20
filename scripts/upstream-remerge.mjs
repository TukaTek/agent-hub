#!/usr/bin/env node
// Run inside `git merge --no-commit upstream/main`. Resolves every conflict that only exists
// because of our rebrand or Biome formatting, keeps files the fork deleted, rebrands upstream
// files that merged cleanly, and leaves the rest in diff3 form for a person.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rebrand } from "./upstream-rebrand.mjs";

const old = ["ra", "kazo"].join("");
const KEEP = new Set(["LICENSE", "NOTICE"]);
const BIOME = fileURLToPath(new URL("../node_modules/.bin/biome", import.meta.url));
const FORMATTED = /\.(c|m)?[jt]sx?$|\.json$|\.css$/;

function git(cwd, args, input) {
  return execFileSync("git", args, {
    cwd,
    input,
    encoding: "buffer",
    maxBuffer: 1 << 30,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function isBinary(buffer) {
  return buffer.subarray(0, 8000).includes(0);
}

/** Stage number to blob for every unmerged path. */
function unmergedStages(cwd) {
  const stages = new Map();
  const out = git(cwd, ["ls-files", "-u", "-z"]).toString("utf8");
  for (const entry of out.split("\0").filter(Boolean)) {
    const [meta, path] = entry.split("\t");
    const [, blob, stage] = meta.split(" ");
    if (!stages.has(path)) stages.set(path, {});
    stages.get(path)[stage] = blob;
  }
  return stages;
}

/** Formats each side in its own scratch tree so Biome sees the repo's config and real paths. */
function formatSides(cwd, sides) {
  const config = join(cwd, "biome.json");
  if (!existsSync(config) || !existsSync(BIOME)) return;
  for (const side of Object.keys(sides[0]?.texts ?? {})) {
    const root = mkdtempSync(join(tmpdir(), `remerge-${side}-`));
    try {
      writeFileSync(join(root, "biome.json"), readFileSync(config));
      const written = [];
      for (const file of sides) {
        if (!FORMATTED.test(file.path) || file.texts[side] === undefined) continue;
        const target = join(root, file.path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, file.texts[side]);
        written.push(file);
      }
      if (written.length === 0) continue;
      spawnSync(
        BIOME,
        [
          "check",
          "--write",
          "--linter-enabled=false",
          "--vcs-enabled=false",
          "--files-ignore-unknown=true",
          "--no-errors-on-unmatched",
          ".",
        ],
        { cwd: root, stdio: "ignore" },
      );
      for (const file of written) file.texts[side] = readFileSync(join(root, file.path), "utf8");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
}

function mergeFile(ours, base, theirs) {
  const root = mkdtempSync(join(tmpdir(), "remerge-file-"));
  try {
    const paths = {
      ours: join(root, "ours"),
      base: join(root, "base"),
      theirs: join(root, "theirs"),
    };
    writeFileSync(paths.ours, ours);
    writeFileSync(paths.base, base);
    writeFileSync(paths.theirs, theirs);
    const result = spawnSync(
      "git",
      [
        "merge-file",
        "-p",
        "--diff3",
        "-L",
        "ours",
        "-L",
        "base",
        "-L",
        "upstream",
        paths.ours,
        paths.base,
        paths.theirs,
      ],
      { encoding: "utf8", maxBuffer: 1 << 30 },
    );
    if (result.status < 0 || result.status === null) throw new Error(result.stderr);
    return { text: result.stdout, clean: result.status === 0 };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function noteUnresolved(report, path, text) {
  for (const value of rebrand(text).unresolved)
    report.manual.push(`${path}: resolve by hand: ${value}`);
}

export function remerge({ cwd = process.cwd(), format = true } = {}) {
  const report = { resolved: [], conflicted: [], keptDeleted: [], rebranded: [], manual: [] };
  const content = [];
  const conflicted = new Set();

  for (const [path, stage] of unmergedStages(cwd)) {
    conflicted.add(path);
    if (!stage[2]) {
      git(cwd, ["rm", "-q", "--cached", "--", path]);
      rmSync(join(cwd, path), { force: true });
      report.keptDeleted.push(path);
      continue;
    }
    if (!stage[3]) {
      report.manual.push(`${path}: deleted upstream, changed in the fork`);
      continue;
    }
    const blobs = [stage[1], stage[2], stage[3]].map(
      (blob) => blob && git(cwd, ["cat-file", "blob", blob]),
    );
    if (blobs.some((blob) => blob && isBinary(blob))) {
      report.manual.push(`${path}: binary conflict`);
      continue;
    }
    const [base, ours, theirs] = blobs.map((blob) => blob?.toString("utf8"));
    noteUnresolved(report, path, theirs);
    content.push({
      path,
      texts: {
        base: base === undefined ? undefined : rebrand(base).text,
        ours,
        theirs: rebrand(theirs).text,
      },
    });
  }

  if (format) formatSides(cwd, content);

  for (const file of content) {
    const { base, ours, theirs } = file.texts;
    const merged =
      base === undefined
        ? ours === theirs
          ? { text: ours, clean: true }
          : mergeFile(ours, "", theirs)
        : mergeFile(ours, base, theirs);
    writeFileSync(join(cwd, file.path), merged.text);
    if (merged.clean) {
      git(cwd, ["add", "--", file.path]);
      report.resolved.push(file.path);
    } else {
      report.conflicted.push(file.path);
    }
  }

  const changed = git(cwd, ["diff", "--cached", "--name-only", "-z", "--diff-filter=AMR", "HEAD"])
    .toString("utf8")
    .split("\0")
    .filter((path) => path && !conflicted.has(path) && !KEEP.has(path));
  for (const path of changed) {
    if (path.toLowerCase().includes(old)) report.manual.push(`${path}: rename the path`);
    const file = join(cwd, path);
    if (!existsSync(file)) continue;
    const buffer = readFileSync(file);
    if (isBinary(buffer)) continue;
    const source = buffer.toString("utf8");
    noteUnresolved(report, path, source);
    const { text } = rebrand(source);
    if (text === source) continue;
    writeFileSync(file, text);
    git(cwd, ["add", "--", path]);
    report.rebranded.push(path);
  }

  for (const key of Object.keys(report)) report[key].sort();
  return report;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const report = remerge({ format: !process.argv.includes("--no-format") });
  console.log(
    `resolved ${report.resolved.length}, still conflicted ${report.conflicted.length}, ` +
      `kept deleted ${report.keptDeleted.length}, rebranded ${report.rebranded.length}`,
  );
  for (const path of report.conflicted) console.log(`conflict: ${path}`);
  for (const path of report.keptDeleted) console.log(`kept deleted: ${path}`);
  for (const note of report.manual) console.log(`manual: ${note}`);
}
