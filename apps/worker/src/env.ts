import { resolveDeploymentIdentity } from "@rakazo/core";

export interface WorkerMetadata {
  deploymentId: string;
  revision: string | null;
}

export function loadWorkerMetadata(source: NodeJS.ProcessEnv = process.env): WorkerMetadata {
  return {
    deploymentId: resolveDeploymentIdentity(source),
    revision: optional(source.GIT_SHA) ?? optional(source.RAKAZO_GIT_SHA) ?? null,
  };
}

function optional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}
