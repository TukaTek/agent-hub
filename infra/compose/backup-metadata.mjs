#!/usr/bin/env node

import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const LOCAL_DEPLOYMENT_ID = "00000000-0000-0000-0000-000000000000";
const CANONICAL_DEPLOYMENT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FULL_GIT_REVISION = /^[0-9a-f]{40}$/;
const SUPPORTED_PROVIDERS = new Set(["e2b", "daytona", "box"]);
const PLACEHOLDER_SECRET =
  /(change[-_ ]?me|replace[-_ ]?with|placeholder|example|test[-_ ]?only|default[-_ ]?secret)/i;
const BACKUP_TARGET_CLASSES = {
  "s3:": "s3",
  "gs:": "gcs",
  "azure:": "azure-object-storage",
};

export function createBackupMetadata(env, createdAt = new Date().toISOString()) {
  const deploymentId = resolveDeploymentId(env);
  const backupTargetClass = targetClass(env.CORTEXAI_BACKUP_TARGET);
  const revision = optional(env.GIT_SHA) ?? optional(env.RAKAZO_GIT_SHA);
  const imageTag = optional(env.RAKAZO_IMAGE_TAG);
  const providerKind = optional(env.SANDBOX_PROVIDER);
  const backupEncryptionKey = env.CORTEXAI_BACKUP_ENCRYPTION_KEY;
  if (
    env.NODE_ENV === "production" &&
    (!backupTargetClass ||
      !revision ||
      !FULL_GIT_REVISION.test(revision) ||
      imageTag !== `sha-${revision}` ||
      !providerKind ||
      !SUPPORTED_PROVIDERS.has(providerKind) ||
      !backupEncryptionKey ||
      backupEncryptionKey.length < 32 ||
      PLACEHOLDER_SECRET.test(backupEncryptionKey))
  ) {
    throw new Error("Production backup metadata requires safe deployment inputs.");
  }
  return {
    schemaVersion: 1,
    deploymentId,
    createdAt,
    revision: revision ?? null,
    imageTag: imageTag ?? null,
    providerKind: providerKind ?? "none",
    backupTargetClass: backupTargetClass ?? "local-development",
  };
}

export function writeBackupMetadata(target, env, createdAt) {
  const metadata = createBackupMetadata(env, createdAt);
  writeFileSync(target, `${JSON.stringify(metadata, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  chmodSync(target, 0o600);
}

export function verifyBackupDeployment(metadata, env) {
  if (
    metadata?.schemaVersion !== 1 ||
    typeof metadata.deploymentId !== "string" ||
    typeof metadata.createdAt !== "string"
  ) {
    throw new Error("Backup deployment metadata is missing or malformed.");
  }
  const currentDeploymentId = resolveDeploymentId(env);
  if (metadata.deploymentId !== currentDeploymentId) {
    throw new Error(
      "Backup belongs to a different deployment identity; cross-tenant restore is not allowed.",
    );
  }
}

export function readEnvFile(file) {
  const parsed = {};
  for (const rawLine of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) continue;
    const [, name, rawValue] = match;
    let value = rawValue ?? "";
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    parsed[name] = value;
  }
  return parsed;
}

function resolveDeploymentId(env) {
  const value = env.CORTEXAI_DEPLOYMENT_ID;
  if (!value && env.NODE_ENV !== "production") return LOCAL_DEPLOYMENT_ID;
  if (
    !value ||
    value !== value.trim() ||
    !CANONICAL_DEPLOYMENT_ID.test(value) ||
    value.startsWith("00000000-0000-")
  ) {
    throw new Error("CORTEXAI_DEPLOYMENT_ID is missing or malformed.");
  }
  return value;
}

function targetClass(value) {
  if (!value || value !== value.trim()) return undefined;
  try {
    const target = new URL(value);
    if (!target.hostname || target.username || target.password) return undefined;
    return BACKUP_TARGET_CLASSES[target.protocol];
  } catch {
    return undefined;
  }
}

function optional(value) {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

async function main() {
  const [mode, metadataPath, envFile] = process.argv.slice(2);
  if (!mode || !metadataPath) {
    throw new Error("usage: backup-metadata.mjs <write|verify> <metadata-path> [env-file]");
  }
  const fileEnv = envFile ? readEnvFile(envFile) : {};
  const env = { ...fileEnv, ...process.env };
  if (mode === "write") {
    writeBackupMetadata(metadataPath, env);
    console.log("Backup deployment metadata written.");
    return;
  }
  if (mode === "verify") {
    let metadata;
    try {
      metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
    } catch {
      throw new Error("Backup deployment metadata is missing or malformed.");
    }
    verifyBackupDeployment(metadata, env);
    console.log("Backup deployment identity matches.");
    return;
  }
  throw new Error("Unsupported backup metadata operation.");
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Backup metadata operation failed.");
    process.exitCode = 1;
  });
}
