# Run dispatch and response timing

A run starts in the process that makes it due. When the API commits a message, a new
bot's greeting, or an answer, `RunJobPublisher` records the run's wake time and
`RunStarter` begins executing it in that same API process as an independent task;
the HTTP request returns at once and clients follow the reply through realtime.
Routines, bot-to-bot messages, webhooks and retries start the same way in whichever
process creates them. No queue, scan, shared slot or notification sits between a
due run and its start, so one slow or stuck run never delays another. A run due
later starts from a timer in the process that scheduled it.

Each start claims the run through the executor's atomic lease and fence checks, so
however many API and worker processes run, a run executes once. Model streams and
tools run independently after durable ownership and heartbeats are established.

A process that is shutting down or lacks memory headroom hands the run over: it
publishes the run id on the realtime connection and a worker takes it. Shutdown
requeues in-flight runs the same way, so the replacement process resumes them
within moments of a deploy.

Recovery is never on the path a new run takes. Each worker scans for runnable rows
at startup and every five seconds and starts any it finds: a run whose process died,
an expired execution lease, or a lost start or handover.

A bot uses its computer for one run at a time. A message sent while a run is going
steers that run instead of waiting. Background runs that need the computer while
another run of the same bot holds it stay queued; the run that releases the computer
starts the next one waiting, and recovery leaves them untouched until then.
Execution timing starts after computer ownership is acquired.

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

Recurring timer routines mark their origin durably and keep one pristine pending
catch-up run for the same routine, prompt, thread, and model selection. A later
tick reuses that pending work and advances the next scheduled tick, preserving
any computer retry delay. Already started runs, manual tests, explicit retries,
one-shot schedules, and change/event-triggered runs remain separate. Unmarked
older firings are preserved: a scheduled firing event alone cannot distinguish
recurring work from a one-shot whose routine was later edited.
A bounded pass cancels redundant marked timer rows with no attempts, effects,
output, steering, checkpoint, or live computer ownership, preserving historical
rows and terminal events. The `routine.coalesced` log records reuse without
another `routine.fired` event.
A timer run whose first start is more than 15 minutes after the most recent occurrence
due by then (counted from the occurrence in its marker) tells the agent both
times in the routine's timezone, so a catch-up after downtime can adapt instead
of assuming it is still the scheduled time. Late runs are never skipped.
Committed timer runs and their advanced schedules remain intact when publication
fails. Recovery repairs delivery for every driver; a notification failure never
rolls back work that another tick or dispatcher can already own.

Interactive work is scanned before scheduled/reaction work in each bounded pass.
When memory admission declines a run, dispatch leaves it durable and continues
scanning instead of waiting in a dispatch slot. Memory admission independently
checks available physical memory and unused JavaScript heap space against the
same small attachment startup buffer. External buffers are not counted against
the JavaScript heap limit, and live-run counts do not set a concurrency limit.
Notifications and periodic recovery reopen completed lanes without restarting
active pagination. Active model streams have no new duration limit.

`run.admission_wait` and `run.admission_resumed` identify a capacity episode and
its duration without logging every retry. Independently, every thirty seconds the
worker reports `run.queue_delayed` as an error when an interactive run has been due
and unstarted for at least thirty seconds, measured from the later of creation and
wake time. Runs waiting for their own bot's earlier run on its computer, retry
backoff, future retries and scheduled work do not count. The error carries
`queue.delayed_runs`, `queue.oldest_wait_ms`, `queue.oldest_run_id`, and the
reporting process's health: `worker.active_runs`, `db.pool.total`, `db.pool.idle`,
`db.pool.waiting`, `event_loop.delay_max_ms` and `event_loop.delay_p99_ms`.
`run.queue_recovered` marks recovery. These checks do not block dispatch.

For optional Axiom monitoring, alert when the following query returns any events
in the last two minutes (use the deployment's configured dataset):

```apl
['YOUR_DATASET']
| where message == "run.queue_delayed"
| summarize delayed = count()
| where delayed > 0
```

The application emits the signal; notification routing belongs in the deployment's
monitor configuration. No hosted monitoring service is required for dispatch.
