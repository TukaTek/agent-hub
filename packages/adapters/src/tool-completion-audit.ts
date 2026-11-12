import { randomUUID } from "node:crypto";
import type { AgentToolCompletion } from "@cortexai-agent-hub/adapter-kit";
import { redactSecrets } from "@cortexai-agent-hub/core";
import type { ThreadEvents } from "@cortexai-agent-hub/db";
import { RunHistoryWriteError } from "@cortexai-agent-hub/db";
import { getLogger } from "@cortexai-agent-hub/logging";
import { isToolPauseResult } from "./approval-effect.js";
import { sanitizeConnectorError } from "./connector-safety.js";
import { memoryToolAuditSummary } from "./memory-tools.js";
import type { ToolCompletionAuditQueue } from "./tool-completion-audit-queue.js";
import { toolCompletionAuditQueue } from "./tool-completion-audit-queue.js";
import { isFailedToolResult, toolResultError } from "./tool-result-error.js";

function isAuditableToolResult(value: unknown): value is {
  kind: "agent_tool_result";
  content: unknown[];
  details: unknown;
} {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    (value as { kind?: unknown }).kind === "agent_tool_result" &&
    Array.isArray((value as { content?: unknown }).content)
  );
}

export function toolCompletionFromResult(
  base: Pick<AgentToolCompletion, "name" | "executionId" | "durationMs">,
  result: unknown,
): AgentToolCompletion {
  const paused = isToolPauseResult(result);
  if (isFailedToolResult(result)) return { ...base, error: result.error, paused };
  return { ...base, result, paused };
}

export function toolCompletionAuditPayload(
  completion: AgentToolCompletion,
  secrets: string[] = [],
): Record<string, unknown> {
  const durationMs = Number.isFinite(completion.durationMs)
    ? Math.max(0, Math.round(completion.durationMs))
    : 0;
  const error =
    completion.error === undefined ? toolResultError(completion.result) : completion.error;
  const payload: Record<string, unknown> = {
    name: redactSecrets(completion.name, secrets),
    executionId: redactSecrets(completion.executionId, secrets),
    durationMs,
    outcome: completion.paused ? "paused" : error === undefined ? "succeeded" : "error",
  };
  if (error !== undefined) {
    payload.error = sanitizeConnectorError(error, secrets);
  }
  const memoryResult =
    error === undefined ? memoryToolAuditSummary(completion.name, completion.result) : undefined;
  if (memoryResult) payload.result = memoryResult;
  if (!isAuditableToolResult(completion.result)) return payload;

  payload.contentTypes = completion.result.content.flatMap((part) => {
    if (!part || typeof part !== "object") return [];
    const type = (part as { type?: unknown }).type;
    return type === "text" || type === "image" ? [type] : [];
  });
  const details = completion.result.details;
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    return payload;
  }
  const record = details as Record<string, unknown>;
  if (typeof record.frameId === "string") {
    payload.frameId = redactSecrets(record.frameId, secrets);
  }
  if (typeof record.capturedAt === "string") {
    payload.capturedAt = record.capturedAt;
  }
  if (typeof record.width === "number" && Number.isFinite(record.width)) {
    payload.width = record.width;
  }
  if (typeof record.height === "number" && Number.isFinite(record.height)) {
    payload.height = record.height;
  }
  return payload;
}

export async function appendToolCompletionAudit(
  deps: { events: Pick<ThreadEvents, "append">; auditQueue?: ToolCompletionAuditQueue },
  target: { spaceId: string; threadId: string; botId: string; runId: string },
  completion: AgentToolCompletion,
  secrets: string[] = [],
): Promise<void> {
  const payload = toolCompletionAuditPayload(completion, secrets);
  getLogger().info("agent.tool.completed", {
    "run.id": target.runId,
    "space.id": target.spaceId,
    "thread.id": target.threadId,
    "bot.id": target.botId,
    tool: payload.name,
    "tool.outcome": payload.outcome,
    "tool.duration_ms": payload.durationMs,
  });
  const input = {
    spaceId: target.spaceId,
    threadId: target.threadId,
    botId: target.botId,
    runId: target.runId,
    type: "agent.tool.completed" as const,
    // One key per completion, reused by every retry, so the events unique index
    // turns a retry of an already committed audit into a no-op. A resumed call
    // repeats its executionId, so executionId cannot be the key.
    payload: { ...payload, auditId: randomUUID() },
  };
  const outcome = await (deps.auditQueue ?? toolCompletionAuditQueue).enqueue(target.runId, () =>
    deps.events.append(input),
  );
  if (outcome.status === "appended") return;
  // A tool that finishes after its run was cancelled has no history to join.
  if (outcome.error instanceof RunHistoryWriteError) return;
  // Audit persistence must not change the tool result or strand the run.
  getLogger().warn("agent tool completion audit append failed", {
    ...(outcome.error === undefined
      ? {}
      : { "error.detail": sanitizeConnectorError(outcome.error, secrets) }),
    reason: outcome.reason,
    attempts: outcome.attempts,
    tool: redactSecrets(completion.name, secrets),
    executionId: redactSecrets(completion.executionId, secrets),
  });
}
