import { RUN_TOOL_SUMMARY_MAX_CHARS, type RunTool } from "@cortexai-agent-hub/contracts";

/** Text is redacted whole before it is clipped, so a clip never exposes part of a secret. */
function clipRedacted(text: string, redact: (text: string) => string): string {
  const line = redact(text).replace(/\s+/g, " ").trim();
  if (line.length <= RUN_TOOL_SUMMARY_MAX_CHARS) return line;
  let end = RUN_TOOL_SUMMARY_MAX_CHARS - 1;
  const last = line.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${line.slice(0, end)}…`;
}

function argumentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "[unserializable]";
  }
}

/** One redacted line of `key: value` pairs, at most RUN_TOOL_SUMMARY_MAX_CHARS long. */
export function summarizeToolArgs(
  args: Record<string, unknown>,
  redact: (text: string) => string,
): string {
  return clipRedacted(
    Object.entries(args)
      .map(([key, value]) => `${key}: ${argumentText(value)}`)
      .join(", "),
    redact,
  );
}

export interface RunToolLog {
  /** The runtime reported a tool call. */
  started(call: {
    name: string;
    args: Record<string, unknown>;
    executionId: string;
  }): Promise<void>;
  /** The call returned. A paused call stays running until a resumed attempt finishes it. */
  finished(completion: {
    name: string;
    executionId: string;
    outcome: "succeeded" | "error" | "paused";
    durationMs?: number;
    error?: string;
  }): Promise<void>;
}

/**
 * Tracks one attempt's tool calls as `run.tool` entries. Runtimes may finish a call before its
 * start is reported, so both orders produce a finished entry with the call's summary.
 */
export function createRunToolLog(options: {
  runId: string;
  /** The run's secret redaction, applied to every logged argument and failure text. */
  redact: (text: string) => string;
  record: (entry: RunTool) => Promise<void> | void;
  now?: () => Date;
}): RunToolLog {
  const now = options.now ?? (() => new Date());
  const calls = new Map<string, RunTool>();
  const record = async (entry: RunTool) => {
    calls.set(entry.callId, entry);
    await options.record(entry);
  };
  return {
    async started(call) {
      const known = calls.get(call.executionId);
      const summary = summarizeToolArgs(call.args, options.redact);
      if (known && known.summary === summary) return;
      await record(
        known
          ? { ...known, summary }
          : {
              runId: options.runId,
              callId: call.executionId,
              tool: call.name,
              summary,
              status: "running",
              startedAt: now().toISOString(),
              endedAt: null,
            },
      );
    },
    async finished(completion) {
      const known = calls.get(completion.executionId);
      if (known && known.status !== "running") return;
      const endedAt = now();
      const base = known ?? {
        runId: options.runId,
        callId: completion.executionId,
        tool: completion.name,
        summary: "",
        startedAt: new Date(endedAt.getTime() - (completion.durationMs ?? 0)).toISOString(),
      };
      if (completion.outcome === "paused") {
        if (!known) await record({ ...base, status: "running", endedAt: null });
        return;
      }
      await record({
        ...base,
        status: completion.outcome === "error" ? "failed" : "done",
        endedAt: endedAt.toISOString(),
        ...(completion.outcome === "error" && completion.error
          ? { error: clipRedacted(completion.error, options.redact) }
          : {}),
      });
    },
  };
}
