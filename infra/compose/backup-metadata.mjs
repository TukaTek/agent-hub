#!/usr/bin/env node

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  createReadStream,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const LOCAL_DEPLOYMENT_ID = "00000000-0000-0000-0000-000000000000";
const LOCAL_INTEGRITY_KEY = "rakazo-local-backup-integrity-key-v1";
const MANIFEST_NAME = "deployment.json";
const CANONICAL_DEPLOYMENT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FULL_GIT_REVISION = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const SUPPORTED_PROVIDERS = new Set(["e2b", "daytona", "box"]);
const PLACEHOLDER_SECRET =
  /(change[-_ ]?me|replace[-_ ]?with|placeholder|example|test[-_ ]?only|default[-_ ]?secret)/i;
const BACKUP_TARGET_CLASSES = {
  "s3:": "s3",
  "gs:": "gcs",
  "azure:": "azure-object-storage",
};
const BACKUP_LAYOUTS = {
  "production-compose-v1": [
    { name: "rakazo.dump", type: "application/vnd.postgresql.custom-dump" },
    { name: "appdata.tgz", type: "application/gzip" },
  ],
  "local-compose-v1": [
    { name: "rakazo.sql", type: "application/sql" },
    { name: "homes.tgz", type: "application/gzip" },
  ],
};

