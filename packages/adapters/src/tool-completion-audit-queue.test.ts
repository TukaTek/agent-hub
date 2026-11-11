import { RunHistoryWriteError } from "@cortexai-agent-hub/db";
import { createLogger, createTestSink, installLogger } from "@cortexai-agent-hub/logging";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendToolCompletionAudit } from "./tool-completion-audit.js";
import {
  createToolCompletionAuditQueue,
  isTransactionNeverStarted,
  TOOL_COMPLETION_AUDIT_PROCESS_CONCURRENCY,
  TOOL_COMPLETION_AUDIT_QUEUE_CAPACITY,
} from "./tool-completion-audit-queue.js";

const NEVER_STARTED = Object.assign(
  new Error("Transaction API error: Unable to start a transaction in the given time."),
  { code: "P2028" },
);
const EXPIRED = Object.assign(
  new Error(
    "Transaction API error: Transaction already closed: A query cannot be executed on an expired transaction. The timeout for this transaction was 5000 ms, however 5012 ms passed since the start of the transaction.",
  ),
  { code: "P2028" },
);

type AppendInput = { runId?: string; payload: Record<string, unknown> };

function target(runId: string) {
  return { spaceId: "test-fake-space", threadId: `test-fake-thread-${runId}`, botId: "b", runId };
}

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

function payloads(append: ReturnType<typeof vi.fn>) {
  return append.mock.calls.map((call) => (call[0] as AppendInput).payload);
}

