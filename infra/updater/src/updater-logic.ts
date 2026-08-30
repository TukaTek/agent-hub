import path from "node:path";
import {
  DEFAULT_IMAGE_TAG,
  expectedUpdaterImage,
  GIT_SHA_ENV,
  IMAGE_TAG_ENV,
  isValidImageName,
  isValidImageTag,
  OFFICIAL_SERVER_IMAGE,
  PREVIOUS_GIT_SHA_ENV,
  PREVIOUS_IMAGE_TAG_ENV,
  PREVIOUS_UPDATER_IMAGE_ENV,
  PREVIOUS_UPDATER_IMAGE_TAG_ENV,
  resolveComposeProjectName,
  resolveUpdaterToken,
  UPDATER_IMAGE_ENV,
  UPDATER_IMAGE_TAG_ENV,
} from "@rakazo/core";

export const DEFAULT_UPDATER_PORT = 7092;
export const DEFAULT_COMPOSE_FILE = "infra/compose/docker-compose.prod.yml";
export const MAX_STEP_OUTPUT = 8_000;

export interface UpdaterConfig {
  /** Bind-mounted at the same absolute path it has on the host, so Compose resolves identically. */
  deployDir: string;
  composeFile: string;
  envFile: string;
  /** Passed as `docker compose -p`. Compose injects this into running services. */
  projectName: string;
  image: string;
  token: string;
  host: string;
  port: number;
}

/**
 * The deployment directory has to be an absolute path because Compose derives every relative bind
 * mount from it. Mounting it anywhere other than its host path would make this container reconcile
 * a *different* tree than the operator's. The project name is passed as `-p` separately so a custom
 * `docker compose -p` stack is the one that is updated.
 */
export function resolveUpdaterConfig(env: NodeJS.ProcessEnv): UpdaterConfig {
  const deployDir = env.RAKAZO_DEPLOY_DIR?.trim() ?? "";
  if (deployDir === "" || !path.posix.isAbsolute(deployDir)) {
    throw new Error("Set RAKAZO_DEPLOY_DIR to the absolute path of the deployment directory.");
  }
  const image = env.RAKAZO_IMAGE?.trim() || OFFICIAL_SERVER_IMAGE;
  if (!isValidImageName(image))
    throw new Error(`RAKAZO_IMAGE is not a usable image name: ${image}`);
  const composeFile = env.RAKAZO_COMPOSE_FILE?.trim() || DEFAULT_COMPOSE_FILE;
  if (path.posix.isAbsolute(composeFile) || composeFile.split("/").includes("..")) {
    throw new Error("RAKAZO_COMPOSE_FILE must be a path inside the deployment directory.");
  }
  const port = Number(env.RAKAZO_UPDATER_PORT ?? DEFAULT_UPDATER_PORT);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error("RAKAZO_UPDATER_PORT is not a port number.");
  }
  return {
    deployDir,
    composeFile: path.posix.join(deployDir, composeFile),
    envFile: path.posix.join(deployDir, ".env"),
    projectName: resolveComposeProjectName(env),
    image,
    token: resolveUpdaterToken(env),
    host: env.RAKAZO_UPDATER_HOST?.trim() || "127.0.0.1",
    port,
  };
}

/**
 * Reads one assignment out of a `.env` file the way Compose does: later assignments win, comments
 * and blank lines are ignored, and one layer of quoting is removed.
 */
export function readEnvAssignment(contents: string, key: string): string | null {
  let found: string | null = null;
  for (const raw of contents.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0 || line.slice(0, separator).trim() !== key) continue;
    const value = line.slice(separator + 1).trim();
    found = value.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
  }
  return found;
}

export interface TagState {
  currentTag: string;
  previousTag: string | null;
}

export interface DeploymentIdentity {
  revision: string | null;
  applicationImage: string;
  applicationImageTag: string;
  updaterImage: string | null;
  updaterImageTag: string | null;
}

export interface DeploymentIdentityState {
  production: boolean;
  updaterEnabled: boolean;
  current: DeploymentIdentity;
  previous: DeploymentIdentity | null;
}

