/**
 * Bounds how many `agent.tool.completed` audit transactions one process runs at once.
 *
 * Every audit is its own interactive transaction on the shared Prisma pool. An
 * unbounded parallel tool burst checked out more connections than the pool had
 * and failed with P2028 ("Unable to start a transaction in the given time"),
 * which also starved heartbeats, steering and finalizeRun on the same pool.
 *
 * Scope: these bounds are PER PROCESS, not fleet-wide. Each worker process has
 * its own pool and its own queue, so N workers run up to N × PROCESS_CONCURRENCY
 * audit transactions. Overflow is per process too: a full queue here refuses the
 * audit (reason `queue_overflow`) even when another worker has spare capacity.
 * Fleet-wide idempotency is the database's unique index on (runId, auditId), not
 * this queue.
 *
 * Overflow never evicts older audits (that would reorder a run's history) and
 * never blocks the caller. Scripted tools and MCP discovery-failure auditing
 * await an accepted audit until it settles (queue wait plus retries). Overflow
 * and other permanent failures never fail the run or surface as a model error:
 * they log a warning with the reason.
 */

/** Same-run audits share one threads row (nextEventSeq), so they run one at a time. */
export const TOOL_COMPLETION_AUDIT_PER_RUN_CONCURRENCY = 1;
/**
 * Chosen against the worker default DB_POOL_MAX=8: the three Graphile listeners
 * and reconciliation leadership hold about three, leaving about five for jobs.
 * Two leave room for heartbeats, steering, finalizeRun and other required writes.
 */
export const TOOL_COMPLETION_AUDIT_PROCESS_CONCURRENCY = 2;
/** Audits waiting for a slot, not counting in-flight ones. */
export const TOOL_COMPLETION_AUDIT_QUEUE_CAPACITY = 32;
export const TOOL_COMPLETION_AUDIT_QUEUE_WAIT_MS = 30_000;
/** Total attempts, including the first. */
export const TOOL_COMPLETION_AUDIT_RETRY_ATTEMPTS = 3;
export const TOOL_COMPLETION_AUDIT_RETRY_BASE_MS = 250;
export const TOOL_COMPLETION_AUDIT_RETRY_MAX_MS = 2_000;
export const TOOL_COMPLETION_AUDIT_SHUTDOWN_DRAIN_MS = 5_000;

export type ToolCompletionAuditFailureReason =
  | "queue_overflow"
  | "retries_exhausted"
  | "nonretryable"
  | "queue_timeout";

export type ToolCompletionAuditOutcome =
  | { status: "appended"; attempts: number }
  | {
      status: "failed";
      reason: ToolCompletionAuditFailureReason;
      attempts: number;
      error?: unknown;
    };

export interface ToolCompletionAuditQueue {
  /** Resolves when the audit settles; never rejects. */
  enqueue(runId: string, append: () => Promise<unknown>): Promise<ToolCompletionAuditOutcome>;
  /** Waits for queued audits, then refuses whatever is still waiting. */
  drain(timeoutMs?: number): Promise<{ abandoned: number }>;
}

export interface ToolCompletionAuditQueueOptions {
  processConcurrency?: number;
  capacity?: number;
  waitMs?: number;
  retryAttempts?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

/**
 * Only a transaction that never acquired a connection is safe to retry blindly.
 * An expired transaction (P2028 "expired transaction" / "timeout for this
 * transaction") may already have run its statements; the unique index would
 * absorb a retry, but it is still reported rather than repeated.
 */
export function isTransactionNeverStarted(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const message = current instanceof Error ? current.message : "";
    if (
      (current as { code?: unknown }).code === "P2028" &&
      message.includes("Unable to start a transaction in the given time")
    )
      return true;
    if (message.includes("timeout exceeded when trying to connect")) return true;
    current = current instanceof Error ? current.cause : undefined;
  }
  return false;
}