describe("tool completion audit queue", () => {
  let sink: ReturnType<typeof createTestSink>;
  const noSleep = vi.fn(async (_ms: number) => undefined);
  const warnings = () =>
    sink.events.filter((event) => event.message === "agent tool completion audit append failed");

  beforeEach(() => {
    sink = createTestSink();
    installLogger(createLogger({ service: "test", sinks: [sink] }));
    noSleep.mockClear();
  });

  afterEach(() => {
    installLogger(createLogger({ service: "test", level: "off", sinks: [] }));
  });

  it("bounds in-flight appends per process and per run while keeping each run's order", async () => {
    const queue = createToolCompletionAuditQueue({ sleep: noSleep });
    let inFlight = 0;
    let maxInFlight = 0;
    let maxPerRun = 0;
    const perRun = new Map<string, number>();
    const appended = new Map<string, string[]>();
    const append = vi.fn(async (input: AppendInput) => {
      const runId = input.runId!;
      inFlight += 1;
      perRun.set(runId, (perRun.get(runId) ?? 0) + 1);
      maxInFlight = Math.max(maxInFlight, inFlight);
      maxPerRun = Math.max(maxPerRun, perRun.get(runId)!);
      await new Promise((resolve) => setTimeout(resolve, 1));
      appended.set(runId, [...(appended.get(runId) ?? []), String(input.payload.executionId)]);
      perRun.set(runId, perRun.get(runId)! - 1);
      inFlight -= 1;
      return {} as never;
    });

    const enqueued = new Map<string, string[]>();
    await Promise.all(
      Array.from({ length: 20 }, (_, index) => {
        const runId = `test-fake-run-${index % 5}`;
        const executionId = `test-fake-call-${index}`;
        enqueued.set(runId, [...(enqueued.get(runId) ?? []), executionId]);
        return appendToolCompletionAudit({ events: { append }, auditQueue: queue }, target(runId), {
          name: "shell",
          executionId,
          durationMs: 1,
        });
      }),
    );

    expect(append).toHaveBeenCalledTimes(20);
    expect(maxInFlight).toBe(TOOL_COMPLETION_AUDIT_PROCESS_CONCURRENCY);
    expect(maxPerRun).toBe(1);
    expect(appended).toEqual(enqueued);
    expect(warnings()).toEqual([]);
  });

  it("refuses audits beyond the pending capacity without blocking or calling append", async () => {
    const queue = createToolCompletionAuditQueue({ sleep: noSleep });
    const release = gate();
    const append = vi.fn(async (_input: AppendInput) => {
      await release.opened;
      return {} as never;
    });
    const audit = (index: number) =>
      appendToolCompletionAudit(
        { events: { append }, auditQueue: queue },
        target(`test-fake-run-${index % 4}`),
        { name: "shell", executionId: `test-fake-call-${index}`, durationMs: 1 },
      );

    // Two start immediately, the next 32 wait, and three more overflow.
    const accepted = Array.from(
      { length: TOOL_COMPLETION_AUDIT_PROCESS_CONCURRENCY + TOOL_COMPLETION_AUDIT_QUEUE_CAPACITY },
      (_, index) => audit(index),
    );
    const overflow = [accepted.length, accepted.length + 1, accepted.length + 2];
    await Promise.all(overflow.map(audit));

    expect(warnings()).toHaveLength(3);
    for (const warning of warnings()) {
      expect(warning).toMatchObject({ reason: "queue_overflow", attempts: 0 });
      expect(warning).not.toHaveProperty(["error.detail"]);
    }
    release.open();
    await Promise.all(accepted);
    expect(append).toHaveBeenCalledTimes(accepted.length);
    const appendedIds = payloads(append).map((payload) => payload.executionId);
    for (const index of overflow) expect(appendedIds).not.toContain(`test-fake-call-${index}`);
  });

  it("retries a transaction that never started with jittered backoff", async () => {
    const sleep = vi.fn(async (_ms: number) => undefined);
    const queue = createToolCompletionAuditQueue({ sleep, random: () => 0.5 });
    const append = vi
      .fn()
      .mockRejectedValueOnce(NEVER_STARTED)
      .mockRejectedValueOnce(NEVER_STARTED)
      .mockResolvedValueOnce({});

    await appendToolCompletionAudit(
      { events: { append }, auditQueue: queue },
      target("test-fake-run-1"),
      { name: "shell", executionId: "test-fake-call-1", durationMs: 1 },
    );

    expect(append).toHaveBeenCalledTimes(3);
    // Full jitter: random * min(cap, base * 2^(retry - 1)).
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([125, 250]);
    expect(warnings()).toEqual([]);
  });

  it("reuses one auditId across retries of the same completion", async () => {
    const queue = createToolCompletionAuditQueue({ sleep: noSleep });
    const append = vi.fn().mockRejectedValueOnce(NEVER_STARTED).mockResolvedValueOnce({});

    await appendToolCompletionAudit(
      { events: { append }, auditQueue: queue },
      target("test-fake-run-1"),
      { name: "shell", executionId: "test-fake-call-1", durationMs: 1 },
    );

    const [first, retry] = payloads(append);
    expect(first?.auditId).toEqual(expect.any(String));
    expect(first?.auditId).not.toBe("");
    expect(retry?.auditId).toBe(first?.auditId);
  });

  it("warns retries_exhausted after three never-started attempts", async () => {
    const queue = createToolCompletionAuditQueue({ sleep: noSleep });
    const append = vi.fn().mockRejectedValue(NEVER_STARTED);

    await expect(
      appendToolCompletionAudit(
        { events: { append }, auditQueue: queue },
        target("test-fake-run-1"),
        { name: "shell", executionId: "test-fake-call-1", durationMs: 1 },
      ),
    ).resolves.toBeUndefined();

    expect(append).toHaveBeenCalledTimes(3);
    expect(warnings()).toEqual([
      expect.objectContaining({
        reason: "retries_exhausted",
        attempts: 3,
        executionId: "test-fake-call-1",
        "error.detail": expect.stringContaining("Unable to start a transaction"),
      }),
    ]);
  });

  it("does not retry a transaction that expired after it started", async () => {
    const queue = createToolCompletionAuditQueue({ sleep: noSleep });
    const append = vi.fn().mockRejectedValue(EXPIRED);

    await appendToolCompletionAudit(
      { events: { append }, auditQueue: queue },
      target("test-fake-run-1"),
      { name: "shell", executionId: "test-fake-call-1", durationMs: 1 },
    );

    expect(append).toHaveBeenCalledOnce();
    expect(noSleep).not.toHaveBeenCalled();
    expect(warnings()).toEqual([expect.objectContaining({ reason: "nonretryable", attempts: 1 })]);
  });

  it("keeps a cancelled run's audit quiet and unretried", async () => {
    const queue = createToolCompletionAuditQueue({ sleep: noSleep });
    const append = vi.fn().mockRejectedValue(new RunHistoryWriteError());

    await appendToolCompletionAudit(
      { events: { append }, auditQueue: queue },
      target("test-fake-run-1"),
      { name: "shell", executionId: "test-fake-call-1", durationMs: 1 },
    );

    expect(append).toHaveBeenCalledOnce();
    expect(sink.events).toEqual([]);
  });

  it("records a paused completion and its resumed completion separately", async () => {
    // Turn checkpoints resume under the same run and re-execute the same call,
    // so one executionId legitimately completes twice (paused, then final).
    const queue = createToolCompletionAuditQueue({ sleep: noSleep });
    const append = vi.fn().mockResolvedValue({});
    const audit = (paused: boolean) =>
      appendToolCompletionAudit(
        { events: { append }, auditQueue: queue },
        target("test-fake-run-1"),
        { name: "shell", executionId: "test-fake-call-1", durationMs: 1, paused },
      );

    await Promise.all([audit(true), audit(false)]);

    const [paused, resumed] = payloads(append);
    expect(append).toHaveBeenCalledTimes(2);
    expect(paused).toMatchObject({ executionId: "test-fake-call-1", outcome: "paused" });
    expect(resumed).toMatchObject({ executionId: "test-fake-call-1", outcome: "succeeded" });
    expect(paused?.auditId).not.toBe(resumed?.auditId);
  });

  it("gives up on an audit that waited too long for a slot", async () => {
    const queue = createToolCompletionAuditQueue({ sleep: noSleep, waitMs: 5 });
    const release = gate();
    const append = vi.fn(async (_input: AppendInput) => {
      await release.opened;
      return {} as never;
    });
    const audit = (index: number) =>
      appendToolCompletionAudit(
        { events: { append }, auditQueue: queue },
        target(`test-fake-run-${index}`),
        { name: "shell", executionId: `test-fake-call-${index}`, durationMs: 1 },
      );

    const started = [audit(1), audit(2)];
    await audit(3);

    expect(warnings()).toEqual([
      expect.objectContaining({
        reason: "queue_timeout",
        attempts: 0,
        executionId: "test-fake-call-3",
      }),
    ]);
    release.open();
    await Promise.all(started);
    expect(append).toHaveBeenCalledTimes(2);
  });

  it("drains in-flight audits on shutdown and reports what it had to abandon", async () => {
    const queue = createToolCompletionAuditQueue({ sleep: noSleep, processConcurrency: 1 });
    const release = gate();
    const append = vi.fn(async (_input: AppendInput) => {
      await release.opened;
      return {} as never;
    });
    const audit = (index: number) =>
      appendToolCompletionAudit(
        { events: { append }, auditQueue: queue },
        target(`test-fake-run-${index}`),
        { name: "shell", executionId: `test-fake-call-${index}`, durationMs: 1 },
      );
    const first = audit(1);
    const waiting = audit(2);

    await expect(queue.drain(5)).resolves.toEqual({ abandoned: 1 });
    await waiting;
    expect(warnings()).toEqual([
      expect.objectContaining({ reason: "queue_timeout", executionId: "test-fake-call-2" }),
    ]);
    release.open();
    await first;
    await expect(queue.drain(5)).resolves.toEqual({ abandoned: 0 });
    expect(append).toHaveBeenCalledOnce();
  });
});

describe("isTransactionNeverStarted", () => {
  it("accepts only a transaction that never acquired a connection", () => {
    expect(isTransactionNeverStarted(NEVER_STARTED)).toBe(true);
    expect(
      isTransactionNeverStarted(
        new Error("outer", { cause: new Error("timeout exceeded when trying to connect") }),
      ),
    ).toBe(true);
    expect(isTransactionNeverStarted(EXPIRED)).toBe(false);
    expect(
      isTransactionNeverStarted(
        Object.assign(new Error("Unable to start a transaction in the given time"), {
          code: "P2034",
        }),
      ),
    ).toBe(false);
    expect(isTransactionNeverStarted(new Error("database unavailable"))).toBe(false);
    expect(isTransactionNeverStarted(new RunHistoryWriteError())).toBe(false);
  });
});