const FULL_GIT_SHA = /^[0-9a-f]{40}$/;

/** What the deployment is pinned to now, ignoring anything in the file that is not a usable tag. */
export function readTagState(envContents: string): TagState {
  const current = readEnvAssignment(envContents, IMAGE_TAG_ENV);
  const previous = readEnvAssignment(envContents, PREVIOUS_IMAGE_TAG_ENV);
  return {
    currentTag: current !== null && isValidImageTag(current) ? current : DEFAULT_IMAGE_TAG,
    previousTag: previous !== null && isValidImageTag(previous) ? previous : null,
  };
}

function requireAssignment(envContents: string, key: string): string {
  const value = readEnvAssignment(envContents, key);
  if (value === null || value === "") {
    throw new UpdateRefused(
      `The production deployment has an incomplete deployment identity (${key}).`,
    );
  }
  return value;
}

function productionIdentity(
  envContents: string,
  applicationImage: string,
  revisionKey: string,
  applicationTagKey: string,
  updaterImageKey: string,
  updaterTagKey: string,
  updaterEnabled: boolean,
): DeploymentIdentity {
  const revision = requireAssignment(envContents, revisionKey);
  const applicationImageTag = requireAssignment(envContents, applicationTagKey);
  if (!FULL_GIT_SHA.test(revision) || applicationImageTag !== `sha-${revision}`) {
    throw new UpdateRefused(
      "The production deployment identity must use one exact full source SHA for its revision and application image tag.",
    );
  }

  if (!updaterEnabled) {
    return {
      revision,
      applicationImage,
      applicationImageTag,
      updaterImage: null,
      updaterImageTag: null,
    };
  }

  const updaterImage = requireAssignment(envContents, updaterImageKey);
  const updaterImageTag = requireAssignment(envContents, updaterTagKey);
  const expectedImage = expectedUpdaterImage(applicationImage);
  if (
    expectedImage === undefined ||
    updaterImage !== expectedImage ||
    !isValidImageName(updaterImage) ||
    updaterImageTag !== `sha-${revision}`
  ) {
    throw new UpdateRefused(
      "The production deployment identity must pin the updater to the exact sibling image and source SHA.",
    );
  }
  return {
    revision,
    applicationImage,
    applicationImageTag,
    updaterImage,
    updaterImageTag,
  };
}

/**
 * Production updates fail closed unless every enabled identity member is complete and agrees on
 * one full source SHA. Non-production keeps the pre-existing tag-only compatibility used by local
 * development fixtures; it never invents an updater pin.
 */
export function readDeploymentIdentityState(
  envContents: string,
  configuredApplicationImage: string,
): DeploymentIdentityState {
  const production = readEnvAssignment(envContents, "NODE_ENV") === "production";
  const updaterEnabled = Boolean(readEnvAssignment(envContents, "RAKAZO_UPDATER_TOKEN"));
  if (!production) {
    const tags = readTagState(envContents);
    const revision = readEnvAssignment(envContents, GIT_SHA_ENV);
    const previousRevision = readEnvAssignment(envContents, PREVIOUS_GIT_SHA_ENV);
    return {
      production,
      updaterEnabled: false,
      current: {
        revision: revision !== null && FULL_GIT_SHA.test(revision) ? revision : null,
        applicationImage: configuredApplicationImage,
        applicationImageTag: tags.currentTag,
        updaterImage: null,
        updaterImageTag: null,
      },
      previous:
        tags.previousTag === null
          ? null
          : {
              revision:
                previousRevision !== null && FULL_GIT_SHA.test(previousRevision)
                  ? previousRevision
                  : null,
              applicationImage: configuredApplicationImage,
              applicationImageTag: tags.previousTag,
              updaterImage: null,
              updaterImageTag: null,
            },
    };
  }

  const applicationImage = requireAssignment(envContents, "RAKAZO_IMAGE");
  if (!isValidImageName(applicationImage) || applicationImage !== configuredApplicationImage) {
    throw new UpdateRefused(
      "The production deployment identity does not match the updater's application image.",
    );
  }
  const current = productionIdentity(
    envContents,
    applicationImage,
    GIT_SHA_ENV,
    IMAGE_TAG_ENV,
    UPDATER_IMAGE_ENV,
    UPDATER_IMAGE_TAG_ENV,
    updaterEnabled,
  );

  const previousKeys = [
    PREVIOUS_GIT_SHA_ENV,
    PREVIOUS_IMAGE_TAG_ENV,
    ...(updaterEnabled ? [PREVIOUS_UPDATER_IMAGE_ENV, PREVIOUS_UPDATER_IMAGE_TAG_ENV] : []),
  ];
  const previousValues = previousKeys.map((key) => readEnvAssignment(envContents, key));
  const previousPresent = previousValues.some((value) => value !== null && value !== "");
  if (!previousPresent) return { production, updaterEnabled, current, previous: null };
  if (previousValues.some((value) => value === null || value === "")) {
    throw new UpdateRefused(
      "The production deployment has an incomplete previous deployment identity.",
    );
  }

  return {
    production,
    updaterEnabled,
    current,
    previous: productionIdentity(
      envContents,
      applicationImage,
      PREVIOUS_GIT_SHA_ENV,
      PREVIOUS_IMAGE_TAG_ENV,
      PREVIOUS_UPDATER_IMAGE_ENV,
      PREVIOUS_UPDATER_IMAGE_TAG_ENV,
      updaterEnabled,
    ),
  };
}

