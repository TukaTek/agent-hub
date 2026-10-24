import type { ProductEvent } from "@cortexai-agent-hub/contracts";

/** A message this tab sent into a running turn that the run has not claimed yet. */
export type QueuedSteer = {
  threadKey: string;
  runId: string;
  messageId: string;
  seq: number;
  text: string;
};
type SteerQueue = readonly QueuedSteer[];

/**
 * A send steers only when the server put it into a run that was working when it was sent; a
 * reply naming any other run means the turn ended first and the server started a new one.
 * `claimedThrough` is the thread's latest claim watermark and `endedRunIds` the runs that
 * finished, failed or were cancelled before the reply arrived.
 */
type SteerReceipt = {
  steerableRunIds: ReadonlySet<string>;
  endedRunIds: ReadonlySet<string>;
  claimedThrough?: number;
};

export function queueSteer(
  queue: SteerQueue,
  entry: QueuedSteer,
  { steerableRunIds, endedRunIds, claimedThrough = 0 }: SteerReceipt,
): SteerQueue {
  return entry.seq < claimedThrough ||
    !steerableRunIds.has(entry.runId) ||
    endedRunIds.has(entry.runId) ||
    queue.some((item) => item.messageId === entry.messageId)
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
 * pending steering server-side, so the thread's sends become plain messages; clearing the
 * conversation deletes them.
 */
export function settleSteerQueue(
  queue: SteerQueue,
  threadKey: string,
  event: Pick<ProductEvent, "type" | "payload">,
): SteerQueue {
  if (
    event.type === "run.cancelled" ||
    event.type === "run.failed" ||
    event.type === "thread.cleared"
  ) {
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

/**
 * A queued send shows above the composer until the run takes it. Match by id: a message the
 * live stream added carries the event cursor as its seq, not the message sequence.
 */
export function withoutQueuedSteers<T extends { id: string }>(
  messages: readonly T[],
  queued: readonly QueuedSteer[],
): readonly T[] {
  if (!queued.length) return messages;
  const hidden = new Set(queued.map((item) => item.messageId));
  return messages.filter((message) => !hidden.has(message.id));
}
