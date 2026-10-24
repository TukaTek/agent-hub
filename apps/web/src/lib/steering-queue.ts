import type { ProductEvent } from "@cortexai-agent-hub/contracts";

/** A message this tab sent into a running turn that the run has not claimed yet. */
export type QueuedSteer = { threadKey: string; seq: number; text: string };
type SteerQueue = readonly QueuedSteer[];

/** `claimedThrough` is the thread's latest claim watermark, which can beat the send's reply. */
export function queueSteer(queue: SteerQueue, entry: QueuedSteer, claimedThrough = 0): SteerQueue {
  return entry.seq < claimedThrough ||
    queue.some((item) => item.threadKey === entry.threadKey && item.seq === entry.seq)
    ? queue
    : [...queue, entry];
}

/** The claim watermark an event carries, if it is a steering claim. */
export function steeringClaimWatermark(event: Pick<ProductEvent, "type" | "payload">) {
  const watermark = event.payload.nextMessageSeq;
  return event.type === "run.steering.claimed" && typeof watermark === "number"
    ? watermark
    : undefined;
}

export function clearSteerQueue(queue: SteerQueue, threadKey: string): SteerQueue {
  return queue.some((item) => item.threadKey === threadKey)
    ? queue.filter((item) => item.threadKey !== threadKey)
    : queue;
}

/**
 * A claim covers every steering message below its sequence watermark. Stop and failure drop
 * pending steering server-side, so the thread's sends become plain messages.
 */
export function settleSteerQueue(
  queue: SteerQueue,
  threadKey: string,
  event: Pick<ProductEvent, "type" | "payload">,
): SteerQueue {
  if (event.type === "run.cancelled" || event.type === "run.failed") {
    return clearSteerQueue(queue, threadKey);
  }
  const watermark = steeringClaimWatermark(event);
  if (watermark === undefined) return queue;
  return queue.some((item) => item.threadKey === threadKey && item.seq < watermark)
    ? queue.filter((item) => item.threadKey !== threadKey || item.seq >= watermark)
    : queue;
}

/** Queued sends for the open thread; an idle thread has nothing left to steer. */
export function visibleSteers(
  queue: SteerQueue,
  threadKey: string | undefined,
  active: boolean,
): QueuedSteer[] {
  if (!threadKey || !active) return [];
  return queue.filter((item) => item.threadKey === threadKey);
}
