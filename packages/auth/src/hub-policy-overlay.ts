import type { HubManagedDeploymentSettings } from "@cortexai-agent-hub/core";
import {
  HUB_MANAGED_SETTINGS,
  type HubManagedSetting,
  type HubPolicyDocument,
  type HubSettingValue,
} from "./hub-policy-contract.js";

/**
 * Operator signal for a Hub value that replaced a local one. It names the setting,
 * the Hub revision and the local source it replaced, never either value.
 */
export interface HubOverrideSignal {
  event: "hub_policy_override";
  key: string;
  hubRevision: number;
  overriddenSource: string;
}

const envValue = (value: HubSettingValue) =>
  Array.isArray(value) ? value.join(",") : String(value);

function signal(key: string, revision: number, source: string): HubOverrideSignal {
  return { event: "hub_policy_override", key, hubRevision: revision, overriddenSource: source };
}

/** Settings Hub manages, plus provider-bound inputs a provider override invalidates. */
function managedEntries(policy: HubPolicyDocument) {
  const entries: Array<{ setting: HubManagedSetting; value: HubSettingValue | undefined }> = [];
  for (const setting of HUB_MANAGED_SETTINGS) {
    if (Object.hasOwn(policy.overrides, setting.path)) {
      entries.push({ setting, value: policy.overrides[setting.path] });
    }
  }
  // A changed provider must never inherit a model chosen for another provider.
  if (
    Object.hasOwn(policy.overrides, "model.defaultProvider") &&
    !Object.hasOwn(policy.overrides, "model.defaultModel")
  ) {
    const model = HUB_MANAGED_SETTINGS.find((setting) => setting.path === "model.defaultModel")!;
    entries.push({ setting: { ...model, path: "model.defaultProvider" }, value: undefined });
  }
  return entries;
}

/** Hub wins over every environment input it manages; unmanaged inputs stay local. */
export function overlayHubEnv(
  source: NodeJS.ProcessEnv,
  policy: HubPolicyDocument,
): { env: NodeJS.ProcessEnv; signals: HubOverrideSignal[] } {
  const env: NodeJS.ProcessEnv = { ...source };
  const signals: HubOverrideSignal[] = [];
  for (const { setting, value } of managedEntries(policy)) {
    const next = value === undefined ? undefined : envValue(value);
    setting.env.forEach((name, index) => {
      const local = env[name];
      const target = index === 0 ? next : undefined;
      if (local !== undefined && local !== "" && local !== target)
        signals.push(signal(setting.path, policy.revision, `env:${name}`));
      if (target === undefined) delete env[name];
      else env[name] = target;
    });
  }
  return { env, signals };
}

type DeploymentRow =
  | Partial<Record<keyof HubManagedDeploymentSettings, unknown>>
  | null
  | undefined;

/** Hub values for persisted deployment fields. The stored row is never rewritten. */
export function hubDeploymentSettings(
  policy: HubPolicyDocument,
  row?: DeploymentRow,
): { managed: HubManagedDeploymentSettings; signals: HubOverrideSignal[] } {
  const managed: Record<string, unknown> = {};
  const signals: HubOverrideSignal[] = [];
  for (const { setting, value } of managedEntries(policy)) {
    const field = setting.deploymentField;
    if (!field) continue;
    const next = value === undefined ? null : Array.isArray(value) ? value.join(",") : value;
    managed[field] = next;
    const local = row?.[field];
    if (local !== undefined && local !== null && local !== next)
      signals.push(signal(setting.path, policy.revision, `deployment_settings.${field}`));
  }
  return { managed: managed as HubManagedDeploymentSettings, signals };
}
