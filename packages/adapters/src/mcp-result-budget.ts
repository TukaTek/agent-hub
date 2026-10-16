import { TOOL_RESULT_TEXT_LIMIT } from "./pi-runtime-limits.js";

/** Optional discovery-time hint. Result bodies cannot enlarge their own budget. */
export const MCP_RESULT_BUDGET_KEY = "io.cortexai/max-result-chars";
/** Never below the default, so a declared budget can only widen delivery. */
export const MAX_TOOL_RESULT_CHARS = Math.max(128_000, TOOL_RESULT_TEXT_LIMIT);

export function boundedResultChars(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= TOOL_RESULT_TEXT_LIMIT
    ? Math.min(value, MAX_TOOL_RESULT_CHARS)
    : undefined;
}

export function mcpResultBudget(tool: {
  annotations?: { readOnlyHint?: boolean };
  _meta?: Record<string, unknown>;
}): { maxResultChars?: number } {
  const budget =
    tool.annotations?.readOnlyHint === true
      ? boundedResultChars(tool._meta?.[MCP_RESULT_BUDGET_KEY])
      : undefined;
  return budget === undefined ? {} : { maxResultChars: budget };
}

export function toolResultChars(
  tool: { maxResultChars?: number; resultCharsByToolId?: Record<string, number> },
  args: Record<string, unknown>,
): number | undefined {
  const id = args.id;
  if (
    typeof id === "string" &&
    tool.resultCharsByToolId &&
    Object.hasOwn(tool.resultCharsByToolId, id)
  ) {
    return boundedResultChars(tool.resultCharsByToolId[id]);
  }
  return boundedResultChars(tool.maxResultChars);
}
