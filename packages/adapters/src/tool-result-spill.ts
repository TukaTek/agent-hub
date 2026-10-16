import { createHash } from "node:crypto";
import { shellQuote } from "@cortexai-agent-hub/core/node/desktop-runtime";
import { shortenStructuredResult } from "./context-selection.js";
import { TOOL_RESULT_TEXT_LIMIT } from "./pi-runtime-limits.js";

export const SPILL_DIRECTORY = ".cortexai/tool-results";
export const MAX_SPILL_CHARS = 2_000_000;
export const SPILL_RETENTION_DAYS = 7;
export const SPILL_MAX_FILES = 50;
/** Paged reads of a spilled result; 2M chars of UTF-8 fit with room to spare. */
export const MAX_PAGED_READ_BYTES = 8_000_000;
export const SPILL_PAGE_CHARS = 64_000;
/** JSON escaping can double a page; keep the whole read_file result under the delivery limit. */
const SPILL_PAGE_ESCAPED_CHARS = TOOL_RESULT_TEXT_LIMIT - 1_500;
const PREVIEW_SEPARATOR = "\n…\n";
const MAX_PREVIEW_TAIL = 2_000;

/** Results that already come from the computer, are superseded every step, have their own budget, or are model-written. */
export const NO_SPILL_TOOLS: ReadonlySet<string> = new Set([
  "browser_navigate",
  "browser_snapshot",
  "browser_act",
  "read_file",
  "list_files",
  "shell",
  "run_subagent",
  "skill_read",
  "read_history",
  "search_history",
  "computer_observe",
  "computer_act",
]);

export type SpillUnavailableReason = "no-computer" | "shared-computer";

export function spillUnavailableNotice(reason: SpillUnavailableReason): string {
  return reason === "shared-computer"
    ? "A full copy was not saved because this bot's computer belongs to another user."
    : "A full copy was not saved because no bot computer is available.";
}

/** Keeps internal user and space IDs out of model-visible paths. */
export function spillUserKey(spaceId: string, userId: string): string {
  return createHash("sha256").update(`${spaceId}:${userId}`).digest("hex").slice(0, 16);
}

function slug(value: string, max: number, fallback: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
  return cleaned || fallback;
}

export function spillSlug(toolName: string): string {
  return slug(toolName, 40, "result");
}

export function spillRelativePath(input: {
  userKey: string;
  runId: string;
  seq: number;
  toolName: string;
}): string {
  const seq = String(input.seq).padStart(2, "0");
  return `${SPILL_DIRECTORY}/${input.userKey}/${slug(input.runId, 64, "run")}/${seq}-${spillSlug(input.toolName)}.txt`;
}

/** The user key of a path inside any spill directory, or undefined for other paths. */
export function spillPathOwner(path: string): string | undefined {
  const segments = path
    .replace(/\\/g, "/")
    .split("/")
    .filter((segment) => segment && segment !== ".");
  for (let index = 0; index + 2 < segments.length; index++) {
    if (segments[index] === ".cortexai" && segments[index + 1] === "tool-results") {
      return segments[index + 2];
    }
  }
  return undefined;
}

/** Deletes files past retention, then keeps room for one more file under the cap. */
export function spillPruneCommand(userDirectory: string): string {
  return [
    `d=${shellQuote(userDirectory)}`,
    '[ -d "$d" ] || exit 0',
    `find "$d" -type f -mtime +${SPILL_RETENTION_DAYS - 1} -delete`,
    `ls -1t "$d"/*/*.txt 2>/dev/null | tail -n +${SPILL_MAX_FILES} | while IFS= read -r f; do rm -f "$f"; done`,
    'find "$d" -mindepth 1 -type d -empty -delete',
    "exit 0",
  ].join("; ");
}

export interface SpillReceipt {
  path: string;
  totalChars: number;
  savedChars: number;
}

export type SpillFormat = "json" | "text";

const READ_HINT = "Read it with read_file (offset, limit) or search it with shell grep -n.";
const STRUCTURED_MARKER = "[Shortened here; the full result is at fullResult.path.]";

