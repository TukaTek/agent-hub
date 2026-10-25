import {
  foldRunTools,
  RUN_TOOL_SUMMARY_MAX_CHARS,
  type RunTool,
} from "@cortexai-agent-hub/contracts";
import { describe, expect, it } from "vitest";
import { createRunToolLog, summarizeToolArgs } from "./run-tool-log.js";

const FAKE_TOKEN = "fake-token-0123456789abcdef";
const redact = (text: string) => text.split(FAKE_TOKEN).join("[redacted]");

function fixture() {
  const records: RunTool[] = [];
  let clock = Date.parse("2026-10-24T10:00:00.000Z");
  const log = createRunToolLog({
    runId: "run-1",
    attemptId: "attempt-1",
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

  // None of these markers is a registered run secret, so only the summary's own masking hides them.
  it("masks credentials the run never registered, by key and by shape", () => {
    const keyed = {
      env: { GITHUB_PAT: "fake-unregistered-pat-001", LOG_LEVEL: "fake-env-value-002" },
      headers: { "X-Custom": "fake-header-value-003" },
      apiKey: "fake-api-key-004",
      client_secret: "fake-client-secret-005",
      password: "fake-password-006",
      accessToken: "fake-access-token-007",
      private_key: "fake-private-key-008",
      auth: { user: "fixture", pass: "fake-nested-auth-009" },
    };
    const shaped = {
      note: `use ghp_${"F".repeat(36)} or github_pat_${"A1b2".repeat(6)}`,
      command: "GITHUB_TOKEN=fake-inline-token-010 gh api user",
      url: "https://fixture:fake-url-password-011@git.example.test/repo.git",
      header: `Authorization: Bearer ${"Zx9".repeat(8)}`,
      blob: "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8",
    };
    const markers = [
      ...Object.values(keyed).flatMap((value) =>
        typeof value === "string" ? [value] : Object.values(value),
      ),
      "fake-inline-token-010",
      "fake-url-password-011",
      "F".repeat(36),
      "A1b2A1b2",
      "Zx9Zx9",
      "a1B2c3D4e5F6",
    ].filter((marker) => marker !== "fixture");
    // One argument per summary, so no marker hides past the clip.
    for (const [key, value] of Object.entries({ ...keyed, ...shaped })) {
      const summary = summarizeToolArgs({ [key]: value }, (text) => text);
      expect(summary.length).toBeLessThan(RUN_TOOL_SUMMARY_MAX_CHARS);
      for (const marker of markers) expect(summary).not.toContain(marker);
    }
    // Ordinary arguments, and the names of masked keys, stay readable.
    const summary = summarizeToolArgs(
      { name: "github", path: "notes/pat.txt", env: keyed.env },
      (text) => text,
    );
    expect(summary).toMatch(/^name: github, path: notes\/pat\.txt, env: .*GITHUB_PAT/);
  });

  it("keeps ordinary values readable", () => {
    const args = {
      commit: "0123456789abcdef0123456789abcdef01234567",
      id: "123e4567-e89b-12d3-a456-426614174000",
      path: "src/key-value/PathResolver.ts",
      query: "which key opens the deploy settings?",
      max_results: 5,
    };
    expect(summarizeToolArgs(args, (text) => text)).toBe(
      Object.entries(args)
        .map(([key, value]) => `${key}: ${value}`)
        .join(", "),
    );
  });

  it("masks a credential that straddles the clip before clipping", () => {
    const summary = summarizeToolArgs(
      { text: "x".repeat(160), env: { GITHUB_PAT: "fake-unregistered-pat-001" } },
      (text) => text,
    );
    expect(summary).not.toContain("fake-unr");
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
        callId: "attempt-1:1",
        tool: "web_search",
        summary: "query: weather",
        status: "running",
        startedAt: "2026-10-24T10:00:00.000Z",
        endedAt: null,
      },
      {
        runId: "run-1",
        callId: "attempt-1:1",
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

  it("masks an unregistered credential in failure text", async () => {
    const { log, records } = fixture();
    await log.finished({
      name: "add_mcp_server",
      executionId: "call-1",
      outcome: "error",
      error: "spawn failed: GITHUB_PAT=fake-unregistered-pat-001 rejected",
    });
    expect(records.at(-1)!.error).toBe("spawn failed: GITHUB_PAT=[redacted] rejected");
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
      ["running", "", "2026-10-24T10:00:01.600Z"],
      ["done", "", "2026-10-24T10:00:01.600Z"],
      ["done", "path: notes.txt", "2026-10-24T10:00:01.600Z"],
    ]);
  });

  it("keeps calls apart when a provider reuses a call id", async () => {
    const { log, records } = fixture();
    await log.started({ name: "web_search", args: { q: "a" }, executionId: "call_0" });
    await log.finished({ name: "web_search", executionId: "call_0", outcome: "succeeded" });
    await log.started({ name: "read_file", args: { path: "b.txt" }, executionId: "call_0" });
    await log.finished({ name: "read_file", executionId: "call_0", outcome: "error", error: "no" });
    await log.started({ name: "web_search", args: { q: "c" }, executionId: "call_0" });
    await log.finished({ name: "web_search", executionId: "call_0", outcome: "succeeded" });
    expect(foldRunTools(records).map((entry) => [entry.tool, entry.summary, entry.status])).toEqual(
      [
        ["web_search", "q: a", "done"],
        ["read_file", "path: b.txt", "failed"],
        ["web_search", "q: c", "done"],
      ],
    );
    expect(new Set(records.map((entry) => entry.callId)).size).toBe(3);
  });

  it("pairs reused call ids in order when completions arrive before starts", async () => {
    const { log, records } = fixture();
    await log.finished({ name: "read_file", executionId: "call_0", outcome: "succeeded" });
    await log.finished({ name: "read_file", executionId: "call_0", outcome: "error", error: "no" });
    await log.started({ name: "read_file", args: { path: "a.txt" }, executionId: "call_0" });
    await log.started({ name: "read_file", args: { path: "b.txt" }, executionId: "call_0" });
    expect(foldRunTools(records).map((entry) => [entry.summary, entry.status])).toEqual([
      ["path: a.txt", "done"],
      ["path: b.txt", "failed"],
    ]);
  });

  it("lets the resumed attempt finish a paused call's own entry", async () => {
    const first = fixture();
    await first.log.started({ name: "ask_user", args: { question: "Which?" }, executionId: "q" });
    await first.log.finished({ name: "ask_user", executionId: "q", outcome: "paused" });
    const pending = await first.log.pending("q", "ask_user");

    const records: RunTool[] = [];
    const resumed = createRunToolLog({
      runId: "run-1",
      attemptId: "attempt-2",
      redact,
      record: (entry) => {
        records.push(entry);
      },
    });
    resumed.resume(pending);
    // An interaction's answer completes it without a start report.
    await resumed.finished({ name: "ask_user", executionId: "q", outcome: "succeeded" });
    // The provider reuses the id for a new question, which gets its own entry.
    await resumed.started({ name: "ask_user", args: { question: "Then?" }, executionId: "q" });
    expect(foldRunTools([...first.records, ...records]).map((entry) => entry.status)).toEqual([
      "done",
      "running",
    ]);
    expect(records[0]).toMatchObject({ callId: "attempt-1:1", summary: "question: Which?" });
  });

  it("logs a pausing call whose start has not been reported yet", async () => {
    const { log, records } = fixture();
    const pending = await log.pending("call-1", "request_secret");
    await log.started({ name: "request_secret", args: { label: "Code" }, executionId: "call-1" });
    expect(records.map((entry) => [entry.callId, entry.status, entry.summary])).toEqual([
      ["attempt-1:1", "running", ""],
      ["attempt-1:1", "running", "label: Code"],
    ]);
    expect(pending.entry.callId).toBe("attempt-1:1");
  });

  it("keeps calls separate by call id", async () => {
    const { log, records } = fixture();
    await log.started({ name: "web_search", args: { q: "a" }, executionId: "call-1" });
    await log.started({ name: "web_search", args: { q: "b" }, executionId: "call-2" });
    await log.finished({ name: "web_search", executionId: "call-2", outcome: "error" });
    await log.finished({ name: "web_search", executionId: "call-1", outcome: "succeeded" });
    expect(records.map((entry) => `${entry.callId}:${entry.status}`)).toEqual([
      "attempt-1:1:running",
      "attempt-1:2:running",
      "attempt-1:2:failed",
      "attempt-1:1:done",
    ]);
  });
});