export function deploymentIdentityAssignments(
  current: DeploymentIdentity,
  previous: DeploymentIdentity,
  updaterEnabled: boolean,
): Record<string, string> {
  const assignments: Record<string, string> = {
    [IMAGE_TAG_ENV]: current.applicationImageTag,
    [PREVIOUS_IMAGE_TAG_ENV]: previous.applicationImageTag,
  };
  if (current.revision !== null && previous.revision !== null) {
    assignments[GIT_SHA_ENV] = current.revision;
    assignments[PREVIOUS_GIT_SHA_ENV] = previous.revision;
  }
  if (updaterEnabled) {
    if (
      current.updaterImage === null ||
      current.updaterImageTag === null ||
      previous.updaterImage === null ||
      previous.updaterImageTag === null
    ) {
      throw new UpdateRefused("The enabled updater deployment identity is incomplete.");
    }
    assignments[UPDATER_IMAGE_ENV] = current.updaterImage;
    assignments[UPDATER_IMAGE_TAG_ENV] = current.updaterImageTag;
    assignments[PREVIOUS_UPDATER_IMAGE_ENV] = previous.updaterImage;
    assignments[PREVIOUS_UPDATER_IMAGE_TAG_ENV] = previous.updaterImageTag;
  }
  return assignments;
}

export function nextDeploymentIdentity(
  state: DeploymentIdentityState,
  revision: string,
  applicationImageTag: string,
): DeploymentIdentity {
  if (!FULL_GIT_SHA.test(revision)) {
    throw new UpdateRefused("An update needs an exact full 40-character source SHA.");
  }
  if (state.production && applicationImageTag !== `sha-${revision}`) {
    throw new UpdateRefused(
      "A production update must use the exact source-addressed application image tag.",
    );
  }
  const updaterImage = state.updaterEnabled
    ? expectedUpdaterImage(state.current.applicationImage)
    : null;
  if (state.updaterEnabled && updaterImage === undefined) {
    throw new UpdateRefused("The enabled updater needs an application image ending in /app.");
  }
  return {
    revision,
    applicationImage: state.current.applicationImage,
    applicationImageTag,
    updaterImage: updaterImage ?? null,
    updaterImageTag: state.updaterEnabled ? `sha-${revision}` : null,
  };
}

export function truncateOutput(value: string): string {
  const text = value.trimEnd();
  if (text.length <= MAX_STEP_OUTPUT) return text;
  return `…${text.slice(-MAX_STEP_OUTPUT)}`;
}

/**
 * The sidecar answers with a plain reason when it will not act, so the API can surface it as a bad
 * request instead of an opaque 500.
 */
export class UpdateRefused extends Error {}
