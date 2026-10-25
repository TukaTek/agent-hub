import { RUN_TOOL_SUMMARY_MAX_CHARS, type RunTool } from "@cortexai-agent-hub/contracts";

const MASK = "[redacted]";
/** Key text that names a credential anywhere in it, as in `accessToken` or `client_secret`. */
const CREDENTIAL_KEY = /passw(or)?d|passphrase|secret|token|apikey|credential|authorization|cookie/;
/** Key words that name a credential only as a whole word, so `path` is not `pat`. */
const CREDENTIAL_KEY_WORDS = new Set(["auth", "key", "pat", "pin", "otp", "pwd", "session", "jwt"]);
/** Maps whose every value is masked, whatever its key: environments and request headers. */
const CREDENTIAL_MAPS = new Set(["env", "environment", "headers"]);
/** Credential shapes in free text: bearer values, known token prefixes, URL passwords, assignments. */
const CREDENTIAL_TEXT: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, MASK],
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${MASK}`],
  [
    /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|glpat-[\w-]{20,}|sk-[\w-]{16,}|sk_(?:live|test)_\w{16,}|xox[abposr]-[\w-]{10,}|AKIA[0-9A-Z]{16}|AIza[\w-]{35}|eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,})/g,
    MASK,
  ],
  [/(\/\/[^/\s:@]+:)[^/\s@]+@/g, `$1${MASK}@`],
  [
    /\b([\w.-]*(?:passw(?:or)?d|passphrase|secret|token|api[_-]?key|credential|authorization)[\w.-]*|(?:[A-Za-z0-9]+[_.-])*(?:auth|key|pat|pin|otp|pwd|session|jwt)(?:[_.-][A-Za-z0-9]+)*)(["']?\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s"',;&]+)/gi,
    `$1$2${MASK}`,
  ],
  // Long random-looking runs that mix upper case, lower case and digits.
  [/\b(?=[\w-]*[A-Z])(?=[\w-]*[a-z])(?=[\w-]*\d)[\w-]{32,}/g, MASK],
];

function isCredentialKey(key: string): boolean {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return (
    CREDENTIAL_KEY.test(words.join("")) || words.some((word) => CREDENTIAL_KEY_WORDS.has(word))
  );
}

function maskCredentialText(text: string): string {
  return CREDENTIAL_TEXT.reduce((masked, [pattern, mask]) => masked.replace(pattern, mask), text);
}

/**
 * Masks credentials the run never registered: values under credential-shaped keys, every value
 * of an environment or header map, and credential-shaped text anywhere else.
 */
function maskCredentials(value: unknown, key?: string): unknown {
  if (key !== undefined && isCredentialKey(key)) return MASK;
  const everyValue = key !== undefined && CREDENTIAL_MAPS.has(key.toLowerCase());
  if (typeof value === "string") return everyValue ? MASK : maskCredentialText(value);
  if (Array.isArray(value)) {
    return value.map((item) => (everyValue ? MASK : maskCredentials(item)));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [
        name,
        everyValue ? MASK : maskCredentials(item, name),
      ]),
    );
  }
  return everyValue && value !== null && value !== undefined ? MASK : value;
}

/** Text is redacted whole before it is clipped, so a clip never exposes part of a secret. */
function clipRedacted(text: string, redact: (text: string) => string): string {
  const line = redact(text).replace(/\s+/g, " ").trim();
  if (line.length <= RUN_TOOL_SUMMARY_MAX_CHARS) return line;
  let end = RUN_TOOL_SUMMARY_MAX_CHARS - 1;
  const last = line.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${line.slice(0, end)}…`;
}

function argumentText(key: string, value: unknown): string {
  try {
    const masked = maskCredentials(value, key);
    if (typeof masked === "string") return masked;
    if (masked === null || typeof masked === "number" || typeof masked === "boolean") {
      return String(masked);
    }
    return JSON.stringify(masked) ?? "";
  } catch {
    return "[unserializable]";
  }
}

/**
 * One redacted line of `key: value` pairs, at most RUN_TOOL_SUMMARY_MAX_CHARS long. Credentials
 * are masked by key and shape, then by the run's registered secrets, before the line is clipped.
 */
