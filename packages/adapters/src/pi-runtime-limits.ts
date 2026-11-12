import { DEFAULT_MODEL_MAX_TOKENS } from "@cortexai-agent-hub/contracts";
import type { Api, Model } from "@earendil-works/pi-ai";
import { LOCAL_PROVIDER_ID } from "./pi-local-provider-id.js";

/** Per-attempt wait for response headers; this does not cap active streaming duration. */
export const MODEL_STREAM_TIMEOUT_MS = 120_000;
/** Bound connection establishment independently of response streaming. */
export const MODEL_CONNECT_TIMEOUT_MS = 30_000;
/**
 * `timeoutMs` bounds only time-to-headers; the SSE body that follows is
 * unbounded. Bound silence for every provider so a stalled stream can fail
 * and advance the configured fallback chain.
 */
export const MODEL_STREAM_IDLE_TIMEOUT_MS = 180_000;
/** A 2xx Codex body sends `response.created` at once; a body silent this long never started. */
export const MODEL_STREAM_FIRST_EVENT_TIMEOUT_MS = 120_000;
/** Retries of one model call that stalled before any output; the last one may use a backup. */
export const MODEL_STREAM_STALL_RETRIES = 2;
/**
 * Same-model waits after a retryable provider failure when no backup is left.
 * Separate from the stall budget; provider timeouts skip it because each one
 * already spent a full request timeout.
 */
export const MODEL_PROVIDER_RETRY_DELAYS_MS = [2_000, 8_000, 20_000] as const;
export const DEFAULT_MODEL_STREAM_MAX_RETRIES = 1;
const MIN_FIRST_EVENT_TIMEOUT_MS = 10_000;
const MIN_IDLE_TIMEOUT_MS = 30_000;
const MAX_STREAM_TIMEOUT_MS = 900_000;

function boundedMs(value: string | undefined, min: number, fallback: number): number {
  const raw = Number(value?.trim() || fallback);
  return Number.isInteger(raw) && raw >= min && raw <= MAX_STREAM_TIMEOUT_MS ? raw : fallback;
}

/** 0 turns the stall watchdog off; otherwise 30s to 15 min. */
export function modelStreamIdleTimeoutMs(value = process.env.MODEL_STREAM_IDLE_TIMEOUT_MS): number {
  if (value?.trim() === "0") return 0;
  return boundedMs(value, MIN_IDLE_TIMEOUT_MS, MODEL_STREAM_IDLE_TIMEOUT_MS);
}

export function modelStreamFirstEventTimeoutMs(
  value = process.env.MODEL_STREAM_FIRST_EVENT_TIMEOUT_MS,
  idleTimeoutMs = modelStreamIdleTimeoutMs(),
): number {
  return Math.min(
    boundedMs(value, MIN_FIRST_EVENT_TIMEOUT_MS, MODEL_STREAM_FIRST_EVENT_TIMEOUT_MS),
    idleTimeoutMs,
  );
}

/**
 * Options for an undici `Agent` that carries model streams. undici otherwise drops a
 * response after 5 minutes without headers or body data, which caps the timeouts
 * above and fails as a bare "terminated". The SDK's `timeoutMs` and the stream idle
 * watchdog bound both waits instead.
 */
export const MODEL_STREAM_AGENT_TIMEOUTS = { headersTimeout: 0, bodyTimeout: 0 } as const;

/** More retries extend the worst-case turn; the executor heartbeat renews its leases. */
export function modelStreamMaxRetries(): number {
  const value = process.env.MODEL_STREAM_MAX_RETRIES?.trim();
  const raw = Number(value || DEFAULT_MODEL_STREAM_MAX_RETRIES);
  return Number.isInteger(raw) && raw >= 0 && raw <= 5 ? raw : DEFAULT_MODEL_STREAM_MAX_RETRIES;
}

/**
 * Parse a configurable timeout in whole milliseconds. Invalid or blank values
 * retain the existing default. Node timers support delays up to 2^31 - 1 ms.
 * Provider HTTP transports may impose additional independent limits.
 */
function timeoutMsFromEnv(
  value: string | undefined,
  fallback: number,
  min: number = 1_000,
  max: number = 300_000,
): number {
  const raw = Number(value?.trim() || fallback);
  return Number.isInteger(raw) && raw >= min && raw <= max ? raw : fallback;
}

export function modelStreamTimeoutMs(): number {
  return timeoutMsFromEnv(
    process.env.MODEL_STREAM_TIMEOUT_MS,
    MODEL_STREAM_TIMEOUT_MS,
    1_000,
    2_147_483_647,
  );
}

export function modelConnectTimeoutMs(): number {
  return timeoutMsFromEnv(process.env.MODEL_CONNECT_TIMEOUT_MS, MODEL_CONNECT_TIMEOUT_MS);
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

/** Leave at least three quarters of the window for input; token limits are positive integers. */
export function effectiveOutputReserve(contextWindow: number, maxTokens: number): number {
  return Math.min(maxTokens, Math.max(1, Math.floor(contextWindow / 4)));
}

/**
 * The output cap the operator chose for a model that has no per-connection field: the local
 * model server's own limit, when CORTEXAI_AGENT_HUB_LOCAL_MAX_TOKENS is set. Unset, and for other providers,
 * the defaults apply.
 */
export function operatorMaxTokens(
  model: Pick<Model<Api>, "provider" | "maxTokens">,
): number | undefined {
  return model.provider === LOCAL_PROVIDER_ID &&
    process.env.CORTEXAI_AGENT_HUB_LOCAL_MAX_TOKENS?.trim()
    ? model.maxTokens
    : undefined;
}

/**
 * Completions default to a modest output cap so OpenRouter-style providers do not
 * hold credit for a model card's 128k ceiling. A configured maxTokens overrides this
 * default, still bounded to a quarter of the context window when it is supplied.
 * Reasoning models get the wider default because their thinking is billed against
 * the same ceiling: at 4k a hard question can leave no room for the reply at all.
 * An operator-set limit (operatorMaxTokens) replaces both defaults.
 */
export function resolveCompletionMaxTokens(
  modelMaxTokens?: number,
  configuredMaxTokens?: number,
  optionsMaxTokens?: number,
  reasoning?: boolean,
  contextWindow?: number,
  operatorDefault?: number,
): number {
  const userCap =
    typeof configuredMaxTokens === "number" && configuredMaxTokens >= 1
      ? configuredMaxTokens
      : operatorDefault !== undefined && operatorDefault >= 1
        ? operatorDefault
        : reasoning
          ? REASONING_MODEL_MAX_TOKENS
          : DEFAULT_MODEL_MAX_TOKENS;
  const optionCap =
    typeof optionsMaxTokens === "number" && optionsMaxTokens >= 1
      ? Math.min(optionsMaxTokens, userCap)
      : userCap;
  const maxTokens =
    typeof modelMaxTokens === "number" && modelMaxTokens >= 1
      ? Math.min(modelMaxTokens, optionCap)
      : optionCap;
  return contextWindow === undefined ? maxTokens : effectiveOutputReserve(contextWindow, maxTokens);
}

function nonNegativeCount(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}
