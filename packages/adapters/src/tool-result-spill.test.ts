import { describe, expect, it } from "vitest";
import { shortenToolResultText } from "./context-selection.js";
import { TOOL_RESULT_TEXT_LIMIT } from "./pi-runtime-limits.js";
import {
  approxTokens,
  formatSpillReceipt,
  formatStructuredSpill,
  isErrorToolResult,
  MAX_SPILL_CHARS,
  NO_SPILL_TOOLS,
  pageSpilledText,
  SPILL_MAX_FILES,
  SPILL_PAGE_CHARS,
  spillPathOwner,
  spillPruneCommand,
  spillRelativePath,
  spillSlug,
  spillUnavailableNotice,
  spillUserKey,
} from "./tool-result-spill.js";

const transcript = (chars: number) => {
  let text = "";
  for (let index = 0; text.length < chars; index++) {
    text += `[00:${String(index % 60).padStart(2, "0")}] Speaker ${index % 3}: marker-${index} café "ok" 🎙️\n`;
  }
  return text.slice(0, chars);
};

describe("formatSpillReceipt", () => {
  const path =
    "/home/cortexai-agent-hub/.cortexai/tool-results/0123456789abcdef/run-1/01-fathom.txt";

  it.each([12_000, 64_000, 100_000])(
    "stays within a %i character limit with the header first",
    (limit) => {
      const text = transcript(200_000);
      const receipt = formatSpillReceipt(
        { path, totalChars: text.length, savedChars: text.length },
        text,
        limit,
      );
      expect(receipt.length).toBeLessThanOrEqual(limit);
      const header = receipt.slice(0, receipt.indexOf("\n"));
      expect(header.length).toBeLessThanOrEqual(400);
      expect(receipt.slice(0, 512)).toContain(path);
      expect(header).toContain("200,000 characters");
      expect(header).toContain("read_file");
    },
  );

  it("previews exact head and tail slices of the result", () => {
    const text = transcript(200_000);
    const receipt = formatSpillReceipt(
      { path, totalChars: text.length, savedChars: text.length },
      text,
      12_000,
    );
    const body = receipt.slice(receipt.indexOf("\n") + 1);
    const [head, tail] = body.split("\n…\n");
    expect(head!.length).toBeGreaterThan(5_000);
    expect(tail!.length).toBeGreaterThan(0);
    expect(text.startsWith(head!)).toBe(true);
    expect(text.endsWith(tail!)).toBe(true);
  });

  it.each([1_024, 6_000])(
    "keeps the path when context shortening cuts to %i characters",
    (size) => {
      const text = transcript(200_000);
      const receipt = formatSpillReceipt(
        { path, totalChars: text.length, savedChars: text.length },
        text,
        12_000,
      );
      const shortened = shortenToolResultText(receipt, size, { name: "fathom" });
      expect(shortened.length).toBeLessThan(receipt.length);
      expect(shortened).toContain(path);
    },
  );

  it("says when only the first part was saved", () => {
    const receipt = formatSpillReceipt(
      { path, totalChars: 2_500_000, savedChars: MAX_SPILL_CHARS },
      "x".repeat(20_000),
      12_000,
    );
    expect(receipt.slice(0, receipt.indexOf("\n"))).toContain(
      "first 2,000,000 of 2,500,000 characters",
    );
  });
});