interface Pending {
  runId: string;
  append: () => Promise<unknown>;
  settle: (outcome: ToolCompletionAuditOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
}

export function createToolCompletionAuditQueue(
  options: ToolCompletionAuditQueueOptions = {},
): ToolCompletionAuditQueue {
  const processConcurrency =
    options.processConcurrency ?? TOOL_COMPLETION_AUDIT_PROCESS_CONCURRENCY;
  const capacity = options.capacity ?? TOOL_COMPLETION_AUDIT_QUEUE_CAPACITY;
  const waitMs = options.waitMs ?? TOOL_COMPLETION_AUDIT_QUEUE_WAIT_MS;
  const retryAttempts = options.retryAttempts ?? TOOL_COMPLETION_AUDIT_RETRY_ATTEMPTS;
  const retryBaseMs = options.retryBaseMs ?? TOOL_COMPLETION_AUDIT_RETRY_BASE_MS;
  const retryMaxMs = options.retryMaxMs ?? TOOL_COMPLETION_AUDIT_RETRY_MAX_MS;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const random = options.random ?? Math.random;

  const pending: Pending[] = [];
  const activeRuns = new Set<string>();
  const idle = new Set<() => void>();

  const settleIdle = () => {
    if (pending.length > 0 || activeRuns.size > 0) return;
    for (const resolve of idle) resolve();
    idle.clear();
  };

  async function attempt(append: () => Promise<unknown>): Promise<ToolCompletionAuditOutcome> {
    for (let attempts = 1; ; attempts += 1) {
      try {
        await append();
        return { status: "appended", attempts };
      } catch (error) {
        if (!isTransactionNeverStarted(error))
          return { status: "failed", reason: "nonretryable", attempts, error };
        if (attempts >= retryAttempts)
          return { status: "failed", reason: "retries_exhausted", attempts, error };
        await sleep(random() * Math.min(retryMaxMs, retryBaseMs * 2 ** (attempts - 1)));
      }
    }
  }

  function pump() {
    // Per-run FIFO: an item only starts once every earlier item of its run has,
    // because the scan skips (and so holds back) later items of a busy run.
    for (let index = 0; index < pending.length && activeRuns.size < processConcurrency; ) {
      const item = pending[index]!;
      if (activeRuns.has(item.runId)) {
        index += 1;
        continue;
      }
      pending.splice(index, 1);
      clearTimeout(item.timer);
      activeRuns.add(item.runId);
      void attempt(item.append)
        .catch(
          (error): ToolCompletionAuditOutcome => ({
            status: "failed",
            reason: "nonretryable",
            attempts: 1,
            error,
          }),
        )
        .then((outcome) => {
          activeRuns.delete(item.runId);
          item.settle(outcome);
          pump();
          settleIdle();
        });
    }
  }

  function refuse(item: Pending) {
    const index = pending.indexOf(item);
    if (index < 0) return false;
    pending.splice(index, 1);
    clearTimeout(item.timer);
    item.settle({ status: "failed", reason: "queue_timeout", attempts: 0 });
    return true;
  }

  return {
    enqueue(runId, append) {
      const runBusy = activeRuns.has(runId);
      if (pending.length >= capacity && (runBusy || activeRuns.size >= processConcurrency))
        return Promise.resolve({ status: "failed", reason: "queue_overflow", attempts: 0 });
      return new Promise((settle) => {
        const item: Pending = {
          runId,
          append,
          settle,
          timer: setTimeout(() => {
            refuse(item);
            settleIdle();
          }, waitMs),
        };
        item.timer.unref?.();
        pending.push(item);
        pump();
      });
    },

    async drain(timeoutMs = TOOL_COMPLETION_AUDIT_SHUTDOWN_DRAIN_MS) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        new Promise<void>((resolve) => {
          idle.add(resolve);
          settleIdle();
        }),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
        }),
      ]);
      clearTimeout(timer);
      let abandoned = 0;
      for (const item of [...pending]) if (refuse(item)) abandoned += 1;
      return { abandoned };
    },
  };
}

/** The process-wide queue every executor audit path shares. */
export const toolCompletionAuditQueue = createToolCompletionAuditQueue();
