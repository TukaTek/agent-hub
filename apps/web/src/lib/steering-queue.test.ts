import { describe, expect, it } from "vitest";
import { clearSteerQueue, queueSteer, settleSteerQueue, visibleSteers } from "./steering-queue";

const first = { threadKey: "bot-1", seq: 4, text: "Use the newer report" };
const second = { threadKey: "bot-1", seq: 6, text: "Keep it short" };
const other = { threadKey: "bot-2", seq: 5, text: "Elsewhere" };

describe("steering queue", () => {
  it("adds each sent message once", () => {
    expect(queueSteer(queueSteer([], first), first)).toEqual([first]);
    expect(queueSteer([first], second)).toEqual([first, second]);
  });

  it("skips a send the run claimed before the send returned", () => {
    expect(queueSteer([], first, 5)).toEqual([]);
    expect(queueSteer([], first, 4)).toEqual([first]);
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
});