describe("receipt size and format", () => {
  const spill = { path: "/w/r.txt", totalChars: 200_000, savedChars: 200_000 };

  it("names the approximate tokens and the format", () => {
    expect(approxTokens(200_001)).toBe(50_001);
    expect(formatSpillReceipt(spill, transcript(200_000), 12_000, "json")).toMatch(
      /^\[Full result saved: 200,000 characters \(~50,000 tokens\) of JSON at \/w\/r\.txt\. /,
    );
    expect(
      formatSpillReceipt({ ...spill, savedChars: 150_000 }, transcript(200_000), 12_000),
    ).toMatch(
      /^\[Result saved: first 150,000 of 200,000 characters \(~50,000 tokens\) of text at /,
    );
  });

  it("suggests searching with grep -n before paging with read_file", () => {
    const hint = /Search it with shell grep -n first, then read only the lines you need with read_file \(offset, limit\)\./;
    const text = formatSpillReceipt(spill, transcript(200_000), 12_000);
    expect(text.slice(0, text.indexOf("\n"))).toMatch(hint);
    const structured = formatStructuredSpill(spill, { id: "m-1", t: transcript(200_000) }, 12_000)!;
    expect(JSON.parse(structured).fullResult.read).toMatch(hint);
  });

  it("recognizes error results in every shape", () => {
    expect(isErrorToolResult({ isError: true, content: [] })).toBe(true);
    expect(isErrorToolResult({ error: "boom" })).toBe(true);
    expect(
      isErrorToolResult({ kind: "agent_tool_result", content: [], details: { isError: true } }),
    ).toBe(true);
    expect(isErrorToolResult({ isError: false, content: [] })).toBe(false);
    expect(isErrorToolResult({ error: null, data: 1 })).toBe(false);
    expect(isErrorToolResult({ kind: "agent_tool_result", content: [], details: {} })).toBe(false);
    expect(isErrorToolResult("error")).toBe(false);
  });
});

describe("formatStructuredSpill", () => {
  const spill = {
    path: "/w/.cortexai/tool-results/k/r/01-x.txt",
    totalChars: 50_000,
    savedChars: 50_000,
  };

  it("keeps the object's control fields and puts the saved path first", () => {
    const value = { id: "m-1", nextCursor: "c-2", transcript: transcript(50_000) };
    const out = formatStructuredSpill(spill, value, 12_000)!;
    expect(out.length).toBeLessThanOrEqual(12_000);
    expect(out.startsWith(`{"fullResult":{"path":"${spill.path}"`)).toBe(true);
    expect(JSON.parse(out)).toMatchObject({ id: "m-1", nextCursor: "c-2", contextTruncated: true });
  });

  it("reports a capped copy", () => {
    const out = formatStructuredSpill(
      { ...spill, savedChars: 40_000 },
      { t: transcript(50_000) },
      12_000,
    )!;
    expect(JSON.parse(out).fullResult).toMatchObject({ totalChars: 50_000, savedChars: 40_000 });
  });

  it("declines arrays, strings, a colliding key and metadata that cannot fit", () => {
    expect(formatStructuredSpill(spill, [transcript(50_000)], 12_000)).toBeUndefined();
    expect(formatStructuredSpill(spill, transcript(50_000), 12_000)).toBeUndefined();
    expect(
      formatStructuredSpill(spill, { fullResult: 1, t: transcript(50_000) }, 12_000),
    ).toBeUndefined();
    expect(formatStructuredSpill(spill, { id: "x".repeat(20_000) }, 12_000)).toBeUndefined();
  });
});

describe("spill paths", () => {
  it("derives a stable per-user key that differs by user and space", () => {
    expect(spillUserKey("space-1", "user-1")).toMatch(/^[0-9a-f]{16}$/);
    expect(spillUserKey("space-1", "user-1")).toBe(spillUserKey("space-1", "user-1"));
    expect(spillUserKey("space-1", "user-2")).not.toBe(spillUserKey("space-1", "user-1"));
    expect(spillUserKey("space-2", "user-1")).not.toBe(spillUserKey("space-1", "user-1"));
  });

  it.each([
    ["../../etc/passwd", "etc-passwd"],
    ["FATHOM_GET_TRANSCRIPT", "fathom-get-transcript"],
    ["café ☕ tool", "caf-tool"],
    ["", "result"],
    ["a".repeat(200), "a".repeat(40)],
  ])("sanitizes the tool slug %j", (name, slug) => {
    expect(spillSlug(name)).toBe(slug);
  });

  it("builds the path from sanitized parts only", () => {
    expect(
      spillRelativePath({ userKey: "0123456789abcdef", runId: "run/../1", seq: 4, toolName: "x" }),
    ).toBe(".cortexai/tool-results/0123456789abcdef/run-1/04-x.txt");
  });

  it.each([
    [".cortexai/tool-results/0123456789abcdef/run-1/01-x.txt", "0123456789abcdef"],
    ["bots/bot-1/.cortexai/tool-results/0123456789abcdef", "0123456789abcdef"],
    ["/.cortexai/tool-results/fedcba9876543210/run-1", "fedcba9876543210"],
    ["./.cortexai//tool-results/fedcba9876543210/", "fedcba9876543210"],
    [".cortexai/tool-results", undefined],
    ["notes/tool-results/0123456789abcdef", undefined],
  ])("finds the owner of %j", (path, owner) => {
    expect(spillPathOwner(path)).toBe(owner);
  });

  it("prunes with a fixed quoted command that keeps the newest files", () => {
    const command = spillPruneCommand("bots/bot-1/.cortexai/tool-results/0123456789abcdef");
    expect(command).toContain("'bots/bot-1/.cortexai/tool-results/0123456789abcdef'");
    expect(command).toContain("-mtime +6");
    expect(command).toContain(`tail -n +${SPILL_MAX_FILES}`);
    expect(spillPruneCommand("a'b")).toContain(`'a'"'"'b'`);
  });
});

describe("pageSpilledText", () => {
  const text = transcript(240_000);

  it("returns exact slices at any offset and never splits a surrogate pair", () => {
    const emoji = text.indexOf("🎙");
    const inside = emoji + 1;
    for (const offset of [0, 1, 60_000, 120_000, inside, text.length - 100]) {
      const page = pageSpilledText(text, offset, 8_000);
      const start = offset === inside ? emoji : offset;
      expect(page.offset).toBe(start);
      expect(page.content).toBe(text.slice(start, start + page.content.length));
      expect(JSON.stringify(page.content)).not.toMatch(/\\ud[89a-f]/i);
      if (page.next_offset !== undefined) {
        expect(page.next_offset).toBe(start + page.content.length);
      }
    }
  });

  it("returns an empty final page at or past the end", () => {
    for (const offset of [text.length, text.length + 1]) {
      const page = pageSpilledText(text, offset, 8_000);
      expect(page).toEqual({ offset: text.length, total_chars: text.length, content: "" });
    }
  });

  it("keeps each escaped page within the model result budget", () => {
    const quotes = '"\\\n'.repeat(40_000);
    const page = pageSpilledText(quotes, 0, SPILL_PAGE_CHARS);
    expect(JSON.stringify(page).length).toBeLessThan(TOOL_RESULT_TEXT_LIMIT);
    expect(page.next_offset).toBe(page.content.length);
  });

  it("returns 64,000-character pages by default and at most", () => {
    expect(SPILL_PAGE_CHARS).toBe(64_000);
    for (const limit of [undefined, 500_000]) {
      const { content } = pageSpilledText(text, 0, limit);
      expect(content.length).toBeGreaterThanOrEqual(63_999);
      expect(content.length).toBeLessThanOrEqual(64_000);
      expect(text.startsWith(content)).toBe(true);
    }
  });

  it("reassembles the whole text by following next_offset", () => {
    let offset: number | undefined = 0;
    let joined = "";
    while (offset !== undefined) {
      const page = pageSpilledText(text, offset, 8_000);
      joined += page.content;
      offset = page.next_offset;
    }
    expect(joined).toBe(text);
  });
});

describe("spill policy constants", () => {
  it("never spills computer-sourced, page-snapshot, subagent or exact-evidence tools", () => {
    for (const name of [
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
    ]) {
      expect(NO_SPILL_TOOLS.has(name)).toBe(true);
    }
  });

  it("names why a full copy was not saved", () => {
    expect(spillUnavailableNotice("no-computer")).toBe(
      "A full copy was not saved because no bot computer is available.",
    );
    expect(spillUnavailableNotice("shared-computer")).toBe(
      "A full copy was not saved because this bot's computer belongs to another user.",
    );
  });
});
