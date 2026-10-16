import { DEFAULT_MODEL_MAX_TOKENS } from "@cortexai-agent-hub/contracts";

/** Hung completions must fail before the typical 5-minute run lease. */
export const MODEL_STREAM_TIMEOUT_MS = 120_000;
/**
 * `timeoutMs` bounds only time-to-headers; the SSE body that follows is
 * unbounded. A Codex stream silent this long is a dead connection — reasoning
 * models emit thinking deltas continuously while generating.
 */
export const MODEL_STREAM_IDLE_TIMEOUT_MS = 180_000;
export const DEFAULT_MODEL_STREAM_MAX_RETRIES = 1;

/** More retries extend the worst-case turn; the executor heartbeat renews its leases. */
export function modelStreamMaxRetries(): number {
  const value = process.env.MODEL_STREAM_MAX_RETRIES?.trim();
  const raw = Number(value || DEFAULT_MODEL_STREAM_MAX_RETRIES);
  return Number.isInteger(raw) && raw >= 0 && raw <= 5 ? raw : DEFAULT_MODEL_STREAM_MAX_RETRIES;
}

/** About 25k tokens; longer results are saved to the bot computer when one is available. */
export const DEFAULT_TOOL_RESULT_TEXT_LIMIT = 100_000;
const MIN_TOOL_RESULT_TEXT_LIMIT = 12_000;
const MAX_TOOL_RESULT_TEXT_LIMIT = 1_000_000;

export function toolResultTextLimit(value = process.env.TOOL_RESULT_TEXT_LIMIT): number {
  const raw = Number(value?.trim() || DEFAULT_TOOL_RESULT_TEXT_LIMIT);
  return Number.isInteger(raw) &&
    raw >= MIN_TOOL_RESULT_TEXT_LIMIT &&
    raw <= MAX_TOOL_RESULT_TEXT_LIMIT
    ? raw
    : DEFAULT_TOOL_RESULT_TEXT_LIMIT;
}

export const TOOL_RESULT_TEXT_LIMIT = toolResultTextLimit();

export function toolResultTruncationNotice(limit: number): string {
  return `[Tool result truncated after ${limit} characters; the remainder was not delivered and this result is incomplete.]`;
}

export function clipToolResultText(text: string, limit: number = TOOL_RESULT_TEXT_LIMIT): string {
  return text.length > limit ? clipText(text, limit, limit) : text;
}

function clipText(text: string, keep: number, limit: number): string {
  return `${text.slice(0, keep)}…\n${toolResultTruncationNotice(limit)}`;
}

/**
 * Share one remaining character budget across all text parts.
 * Later text is omitted once the aggregate limit is exhausted; non-text parts stay.
 * Any omission carries exactly one truncation notice.
 */
export function clipToolResultContent<T>(
  content: T[],
  limit: number = TOOL_RESULT_TEXT_LIMIT,
): T[] {
  let remaining = limit;
  let noticed = false;
  let omitted = false;
  const clipped: T[] = [];
  for (const part of content) {
    if (
      !part ||
      typeof part !== "object" ||
      !("type" in part) ||
      (part as { type?: unknown }).type !== "text" ||
      !("text" in part)
    ) {
      clipped.push(part);
      continue;
    }
    const text = String((part as { text: unknown }).text);
    if (text.length <= remaining) {
      clipped.push(part);
      remaining -= text.length;
      continue;
    }
    if (noticed) continue;
    if (remaining > 0) {
      clipped.push({ ...part, text: clipText(text, remaining, limit) });
      remaining = 0;
      noticed = true;
      continue;
    }
    omitted = true;
  }
  if (omitted && !noticed) {
    clipped.push({ type: "text", text: toolResultTruncationNotice(limit) } as T);
  }
  return clipped;
}

/**
 * Prompt tokens providers bill, including cache read/write rather than the uncached remainder.
 * The cache halves are reported alongside so downstream views can show what a cache hit saved.
 */
export function billedPromptTokens(usage: {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}): {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
} {
  const cacheReadTokens = nonNegativeCount(usage.cacheRead);
  const cacheWriteTokens = nonNegativeCount(usage.cacheWrite);
  return {
    inputTokens: nonNegativeCount(usage.input) + cacheReadTokens + cacheWriteTokens,
    outputTokens: nonNegativeCount(usage.output),
    cacheReadTokens,
    cacheWriteTokens,
  };
}

/**
 * A reasoning model spends this same budget on its thinking, so the modest default
 * can be consumed before the reply starts. Wide enough for thinking plus an answer,
 * still far below a model card's 128k ceiling.
 */
export const REASONING_MODEL_MAX_TOKENS = 32_768;

/**
 * Completions default to a modest output cap so OpenRouter-style providers do not
 * hold credit for a model card's 128k ceiling. A configured maxTokens is the escape.
 * Reasoning models get the wider default because their thinking is billed against
 * the same ceiling: at 4k a hard question can leave no room for the reply at all.
 */
export function resolveCompletionMaxTokens(
  modelMaxTokens?: number,
  configuredMaxTokens?: number,
  optionsMaxTokens?: number,
  reasoning?: boolean,
): number {
  const userCap =
    typeof configuredMaxTokens === "number" && configuredMaxTokens >= 1
      ? configuredMaxTokens
      : reasoning
        ? REASONING_MODEL_MAX_TOKENS
        : DEFAULT_MODEL_MAX_TOKENS;
  const optionCap =
    typeof optionsMaxTokens === "number" && optionsMaxTokens >= 1
      ? Math.min(optionsMaxTokens, userCap)
      : userCap;
  if (typeof modelMaxTokens === "number" && modelMaxTokens >= 1) {
    return Math.min(modelMaxTokens, optionCap);
  }
  return optionCap;
}

function nonNegativeCount(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}
