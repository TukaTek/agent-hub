import type { ConnectorTool, SemanticMemoryResponse } from "@cortexai-agent-hub/adapter-kit";
import type { Logger } from "@cortexai-agent-hub/logging";
import { getLogger } from "@cortexai-agent-hub/logging";
import { sanitizeConnectorError } from "./connector-safety.js";

const SEMANTIC_MEMORY_TOOL_NAMES = new Set(["recall_memory", "save_memory", "forget_memory"]);
const MAX_LOGGED_ERROR_CHARS = 300;

export type MemoryToolName = "recall_memory" | "save_memory" | "forget_memory";

const OPERATIONS: Record<MemoryToolName, "recall" | "save" | "forget"> = {
  recall_memory: "recall",
  save_memory: "save",
  forget_memory: "forget",
};

/** `forget_memory` is offered only when the provider implements its optional forget verb. */
export function selectMemoryTools(
  tools: ConnectorTool[],
  semanticMemoryConfigured: boolean,
  semanticMemoryForgets: boolean,
): ConnectorTool[] {
  return semanticMemoryConfigured
    ? tools.filter((tool) => semanticMemoryForgets || tool.name !== "forget_memory")
    : tools.filter((tool) => !SEMANTIC_MEMORY_TOOL_NAMES.has(tool.name));
}

/**
 * Providers report failures as `{ok:false}` or by throwing. Either becomes a top-level
 * `error`, which the tool audit records as a failed call and the model reads as a failure.
 * `redact` must cover the run secrets and the memory text: neither may reach logs or events.
 */
export async function runMemoryTool<T>(
  tool: MemoryToolName,
  call: () => Promise<SemanticMemoryResponse<T>>,
  options: {
    provider: string;
    signal?: AbortSignal;
    redact: string[];
    logger?: Pick<Logger, "warn">;
  },
): Promise<SemanticMemoryResponse<T>> {
  let failure: unknown;
  try {
    const response = await call();
    if (response.ok) return response;
    failure = response.error;
  } catch (error) {
    failure = error;
  }
  options.signal?.throwIfAborted();
  const message = sanitizeConnectorError(failure, options.redact).slice(0, MAX_LOGGED_ERROR_CHARS);
  (options.logger ?? getLogger()).warn("memory tool failed", {
    provider: options.provider,
    operation: OPERATIONS[tool],
    error: message,
  });
  return { ok: false, error: `${tool} failed: ${message}` };
}

/** Content-free outcome of a successful memory call, for the run event. */
export function memoryToolAuditSummary(
  name: string,
  result: unknown,
): Record<string, unknown> | undefined {
  if (!SEMANTIC_MEMORY_TOOL_NAMES.has(name)) return undefined;
  const payload = (result as { details?: unknown } | null)?.details ?? result;
  if ((payload as { ok?: unknown } | null)?.ok !== true) return undefined;
  const value = (payload as { value?: unknown }).value;
  if (name === "recall_memory") {
    return { ok: true, count: Array.isArray(value) ? value.length : 0 };
  }
  if (name === "forget_memory" && value && typeof value === "object") {
    const { id, expired } = value as { id?: unknown; expired?: unknown };
    return {
      ok: true,
      ...(typeof id === "string" ? { id } : {}),
      ...(typeof expired === "boolean" ? { expired } : {}),
    };
  }
  return { ok: true };
}

/** Adds a remembered fact to a bot memory document without dropping what it already holds. */
export function appendMemoryFact(existing: string, fact: string): string {
  const current = existing.trimEnd().replace(/\r\n/g, "\n");
  const next = fact.trim();
  const comparableFact = next.replace(/\r\n/g, "\n");
  if (
    !next ||
    `\n${current}\n`.includes(`\n${comparableFact}\n`) ||
    (!next.includes("\n") && current.split("\n").some((line) => line.trim() === next))
  )
    return existing;
  return existing ? `${existing}${existing.endsWith("\n") ? "" : "\n"}${next}\n` : `${next}\n`;
}
