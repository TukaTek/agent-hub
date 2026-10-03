/**
 * Hub-managed values for persisted deployment settings, applied when they are read so
 * the stored local baseline is never rewritten. Set once at process start from the
 * same Hub revision the process applied to its environment.
 */
export interface HubManagedDeploymentSettings {
  defaultModelProvider?: string | null;
  defaultModelId?: string | null;
}

let managed: Readonly<HubManagedDeploymentSettings> = {};

export function setHubManagedDeploymentSettings(next: HubManagedDeploymentSettings): void {
  managed = Object.freeze({ ...next });
}

export function hubManagedDeploymentSettings(): Readonly<HubManagedDeploymentSettings> {
  return managed;
}

/**
 * Model defaults with Hub's provider and model in place of the persisted ones. When
 * Hub sets only the provider, the persisted model (chosen for another provider) is
 * dropped rather than paired with it.
 */
export function withHubModelDefaults<
  T extends { defaultModelProvider: string | null; defaultModelId: string | null },
>(settings: T | null | undefined): T | null {
  const provider = Object.hasOwn(managed, "defaultModelProvider");
  const model = Object.hasOwn(managed, "defaultModelId");
  if (!provider && !model) return settings ?? null;
  return {
    ...(settings ?? {}),
    defaultModelProvider: provider
      ? (managed.defaultModelProvider ?? null)
      : (settings?.defaultModelProvider ?? null),
    defaultModelId: model
      ? (managed.defaultModelId ?? null)
      : provider
        ? null
        : (settings?.defaultModelId ?? null),
  } as T;
}