/** The usual four characters per token; a size hint for the model, not a tokenizer. */
export function approxTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

/** Failures stay inline so the model sees the error at once instead of a file to open. */
export function isErrorToolResult(result: unknown): boolean {
  const payload =
    result &&
    typeof result === "object" &&
    (result as { kind?: unknown }).kind === "agent_tool_result"
      ? (result as { details?: unknown }).details
      : result;
  if (!payload || typeof payload !== "object") return false;
  if ((payload as { isError?: unknown }).isError === true) return true;
  const error = (payload as { error?: unknown }).error;
  return error !== undefined && error !== null;
}

/**
 * Objects keep their shape so cursors and IDs stay usable; the path survives later
 * shortening because structured shortening keeps `path` keys and numbers.
 */
export function formatStructuredSpill(
  spill: SpillReceipt,
  value: unknown,
  limit: number,
): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value) || "fullResult" in value) return;
  const fullResult = {
    path: spill.path,
    format: "json",
    totalChars: spill.totalChars,
    approxTokens: approxTokens(spill.totalChars),
    ...(spill.savedChars < spill.totalChars ? { savedChars: spill.savedChars } : {}),
    read: READ_HINT,
  };
  const encoded = shortenStructuredResult(
    JSON.stringify({ fullResult, ...value }),
    limit,
    STRUCTURED_MARKER,
  );
  return encoded && encoded.length <= limit ? encoded : undefined;
}

/** The header comes first so later context shortening, which keeps the head, keeps the path. */
export function formatSpillReceipt(
  spill: SpillReceipt,
  text: string,
  limit: number,
  format: SpillFormat = "text",
): string {
  const count = (value: number) => value.toLocaleString("en-US");
  const size = `characters (~${count(approxTokens(spill.totalChars))} tokens) of ${format === "json" ? "JSON" : "text"}`;
  const saved =
    spill.savedChars < spill.totalChars
      ? `Result saved: first ${count(spill.savedChars)} of ${count(spill.totalChars)} ${size}`
      : `Full result saved: ${count(spill.totalChars)} ${size}`;
  const header = `[${saved} at ${spill.path}. ${READ_HINT}]`;
  const available = limit - header.length - 1 - PREVIEW_SEPARATOR.length;
  if (available <= 0) return header;
  const tail = Math.min(MAX_PREVIEW_TAIL, Math.floor(available / 4));
  const head = available - tail;
  return `${header}\n${text.slice(0, head)}${PREVIEW_SEPARATOR}${tail > 0 ? text.slice(-tail) : ""}`;
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

export interface SpilledTextPage {
  offset: number;
  total_chars: number;
  next_offset?: number;
  content: string;
}

/** One random-access page. Offsets count UTF-16 code units, like the receipt's total. */
export function pageSpilledText(text: string, offset: unknown, limit: unknown): SpilledTextPage {
  const total = text.length;
  const requested = Number.isFinite(Number(offset)) ? Math.trunc(Number(offset)) : 0;
  let start = Math.min(Math.max(0, requested), total);
  if (
    start > 0 &&
    start < total &&
    isLowSurrogate(text.charCodeAt(start)) &&
    isHighSurrogate(text.charCodeAt(start - 1))
  ) {
    start -= 1;
  }
  const wanted = Number.isFinite(Number(limit)) ? Math.trunc(Number(limit)) : SPILL_PAGE_CHARS;
  let end = Math.min(total, start + Math.min(Math.max(1, wanted), SPILL_PAGE_CHARS));
  while (
    end - start > 1 &&
    JSON.stringify(text.slice(start, end)).length > SPILL_PAGE_ESCAPED_CHARS
  ) {
    end = start + Math.floor((end - start) * 0.75);
  }
  if (end < total && end - start > 1 && isHighSurrogate(text.charCodeAt(end - 1))) end -= 1;
  return {
    offset: start,
    total_chars: total,
    ...(end < total ? { next_offset: end } : {}),
    content: text.slice(start, end),
  };
}
