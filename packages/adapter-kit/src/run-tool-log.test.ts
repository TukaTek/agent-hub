import { RUN_TOOL_SUMMARY_MAX_CHARS, type RunTool } from "@cortexai-agent-hub/contracts";
import { describe, expect, it } from "vitest";
import { createRunToolLog, summarizeToolArgs } from "./run-tool-log.js";

const FAKE_TOKEN = "fake-token-0123456789abcdef";
const redact = (text: string) => text.split(FAKE_TOKEN).join("[redacted]");

function fixture() {
  const records: RunTool[] = [];
  let clock = Date.parse("2026-10-24T10:00:00.000Z");
  const log = createRunToolLog({
    runId: "run-1",
    redact,
    record: (entry) => {
      records.push(entry);
    },
    now: () => new Date(clock),
  });
  return {
    log,
    records,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("summarizeToolArgs", () => {
  it("renders arguments as one short line", () => {
    expect(
      summarizeToolArgs(
        { query: "release\n  notes", limit: 5, exact: true, filter: { site: "example.test" } },
        redact,
      ),
    ).toBe('query: release notes, limit: 5, exact: true, filter: {"site":"example.test"}');
    expect(summarizeToolArgs({}, redact)).toBe("");
  });

  it("clips to the summary limit", () => {
    const summary = summarizeToolArgs({ text: "x".repeat(500) }, redact);
    expect(summary).toHaveLength(RUN_TOOL_SUMMARY_MAX_CHARS);
    expect(summary.endsWith("…")).toBe(true);
  });

  it("does not split a surrogate pair when clipping", () => {
    const summary = summarizeToolArgs({ t: `${"x".repeat(195)}😀😀😀` }, redact);
    expect(summary.length).toBeLessThanOrEqual(RUN_TOOL_SUMMARY_MAX_CHARS);
    expect(() => encodeURIComponent(summary)).not.toThrow();
  });

  it("redacts a secret anywhere in the arguments, including past the clip", () => {
    const summary = summarizeToolArgs(
      {
        url: `https://api.example.test/?key=${FAKE_TOKEN}`,
        headers: { authorization: `Bearer ${FAKE_TOKEN}` },
        [FAKE_TOKEN]: "as a key",
      },
      redact,
    );
    expect(summary).not.toContain(FAKE_TOKEN);
    expect(summary).toContain("[redacted]");
    // A secret that starts just before the clip must not leak a prefix.
    const clipped = summarizeToolArgs({ text: `${"x".repeat(185)}${FAKE_TOKEN}` }, redact);
    expect(clipped).not.toContain(FAKE_TOKEN.slice(0, 8));
  });
});

describe("createRunToolLog", () => {
  it("records running then done with timestamps", async () => {
    const { log, records, advance } = fixture();
    await log.started({ name: "web_search", args: { query: "weather" }, executionId: "call-1" });
    advance(1_500);
    await log.finished({ name: "web_search", executionId: "call-1", outcome: "succeeded" });
    expect(records).toEqual([
      {
        runId: "run-1",
        callId: "call-1",
        tool: "web_search",
        summary: "query: weather",
        status: "running",
        startedAt: "2026-10-24T10:00:00.000Z",
        endedAt: null,
      },
      {
        runId: "run-1",
        callId: "call-1",
        tool: "web_search",
        summary: "query: weather",
        status: "done",
        startedAt: "2026-10-24T10:00:00.000Z",
        endedAt: "2026-10-24T10:00:01.500Z",
      },
    ]);
  });

  it("records a failure with a redacted, clipped reason", async () => {
    const { log, records } = fixture();
    await log.started({ name: "mcp.fetch", args: { token: FAKE_TOKEN }, executionId: "call-1" });
    await log.finished({
      name: "mcp.fetch",
      executionId: "call-1",
      outcome: "error",
      error: `401 for ${FAKE_TOKEN} ${"y".repeat(400)}`,
    });
    const failed = records.at(-1)!;
    expect(failed.status).toBe("failed");
    expect(failed.error!.length).toBeLessThanOrEqual(RUN_TOOL_SUMMARY_MAX_CHARS);
    expect(JSON.stringify(records)).not.toContain(FAKE_TOKEN);
  });

  it("keeps a paused call running", async () => {
    const { log, records } = fixture();
    await log.started({ name: "send_email", args: {}, executionId: "call-1" });
    await log.finished({ name: "send_email", executionId: "call-1", outcome: "paused" });
    expect(records.map((entry) => entry.status)).toEqual(["running"]);
  });

  it("handles a completion that arrives before its start event", async () => {
    const { log, records, advance } = fixture();
    advance(2_000);
    await log.finished({
      name: "read_file",
      executionId: "call-1",
      outcome: "succeeded",
      durationMs: 400,
    });
    await log.started({ name: "read_file", args: { path: "notes.txt" }, executionId: "call-1" });
    expect(records.map((entry) => [entry.status, entry.summary, entry.startedAt])).toEqual([
      ["done", "", "2026-10-24T10:00:01.600Z"],
      ["done", "path: notes.txt", "2026-10-24T10:00:01.600Z"],
    ]);
  });

  it("records each call once even when the start is reported twice", async () => {
    const { log, records } = fixture();
    const call = { name: "list_files", args: { path: "" }, executionId: "call-1" };
    await log.started(call);
    await log.started(call);
    expect(records).toHaveLength(1);
  });

  it("keeps calls separate by call id", async () => {
    const { log, records } = fixture();
    await log.started({ name: "web_search", args: { q: "a" }, executionId: "call-1" });
    await log.started({ name: "web_search", args: { q: "b" }, executionId: "call-2" });
    await log.finished({ name: "web_search", executionId: "call-2", outcome: "error" });
    await log.finished({ name: "web_search", executionId: "call-1", outcome: "succeeded" });
    expect(records.map((entry) => `${entry.callId}:${entry.status}`)).toEqual([
      "call-1:running",
      "call-2:running",
      "call-2:failed",
      "call-1:done",
    ]);
  });
});
