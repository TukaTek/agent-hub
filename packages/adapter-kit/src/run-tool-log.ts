import { RUN_TOOL_SUMMARY_MAX_CHARS, type RunTool } from "@cortexai-agent-hub/contracts";

const MASK = "[redacted]";
/** Key text that names a credential anywhere in it, as in `accessToken` or `client_secret`. */
const CREDENTIAL_KEY = /passw(or)?d|passphrase|secret|token|apikey|credential|authorization|cookie/;
/** Key words that name a credential only as a whole word, so `path` is not `pat`. */
const CREDENTIAL_KEY_WORDS = new Set([
  "auth",
  "bearer",
  "key",
  "pat",
  "pin",
  "otp",
  "pwd",
  "session",
  "jwt",
]);
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

/** Arguments that hold a command line or its argument vector. */
const COMMAND_KEYS = new Set(["command", "cmd", "args", "argv"]);
const ARGS_REDACTED = "[args redacted]";

/** Splits a command line into words, honoring single quotes, double quotes and backslashes. */
function commandWords(line: string): string[] {
  const words: string[] = [];
  let word: string | undefined;
  let quote: string | undefined;
  for (let index = 0; index < line.length; index++) {
    const char = line.charAt(index);
    if (!quote && /\s/.test(char)) {
      if (word !== undefined) words.push(word);
      word = undefined;
      continue;
    }
    word ??= "";
    if (char === quote) quote = undefined;
    else if (!quote && (char === "'" || char === '"')) quote = char;
    else if (char === "\\" && quote !== "'" && index + 1 < line.length) {
      word += line.charAt(++index);
    } else word += char;
  }
  if (word !== undefined) words.push(word);
  return words;
}

/** A `Name: value` header whose name is a credential, as in `Authorization: Bearer x`. */
function isCredentialHeader(text: string): boolean {
  const header = /^\s*([A-Za-z][\w-]*)\s*:\s*\S/.exec(text);
  return header !== null && (isCredentialKey(header[1]!) || /^cookie$/i.test(header[1]!));
}

/**
 * Whether a command's words pass a credential: a credential-named flag (`--api-key x`,
 * `--password=x`), an attached `-p` password, a `-u user:password`, a credential header,
 * a `KEY=value` assignment with a credential name, or credential-shaped text.
 */
function passesCredential(words: string[]): boolean {
  return words.some((word, index) => {
    const next = words[index + 1] ?? "";
    const flag = /^--?([A-Za-z][\w.-]*)(?:=(.*))?$/s.exec(word);
    if (flag) {
      const [, name, attached] = flag;
      const value = attached ?? next;
      if (name!.length > 1 && isCredentialKey(name!)) return true;
      if (/^(?:H|header)$/.test(name!)) return isCredentialHeader(value);
      if (/^(?:u|user)$/.test(name!)) return value.includes(":");
    }
    if (/^-H./s.test(word) && isCredentialHeader(word.slice(2))) return true;
    // An attached password, as in `mysql -pS3cret`; letters alone are bundled flags like `-pv`.
    if (/^-p(?=.*[^A-Za-z])(?!\d+$)./s.test(word)) return true;
    const assignment = /^([A-Za-z_][\w.-]*)=/.exec(word);
    if (assignment && isCredentialKey(assignment[1]!)) return true;
    return isCredentialHeader(word) || maskCredentialText(word) !== word;
  });
}

/**
 * Hides every argument of a command that passes a credential, since a flag and its value may
 * sit in separate words that are masked one at a time. Only the executable's name stays.
 */
function redactCommandArgs(args: Record<string, unknown>): Record<string, unknown> {
  const commands = Object.entries(args).filter(([key]) => COMMAND_KEYS.has(key.toLowerCase()));
  const passes = commands.some(([, value]) => {
    if (typeof value === "string") return passesCredential(commandWords(value));
    if (!Array.isArray(value)) return false;
    const items = value.filter((item): item is string => typeof item === "string");
    // An item may hold a whole flag and value, or a nested command line such as `bash -c '...'`.
    return passesCredential(items) || items.some((item) => passesCredential(commandWords(item)));
  });
  if (!passes) return args;
  const redacted = { ...args };
  for (const [key, value] of commands) {
    const words =
      typeof value === "string"
        ? commandWords(value)
        : Array.isArray(value)
          ? value.filter((item): item is string => typeof item === "string")
          : [];
    const executable = /^(?:command|cmd)$/i.test(key)
      ? words
          .find((word) => !/^[A-Za-z_][\w.-]*=/.test(word))
          ?.split("/")
          .at(-1)
      : undefined;
    redacted[key] =
      executable && !executable.startsWith("-")
        ? `${maskCredentialText(executable)}${words.length > 1 ? ` ${ARGS_REDACTED}` : ""}`
        : ARGS_REDACTED;
  }
  return redacted;
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
 * One redacted line of `key: value` pairs, at most RUN_TOOL_SUMMARY_MAX_CHARS long. A command
 * that passes a credential keeps only its executable's name; other credentials are masked by key
 * and shape, then by the run's registered secrets, before the line is clipped.
 */
export function summarizeToolArgs(
  args: Record<string, unknown>,
  redact: (text: string) => string,
): string {
  return clipRedacted(
    Object.entries(redactCommandArgs(args))
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
  // Calls that finished before their start was reported, as a resumed call may.
  const finishedUnstarted: TrackedCall[] = [];
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
      // The first start after such a finish is either that call's queued start or a later call
      // reusing the id; the call's own start repeats its arguments.
      const finishedIndex = find(finishedUnstarted, call.executionId, call.name);
      if (finishedIndex >= 0) {
        const [finished] = finishedUnstarted.splice(finishedIndex, 1);
        if (finished!.entry.summary === summary) return;
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
      // A resumed call may finish before its start is reported, and an answered interaction is
      // never started, so the start that follows pairs only when its arguments match.
      const unstartedIndex = unstarted.indexOf(tracked);
      if (known && unstartedIndex >= 0) {
        unstarted.splice(unstartedIndex, 1);
        finishedUnstarted.push(tracked);
      }
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
