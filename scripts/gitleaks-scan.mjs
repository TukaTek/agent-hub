import { spawnSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertGitleaksPolicy } from "./repository-policy.mjs";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const configPath = path.join(root, ".gitleaks.toml");

export async function runGitleaksDirectory(target, options = {}) {
  const resolvedTarget = path.resolve(target);
  const targetInfo = await stat(resolvedTarget).catch(() => undefined);
  if (!targetInfo?.isDirectory()) {
    throw new Error(`Gitleaks scan target must be an existing directory: ${resolvedTarget}`);
  }
  const configInfo = await stat(configPath).catch(() => undefined);
  if (!configInfo?.isFile()) throw new Error(`Gitleaks config is missing: ${configPath}`);
  assertGitleaksPolicy(await readFile(configPath, "utf8"));

  const args = ["dir", `--config=${configPath}`, "--no-banner", "--redact"];
  if (options.exitCode !== undefined) args.push(`--exit-code=${options.exitCode}`);
  args.push(target);
  const result = spawnSync("gitleaks", args, { encoding: "utf8" });
  if (result.error) throw result.error;
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = process.argv[2];
  if (!target) {
    console.error("Usage: node scripts/gitleaks-scan.mjs <existing-directory>");
    process.exitCode = 2;
  } else {
    runGitleaksDirectory(target)
      .then((result) => {
        if (result.stdout) process.stdout.write(result.stdout);
        if (result.stderr) process.stderr.write(result.stderr);
        process.exitCode = result.status ?? 2;
      })
      .catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 2;
      });
  }
}