export function writeBackupManifest(snapshotDirectory, env, createdAt = new Date().toISOString()) {
  assertPrivateSnapshotDirectory(snapshotDirectory);
  const entries = directoryEntries(snapshotDirectory);
  const layout = detectLayout(entries);
  const artifacts = BACKUP_LAYOUTS[layout].map((expected) =>
    describeArtifact(snapshotDirectory, expected),
  );
  const context = resolveBackupContext(env);
  const unsigned = {
    schemaVersion: 2,
    layout,
    deploymentId: context.deploymentId,
    createdAt,
    revision: context.revision,
    imageTag: context.imageTag,
    providerKind: context.providerKind,
    backupTargetClass: context.backupTargetClass,
    encryption: {
      transportRequired: env.NODE_ENV === "production",
      keyFingerprintSha256: sha256(context.integrityKey),
    },
    artifacts,
  };
  const manifest = {
    ...unsigned,
    integrity: {
      algorithm: "hmac-sha256",
      manifestHmacSha256: hmacSha256(context.integrityKey, canonicalManifest(unsigned)),
    },
  };
  const manifestPath = path.join(snapshotDirectory, MANIFEST_NAME);
  let descriptor;
  try {
    descriptor = openSync(
      manifestPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(descriptor, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  } catch {
    throw new Error("Backup manifest could not be created safely.");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  chmodSync(manifestPath, 0o600);
  verifyBackupSnapshot(snapshotDirectory, env, layout);
  return manifest;
}

export function verifyBackupSnapshot(snapshotDirectory, env, expectedLayout) {
  assertPrivateSnapshotDirectory(snapshotDirectory);
  const manifest = readManifest(snapshotDirectory);
  validateManifestShape(manifest);
  if (expectedLayout && manifest.layout !== expectedLayout) {
    throw new Error("Backup artifact layout is incompatible with this restore path.");
  }

  const currentDeploymentId = resolveDeploymentId(env);
  if (manifest.deploymentId !== currentDeploymentId) {
    throw new Error(
      "Backup belongs to a different deployment identity; cross-tenant restore is not allowed.",
    );
  }
  const integrityKey = resolveIntegrityKey(env);
  if (!secureHexEqual(manifest.encryption.keyFingerprintSha256, sha256(integrityKey))) {
    throw new Error("Backup encryption identity does not match this deployment.");
  }
  const unsigned = unsignedManifest(manifest);
  const expectedHmac = hmacSha256(integrityKey, canonicalManifest(unsigned));
  if (!secureHexEqual(manifest.integrity.manifestHmacSha256, expectedHmac)) {
    throw new Error("Backup manifest integrity verification failed.");
  }

  const expectedArtifacts = BACKUP_LAYOUTS[manifest.layout];
  assertExactEntries(snapshotDirectory, [
    ...expectedArtifacts.map(({ name }) => name),
    MANIFEST_NAME,
  ]);
  for (let index = 0; index < expectedArtifacts.length; index += 1) {
    const actual = describeArtifact(snapshotDirectory, expectedArtifacts[index]);
    const recorded = manifest.artifacts[index];
    if (actual.sizeBytes !== recorded.sizeBytes || actual.sha256 !== recorded.sha256) {
      throw new Error("Backup artifact size or digest does not match the manifest.");
    }
  }
  return manifest;
}

export function readVerifiedBackupArtifact(snapshotDirectory, artifactName, env, expectedLayout) {
  const opened = openVerifiedBackupArtifact(snapshotDirectory, artifactName, env, expectedLayout);
  try {
    return readFileSync(opened.descriptor);
  } finally {
    closeSync(opened.descriptor);
  }
}

export async function emitVerifiedBackupArtifact(
  snapshotDirectory,
  artifactName,
  env,
  expectedLayout,
  destination,
) {
  const opened = openVerifiedBackupArtifact(snapshotDirectory, artifactName, env, expectedLayout);
  const source = createReadStream(opened.path, {
    fd: opened.descriptor,
    autoClose: true,
    start: 0,
  });
  await pipeline(source, destination);
}

function openVerifiedBackupArtifact(snapshotDirectory, artifactName, env, expectedLayout) {
  const manifest = verifyBackupSnapshot(snapshotDirectory, env, expectedLayout);
  const artifact = manifest.artifacts.find(({ name }) => name === artifactName);
  if (!artifact) throw new Error("Backup artifact name is not part of this snapshot.");
  const expected = BACKUP_LAYOUTS[manifest.layout].find(({ name }) => name === artifactName);
  if (!expected) throw new Error("Backup artifact name is not supported.");
  const artifactPath = path.join(snapshotDirectory, artifactName);
  const opened = openPrivateRegularFile(artifactPath, "Backup artifact");
  try {
    if (
      opened.stats.size !== artifact.sizeBytes ||
      sha256Descriptor(opened.descriptor, opened.stats, "Backup artifact") !== artifact.sha256
    ) {
      throw new Error("Backup artifact size or digest changed before consumption.");
    }
    return { ...opened, path: artifactPath };
  } catch (error) {
    closeSync(opened.descriptor);
    throw error;
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

function resolveBackupContext(env) {
  const deploymentId = resolveDeploymentId(env);
  const backupTargetClass = targetClass(env.CORTEXAI_BACKUP_TARGET);
  const revision = optional(env.GIT_SHA) ?? optional(env.RAKAZO_GIT_SHA);
  const imageTag = optional(env.RAKAZO_IMAGE_TAG);
  const providerKind = optional(env.SANDBOX_PROVIDER);
  const integrityKey = resolveIntegrityKey(env);
  if (
    env.NODE_ENV === "production" &&
    (!backupTargetClass ||
      !revision ||
      !FULL_GIT_REVISION.test(revision) ||
      imageTag !== `sha-${revision}` ||
      !providerKind ||
      !SUPPORTED_PROVIDERS.has(providerKind))
  ) {
    throw new Error("Production backup manifest requires safe deployment inputs.");
  }
  return {
    deploymentId,
    revision: revision ?? null,
    imageTag: imageTag ?? null,
    providerKind: providerKind ?? "none",
    backupTargetClass: backupTargetClass ?? "local-development",
    integrityKey,
  };
}

function resolveIntegrityKey(env) {
  const value = env.CORTEXAI_BACKUP_ENCRYPTION_KEY;
  if (env.NODE_ENV !== "production" && !value) return LOCAL_INTEGRITY_KEY;
  if (!value || value !== value.trim() || value.length < 32 || PLACEHOLDER_SECRET.test(value)) {
    throw new Error("Backup encryption identity is missing or unsafe.");
  }
  return value;
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

function readManifest(snapshotDirectory) {
  let parsed;
  try {
    const { bytes } = readPrivateRegularFile(
      path.join(snapshotDirectory, MANIFEST_NAME),
      "Backup manifest",
    );
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    if (error instanceof Error && /permission|symbolic link|regular file/i.test(error.message)) {
      throw error;
    }
    throw new Error("Backup manifest is missing or malformed.");
  }
  return parsed;
}

function validateManifestShape(manifest) {
  const topLevelKeys = [
    "artifacts",
    "backupTargetClass",
    "createdAt",
    "deploymentId",
    "encryption",
    "imageTag",
    "integrity",
    "layout",
    "providerKind",
    "revision",
    "schemaVersion",
  ];
  if (
    !isRecord(manifest) ||
    !hasExactKeys(manifest, topLevelKeys) ||
    manifest.schemaVersion !== 2 ||
    !Object.hasOwn(BACKUP_LAYOUTS, manifest.layout) ||
    typeof manifest.deploymentId !== "string" ||
    typeof manifest.createdAt !== "string" ||
    Number.isNaN(Date.parse(manifest.createdAt)) ||
    (manifest.revision !== null && !FULL_GIT_REVISION.test(manifest.revision)) ||
    (manifest.imageTag !== null && manifest.imageTag !== `sha-${manifest.revision}`) ||
    typeof manifest.providerKind !== "string" ||
    typeof manifest.backupTargetClass !== "string" ||
    !isRecord(manifest.encryption) ||
    !hasExactKeys(manifest.encryption, ["keyFingerprintSha256", "transportRequired"]) ||
    typeof manifest.encryption.transportRequired !== "boolean" ||
    !SHA256.test(manifest.encryption.keyFingerprintSha256) ||
    !isRecord(manifest.integrity) ||
    !hasExactKeys(manifest.integrity, ["algorithm", "manifestHmacSha256"]) ||
    manifest.integrity.algorithm !== "hmac-sha256" ||
    !SHA256.test(manifest.integrity.manifestHmacSha256) ||
    !Array.isArray(manifest.artifacts)
  ) {
    throw new Error("Backup manifest is missing or malformed.");
  }
  const expectedArtifacts = BACKUP_LAYOUTS[manifest.layout];
  if (manifest.artifacts.length !== expectedArtifacts.length) {
    throw new Error("Backup manifest artifact set is invalid.");
  }
  for (let index = 0; index < expectedArtifacts.length; index += 1) {
    const artifact = manifest.artifacts[index];
    const expected = expectedArtifacts[index];
    if (
      !isRecord(artifact) ||
      !hasExactKeys(artifact, ["name", "sha256", "sizeBytes", "type"]) ||
      artifact.name !== expected.name ||
      artifact.type !== expected.type ||
      !Number.isSafeInteger(artifact.sizeBytes) ||
      artifact.sizeBytes <= 0 ||
      !SHA256.test(artifact.sha256)
    ) {
      throw new Error("Backup manifest artifact metadata is invalid.");
    }
  }
}

function unsignedManifest(manifest) {
  return {
    schemaVersion: manifest.schemaVersion,
    layout: manifest.layout,
    deploymentId: manifest.deploymentId,
    createdAt: manifest.createdAt,
    revision: manifest.revision,
    imageTag: manifest.imageTag,
    providerKind: manifest.providerKind,
    backupTargetClass: manifest.backupTargetClass,
    encryption: manifest.encryption,
    artifacts: manifest.artifacts,
  };
}

function canonicalManifest(manifest) {
  return JSON.stringify(manifest);
}

function detectLayout(entries) {
  for (const [layout, artifacts] of Object.entries(BACKUP_LAYOUTS)) {
    const expected = artifacts.map(({ name }) => name).sort();
    if (sameStrings(entries, expected)) return layout;
  }
  throw new Error("Backup artifact set does not match a supported snapshot layout.");
}

function describeArtifact(snapshotDirectory, expected) {
  const opened = openPrivateRegularFile(
    path.join(snapshotDirectory, expected.name),
    "Backup artifact",
  );
  try {
    if (opened.stats.size <= 0) throw new Error("Backup artifact is empty.");
    return {
      name: expected.name,
      type: expected.type,
      sizeBytes: opened.stats.size,
      sha256: sha256Descriptor(opened.descriptor, opened.stats, "Backup artifact"),
    };
  } finally {
    closeSync(opened.descriptor);
  }
}

function readPrivateRegularFile(file, label) {
  const opened = openPrivateRegularFile(file, label);
  try {
    return { bytes: readFileSync(opened.descriptor), stats: opened.stats };
  } finally {
    closeSync(opened.descriptor);
  }
}

function openPrivateRegularFile(file, label) {
  let descriptor;
  try {
    const linkStats = lstatSync(file);
    if (linkStats.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link.`);
    descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stats = fstatSync(descriptor);
    if (!stats.isFile()) throw new Error(`${label} must be a regular file.`);
    if ((stats.mode & 0o077) !== 0) throw new Error(`${label} permissions must be private.`);
    if (stats.nlink !== 1) throw new Error(`${label} must not have multiple filesystem links.`);
    return { descriptor, stats };
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    if (
      error instanceof Error &&
      /symbolic link|regular file|permission|filesystem links/i.test(error.message)
    ) {
      throw error;
    }
    throw new Error(`${label} is missing or unsafe.`);
  }
}

function sha256Descriptor(descriptor, initialStats, label) {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let position = 0;
  while (position < initialStats.size) {
    const bytesRead = readSync(
      descriptor,
      buffer,
      0,
      Math.min(buffer.length, initialStats.size - position),
      position,
    );
    if (bytesRead === 0) throw new Error(`${label} changed while it was being verified.`);
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  const finalStats = fstatSync(descriptor);
  if (
    finalStats.size !== initialStats.size ||
    finalStats.mtimeMs !== initialStats.mtimeMs ||
    finalStats.ctimeMs !== initialStats.ctimeMs
  ) {
    throw new Error(`${label} changed while it was being verified.`);
  }
  return hash.digest("hex");
}

function assertPrivateSnapshotDirectory(snapshotDirectory) {
  let stats;
  try {
    stats = lstatSync(snapshotDirectory);
  } catch {
    throw new Error("Backup snapshot directory is missing.");
  }
  if (stats.isSymbolicLink()) {
    throw new Error("Backup snapshot directory must not use symbolic links.");
  }
  if (!stats.isDirectory()) throw new Error("Backup snapshot path is not a directory.");
  if ((stats.mode & 0o077) !== 0) {
    throw new Error("Backup snapshot directory permissions must be private.");
  }
}

function assertExactEntries(snapshotDirectory, expected) {
  const entries = directoryEntries(snapshotDirectory);
  if (!sameStrings(entries, [...expected].sort())) {
    throw new Error("Backup snapshot contains a missing or extra artifact.");
  }
}

function directoryEntries(snapshotDirectory) {
  return readdirSync(snapshotDirectory).sort();
}

function sameStrings(actual, expected) {
  return (
    actual.length === expected.length && actual.every((value, index) => value === expected[index])
  );
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function hmacSha256(key, value) {
  return createHmac("sha256", key).update(value).digest("hex");
}

function secureHexEqual(left, right) {
  if (!SHA256.test(left) || !SHA256.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
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

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value, expected) {
  return sameStrings(Object.keys(value).sort(), [...expected].sort());
}

async function main() {
  const [mode, snapshotDirectory, third, fourth, fifth] = process.argv.slice(2);
  if (!mode || !snapshotDirectory) {
    throw new Error(
      "usage: backup-metadata.mjs <write|verify|emit> <snapshot-directory> [artifact|env-file] [env-file|expected-layout]",
    );
  }
  const artifactName = mode === "emit" ? third : undefined;
  const envFile = mode === "emit" ? fourth : third;
  const expectedLayout = mode === "verify" ? fourth : mode === "emit" ? fifth : undefined;
  const fileEnv = envFile ? readEnvFile(envFile) : {};
  const env = { ...fileEnv, ...process.env };
  if (mode === "write") {
    writeBackupManifest(snapshotDirectory, env);
    console.log("Backup manifest written and verified.");
    return;
  }
  if (mode === "verify") {
    verifyBackupSnapshot(snapshotDirectory, env, expectedLayout);
    console.log("Backup snapshot identity and payloads verified.");
    return;
  }
  if (mode === "emit" && artifactName) {
    await emitVerifiedBackupArtifact(
      snapshotDirectory,
      artifactName,
      env,
      expectedLayout,
      process.stdout,
    );
    return;
  }
  throw new Error("Unsupported backup manifest operation.");
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Backup manifest operation failed.");
    process.exitCode = 1;
  });
}
