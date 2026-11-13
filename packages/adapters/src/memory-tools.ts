import type { ConnectorTool, SemanticMemoryResponse } from "@cortexai-agent-hub/adapter-kit";
import { BOT_MEMORY_MAX_BYTES } from "@cortexai-agent-hub/contracts";
import type { Logger } from "@cortexai-agent-hub/logging";
import { getLogger } from "@cortexai-agent-hub/logging";
import { sanitizeConnectorError } from "./connector-safety.js";
import { byteLength } from "./utf8.js";

const SEMANTIC_MEMORY_TOOL_NAMES = new Set([
  "recall_memory",
  "save_memory",
  "forget_memory",
  "reflect_memory",
]);
const MAX_LOGGED_ERROR_CHARS = 300;

export type MemoryToolName = "recall_memory" | "save_memory" | "forget_memory";

const OPERATIONS: Record<MemoryToolName, "recall" | "save" | "forget"> = {
  recall_memory: "recall",
  save_memory: "save",
  forget_memory: "forget",
};

/** `forget_memory` and `reflect_memory` are offered only when the provider implements that optional verb. */
export function selectMemoryTools(
  tools: ConnectorTool[],
  semanticMemoryConfigured: boolean,
  semanticMemoryForgets: boolean,
  semanticMemoryReflects: boolean,
): ConnectorTool[] {
  return semanticMemoryConfigured
    ? tools.filter(
        (tool) =>
          (semanticMemoryForgets || tool.name !== "forget_memory") &&
          (semanticMemoryReflects || tool.name !== "reflect_memory"),
      )
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

export type MemoryEdit = { content: string } | { error: string; entries: string[] };

/**
 * Adds a fact, or with `oldText` replaces (or, given an empty fact, removes) the
 * lines holding its one match. A save that would grow the document past the cap
 * is refused with the entries, so the bot consolidates instead of losing notes.
 */
export function editMemory(
  existing: string,
  fact: string,
  oldText = "",
  maxBytes = BOT_MEMORY_MAX_BYTES,
): MemoryEdit {
  const target = oldText.trim().replace(/\r\n/g, "\n");
  let content = existing;
  if (!target) {
    content = appendMemoryFact(existing, fact);
  } else {
    const current = existing.replace(/\r\n/g, "\n");
    // An entry is the line or lines a match touches, so repeats within one line count once.
    const starts = new Set<number>();
    for (let at = current.indexOf(target); at !== -1; at = current.indexOf(target, at + 1))
      starts.add(current.lastIndexOf("\n", at - 1) + 1);
    if (starts.size !== 1) {
      const firstLine = target.split("\n")[0]!;
      return {
        error:
          starts.size === 0
            ? "No entry contains old_text. Copy it exactly from one of these entries."
            : "old_text matches more than one entry. Quote more of the one to change.",
        entries: entriesOf(current).filter((line) => starts.size === 0 || line.includes(firstLine)),
      };
    }
    const index = current.indexOf(target);
    const start = [...starts][0]!;
    const lineEnd = current.indexOf("\n", index + target.length);
    const end = lineEnd === -1 ? current.length : lineEnd;
    const next = fact.trim().replace(/\r\n/g, "\n");
    content = next
      ? `${current.slice(0, start)}${next}${current.slice(end)}`
      : `${current.slice(0, start)}${current.slice(lineEnd === -1 ? end : end + 1)}`;
  }
  const bytes = byteLength(content);
  if (bytes > maxBytes && bytes > byteLength(existing)) {
    return {
      error: `Memory is full (${maxBytes} bytes). Make room by merging, shortening or removing entries with old_text, then save again.`,
      entries: entriesOf(existing),
    };
  }
  return { content };
}

function entriesOf(content: string): string[] {
  return content
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => line.trim());
}
