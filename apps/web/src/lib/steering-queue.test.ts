import type { ThreadSnapshot } from "@cortexai-agent-hub/contracts";
import { describe, expect, it } from "vitest";
import {
  clearSteerQueue,
  queueSteer,
  reconcileSteerQueue,
  settleSteerQueue,
  visibleSteers,
  withoutQueuedSteers,
} from "./steering-queue";

const first = {
  threadKey: "bot-1",
  runId: "run-1",
  messageId: "msg-4",
  seq: 4,
  text: "Use the newer report",
};
const second = { ...first, messageId: "msg-6", seq: 6, text: "Keep it short" };
const other = { threadKey: "bot-2", runId: "run-2", messageId: "msg-5", seq: 5, text: "Elsewhere" };
const receipt = { steerableRunIds: new Set(["run-1"]), endedRunIds: new Set<string>() };

describe("steering queue", () => {
  it("adds each sent message once", () => {
    expect(queueSteer(queueSteer([], first, receipt), first, receipt)).toEqual([first]);
    expect(queueSteer([first], second, receipt)).toEqual([first, second]);
  });

  it("skips a send the run claimed before the send returned", () => {
    expect(queueSteer([], first, { ...receipt, claimedThrough: 5 })).toEqual([]);
    expect(queueSteer([], first, { ...receipt, claimedThrough: 4 })).toEqual([first]);
  });

  it("skips a send whose run ended or was cancelled before the send returned", () => {
    const queue = [other];
    expect(queueSteer(queue, first, { ...receipt, endedRunIds: new Set(["run-1"]) })).toBe(queue);
  });

  it("skips a send the server started a new run for", () => {
    // The turn finished during the upload, so the reply names a run that was not working at send.
    const queue = [other];
    const fresh = { ...first, runId: "run-3" };
    expect(queueSteer(queue, fresh, receipt)).toBe(queue);
  });

  it("clears messages the run claimed, by the claim's sequence watermark", () => {
    const queue = [first, second, other];
    const claimed = settleSteerQueue(queue, "bot-1", {
      type: "run.steering.claimed",
      payload: { steeringIds: ["steer-1"], nextMessageSeq: 5 },
    });
    expect(claimed).toEqual([second, other]);
    expect(
      settleSteerQueue(claimed, "bot-1", {
        type: "run.steering.claimed",
        payload: { steeringIds: ["steer-2"], nextMessageSeq: 7 },
      }),
    ).toEqual([other]);
  });

  it("ignores a claim without a watermark", () => {
    const queue = [first];
    expect(settleSteerQueue(queue, "bot-1", { type: "run.steering.claimed", payload: {} })).toBe(
      queue,
    );
  });

  it("clears the thread when its run is cancelled or fails", () => {
    for (const type of ["run.cancelled", "run.failed"] as const) {
      expect(settleSteerQueue([first, other], "bot-1", { type, payload: {} })).toEqual([other]);
    }
  });

  it("clears the thread when its conversation is cleared", () => {
    expect(
      settleSteerQueue([first, second, other], "bot-1", { type: "thread.cleared", payload: {} }),
    ).toEqual([other]);
  });

  it("keeps the queue for unrelated events", () => {
    const queue = [first];
    for (const type of ["run.completed", "run.started", "thread.message.created"] as const) {
      expect(settleSteerQueue(queue, "bot-1", { type, payload: {} })).toBe(queue);
    }
  });

  it("clears one thread on demand", () => {
    expect(clearSteerQueue([first, other], "bot-1")).toEqual([other]);
    const queue = [other];
    expect(clearSteerQueue(queue, "bot-1")).toBe(queue);
  });

  it("shows a thread's queue only while that thread has an active run", () => {
    expect(visibleSteers([first, other], "bot-1", true)).toEqual([first]);
    expect(visibleSteers([first, other], "bot-1", false)).toEqual([]);
    expect(visibleSteers([first], undefined, true)).toEqual([]);
  });

  describe("on opening a thread", () => {
    const running = { id: "run-1", status: "running" };
    const snapshot = (messages: Array<{ id: string; role: string }>, runs = [running]) =>
      ({ messages, run: runs[0] ?? null, activeRuns: runs }) as unknown as ThreadSnapshot;
    const sent = { id: "msg-4", role: "user" };

    it("keeps a send the running turn has not answered", () => {
      const queue = [first, other];
      const live = { id: "progress:run-1", role: "bot" };
      expect(reconcileSteerQueue(queue, "bot-1", snapshot([sent, live]))).toBe(queue);
    });

    it("drops a send the bot has replied after, since the run took it while closed", () => {
      const reply = { id: "msg-8", role: "bot" };
      expect(reconcileSteerQueue([first, other], "bot-1", snapshot([sent, reply]))).toEqual([
        other,
      ]);
    });

    it("drops sends once the thread has no running turn", () => {
      expect(reconcileSteerQueue([first, other], "bot-1", snapshot([sent], []))).toEqual([other]);
    });

    it("drops a send whose message is gone", () => {
      expect(reconcileSteerQueue([first, other], "bot-1", snapshot([]))).toEqual([other]);
    });
  });

  it("hides queued sends from the transcript by message id", () => {
    // Live messages carry the event cursor as their seq, not the message sequence the send returned.
    const messages = [
      { id: "msg-3", role: "user", seq: 3 },
      { id: "msg-4", role: "user", seq: 58 },
      { id: "msg-7", role: "bot", seq: 61 },
    ];
    expect(withoutQueuedSteers(messages, [first])).toEqual([messages[0], messages[2]]);
    expect(withoutQueuedSteers(messages, [])).toBe(messages);
  });
});
