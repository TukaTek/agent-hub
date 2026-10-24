import { describe, expect, it } from "vitest";
import {
  foldRunTools,
  ProductEventType,
  RUN_TOOL_SUMMARY_MAX_CHARS,
  type RunTool,
  RunToolSchema,
} from "./events.js";

describe("run tool log", () => {
  const call = (
    callId: string,
    status: RunTool["status"],
    startedAt = "2026-10-24T10:00:00.000Z",
  ): RunTool => ({
    runId: "run-1",
    callId,
    tool: "web_search",
    summary: `query: ${callId}`,
    status,
    startedAt,
    endedAt: status === "running" ? null : "2026-10-24T10:00:02.000Z",
  });

  it("is a product event with a bounded summary", () => {
    expect(ProductEventType.parse("run.tool")).toBe("run.tool");
    expect(RunToolSchema.parse(call("a", "done"))).toEqual(call("a", "done"));
    expect(
      RunToolSchema.safeParse({
        ...call("a", "done"),
        summary: "x".repeat(RUN_TOOL_SUMMARY_MAX_CHARS + 1),
      }).success,
    ).toBe(false);
    expect(RunToolSchema.safeParse({ ...call("a", "done"), status: "paused" }).success).toBe(false);
  });

  it("keeps one entry per call in start order with its latest state", () => {
    expect(
      foldRunTools([
        call("a", "running"),
        call("b", "running"),
        call("b", "failed"),
        call("a", "done"),
      ]).map((entry) => `${entry.callId}:${entry.status}`),
    ).toEqual(["a:done", "b:failed"]);
  });

  it("never lets a late running event reopen a finished call", () => {
    expect(
      foldRunTools([call("a", "done"), call("a", "running")]).map((entry) => entry.status),
    ).toEqual(["done"]);
  });

  it("keeps the earliest start when a resumed attempt finishes the call", () => {
    const [entry] = foldRunTools([
      call("a", "running", "2026-10-24T10:00:00.000Z"),
      call("a", "done", "2026-10-24T10:05:00.000Z"),
    ]);
    expect(entry).toMatchObject({ status: "done", startedAt: "2026-10-24T10:00:00.000Z" });
  });
});
