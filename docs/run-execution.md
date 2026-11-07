# Run dispatch and response timing

The API commits messages and runs to Postgres. `RunJobPublisher` records an optional
wake time on the run and publishes a notification through the existing realtime
connection. It does not enqueue agent execution in Graphile.

Worker processes subscribe to notifications and scan runnable rows at startup and
every five seconds. Notifications are hints: a commit without a notification, a
listener reconnect, or an expired execution lease is recovered by the scan. Workers
claim runs using the executor's existing atomic lease and fence checks. Several
claims can start concurrently; model streams and tools run independently after
durable ownership and heartbeats are established. Memory admission and graceful
shutdown are shared with legacy queue deliveries.

Runs waiting behind another run's live computer lease stay queued without repeated
claims. The recovery scan picks them up after release or expiry, while unrelated
bots can run. Execution timing starts after computer ownership is acquired.

Graphile remains responsible for scheduled and maintenance jobs. Those jobs can
create runs, which use the same direct dispatch path. Legacy run deliveries remain
supported during rolling upgrades and drain safely against the same database
claims. Pending legacy retry times are carried into the new run schedule by the
additive migration. A compatibility trigger also stamps retry backoff when an
older worker requeues after the migration; explicit new-worker schedules take
precedence. Remove that trigger only after those older releases have drained.
Embedded installations using the memory job driver retain their
existing dispatch and recovery behavior.

## Tool completion audits

Each finished tool call appends an `agent.tool.completed` event in its own
transaction. A process-wide queue (`tool-completion-audit-queue.ts`) runs these
writes so a parallel tool burst cannot take over the database pool from
heartbeats, steering and `finalizeRun`:

- At most 2 audit transactions at once per process, and 1 per run. These numbers
  assume the worker default `DB_POOL_MAX=8`, where about 3 connections are held by
  the queue listeners and leadership. The bounds are per process, not per fleet:
  N workers run up to 2N audit transactions.
- Up to 32 audits wait per process. When that queue is full, the next audit is
  refused with `reason: "queue_overflow"`, even if another worker has room. Older
  audits are never evicted. Overflow itself never blocks the caller. Scripted
  tools and MCP discovery-failure auditing await an *accepted* audit until it
  settles (up to the 30 second queue wait plus retries). An audit still waiting
  after 30 seconds, or when shutdown drains the queue (5 seconds), ends with
  `queue_timeout`.
- Only Prisma P2028 "Unable to start a transaction in the given time" (or a pg
  connect timeout) is retried: 3 attempts in total, with full-jitter backoff from
  250 ms up to 2 s. Nothing ran in that case. A transaction that expired after it
  started is not retried (`nonretryable`), and neither is any other error. When
  retries run out, the reason is `retries_exhausted`.
- Each failure logs `agent tool completion audit append failed` with `reason` and
  `attempts`. A failed audit never fails the run and is never shown as a model
  or provider error. Audits from runs that were already cancelled are still
  dropped without a log.

Each audit invocation carries a random `payload.auditId`, which every retry of
that invocation reuses. The partial unique index `events_runId_auditId_key` on
`("runId", payload->>'auditId')` is defense in depth: if two writers insert the
same invocation's `auditId` (a retry after a commit the client did not see, or
two connections racing on the same payload), the loser hits unique violation,
the transaction rolls back including its sequence number, and `appendEvent`
returns the row that already committed. Today's retry classifier only repeats a
transaction that never started, so that path normally never commits twice; the
index still makes a later classifier change or a raced insert safe.
`auditId` stays readable in encrypted payloads so the index can see it. The index
only covers `agent.tool.completed` rows with a run and a non-empty `auditId`. Rows
written before this change are outside it. The index does not mean "one row per
`executionId`": a call that pauses and later resumes in the same run completes
twice, and both audits are kept (they get different `auditId`s). Independent
invocations always get new ids, so the index does not coalesce two separate
`appendToolCompletionAudit` calls.

## Timing

Structured logs emit `run.execution_started`, `run.first_response`, and
`run.finished`. Timing fields contain durations in milliseconds:

| Field | Meaning |
| --- | --- |
| `run.pre_run_wait_ms` | Source message to run creation, including steering held behind earlier work. |
| `run.queue_wait_ms` | Run creation to its first execution start. |
| `run.first_response_ms` | Source message to first persisted visible reply text or reply card. |
| `run.total_ms` | Source message to run completion or failure. |
| `run.execution_wall_ms` | First execution start to completion, including retries and human waits. |

These are run-level measurements. Multiple steering messages can share one run;
its selected source message defines the timing origin. When a run has no source
message, its creation time is the origin. Missing start,
response, or completion timestamps omit the corresponding duration rather than
reporting zero. Use `run.trigger` and `run.outcome` to distinguish interactive,
scheduled, successful, and failed work. Use each run's first-response record for
response latency distributions and its terminal record for total duration; do not
mix timing fields repeated on different lifecycle events as independent samples.

The first response timestamp is persisted in the same transaction as its output
and is preserved across attempts, restarts, and resumes. Streamed text, final-only
replies, message tools, and reply cards count. Reasoning, working placeholders,
activity-only progress, and hidden metadata do not. Timing adds no message content
or new personal identifiers to logs. A timing-log read failure cannot fail an
already committed operation.

These are server-side availability measurements. They do not measure network
delivery or rendering on a user's device. Client delivery/render timing would need
a separate acknowledgement.