export function summarizeToolArgs(
  args: Record<string, unknown>,
  redact: (text: string) => string,
): string {
  return clipRedacted(
    Object.entries(args)
      .map(([key, value]) => `${key}: ${argumentText(key, value)}`)
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
  /**
   * The entry of a call that is pausing the run, to save with the paused turn. Logs a running
   * entry when the call's start has not been reported yet.
   */
  pending(executionId: string, name: string): Promise<PendingRunTool>;
  /** Continue a call paused by an earlier attempt, so this attempt finishes the same entry. */
  resume(call: PendingRunTool): void;
}

/** A tool call and its log entry, saved with a paused turn so the resumed attempt can finish it. */
export interface PendingRunTool {
  executionId: string;
  entry: RunTool;
}

type TrackedCall = PendingRunTool;

/**
 * Tracks one attempt's tool calls as `run.tool` entries. Providers may reuse a call id (often
 * `call_0` in every response), so each call gets its own `callId` and a start or finish pairs
 * with the oldest call of that tool and id still waiting for it. Runtimes may finish a call
 * before its start is reported, so both orders produce a finished entry with the call's summary.
 */
export function createRunToolLog(options: {
  runId: string;
  /** Unique per attempt; it prefixes every call id, so ids never repeat within a run. */
  attemptId: string;
  /** The run's secret redaction, applied to every logged argument and failure text. */
  redact: (text: string) => string;
  record: (entry: RunTool) => Promise<void> | void;
  now?: () => Date;
}): RunToolLog {
  const now = options.now ?? (() => new Date());
  let count = 0;
  // Calls still waiting for their start or their finish to be reported, oldest first.
  const unstarted: TrackedCall[] = [];
  const unfinished: TrackedCall[] = [];
  const find = (calls: TrackedCall[], executionId: string, tool: string) =>
    calls.findIndex((call) => call.executionId === executionId && call.entry.tool === tool);
  const track = (executionId: string, entry: Omit<RunTool, "runId" | "callId">) => ({
    executionId,
    entry: { runId: options.runId, callId: `${options.attemptId}:${++count}`, ...entry },
  });
  const record = async (call: TrackedCall, entry: RunTool) => {
    call.entry = entry;
    await options.record(entry);
  };
  return {
    async started(call) {
      const summary = summarizeToolArgs(call.args, options.redact);
      const index = find(unstarted, call.executionId, call.name);
      if (index >= 0) {
        const [known] = unstarted.splice(index, 1);
        if (known!.entry.summary !== summary) await record(known!, { ...known!.entry, summary });
        return;
      }
      const tracked = track(call.executionId, {
        tool: call.name,
        summary,
        status: "running",
        startedAt: now().toISOString(),
        endedAt: null,
      });
      unfinished.push(tracked);
      await record(tracked, tracked.entry);
    },
    async finished(completion) {
      const endedAt = now();
      const index = find(unfinished, completion.executionId, completion.name);
      const known = index >= 0 ? unfinished[index]! : undefined;
      const tracked =
        known ??
        track(completion.executionId, {
          tool: completion.name,
          summary: "",
          status: "running",
          startedAt: new Date(endedAt.getTime() - (completion.durationMs ?? 0)).toISOString(),
          endedAt: null,
        });
      if (!known) {
        // Every call's first entry is running: the run log pages calls by that entry.
        unstarted.push(tracked);
        await record(tracked, tracked.entry);
      }
      if (completion.outcome === "paused") {
        if (!known) unfinished.push(tracked);
        return;
      }
      if (known) unfinished.splice(index, 1);
      // A resumed interaction finishes without a start report; it must not absorb a later call.
      const unstartedIndex = unstarted.indexOf(tracked);
      if (known && unstartedIndex >= 0) unstarted.splice(unstartedIndex, 1);
      await record(tracked, {
        ...tracked.entry,
        status: completion.outcome === "error" ? "failed" : "done",
        endedAt: endedAt.toISOString(),
        ...(completion.outcome === "error" && completion.error
          ? { error: clipRedacted(maskCredentialText(completion.error), options.redact) }
          : {}),
      });
    },
    async pending(executionId, name) {
      const index = unfinished.findLastIndex(
        (call) => call.executionId === executionId && call.entry.tool === name,
      );
      if (index >= 0) return { ...unfinished[index]! };
      const tracked = track(executionId, {
        tool: name,
        summary: "",
        status: "running",
        startedAt: now().toISOString(),
        endedAt: null,
      });
      unstarted.push(tracked);
      unfinished.push(tracked);
      await record(tracked, tracked.entry);
      return { ...tracked };
    },
    resume(call) {
      const tracked = { ...call };
      unstarted.push(tracked);
      unfinished.push(tracked);
    },
  };
}
