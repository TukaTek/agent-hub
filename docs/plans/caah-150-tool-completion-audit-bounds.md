# CAAH-150: Bound Tool Completion Audit Concurrency

## Problem

`appendToolCompletionAudit` → `events.append` → `prisma.$transaction(appendEventInTransaction)`
ran once per finished tool call, with no limit. Pi fires the hook without awaiting it, so
a parallel tool burst opened as many interactive transactions as there were calls. On the
worker pool (default `DB_POOL_MAX=8`, about 3 held by Graphile listeners and leadership),
these transactions waited past Prisma's `maxWait`. They failed with P2028 "Unable to start
a transaction in the given time", and audit evidence was lost. The burst also competed with
heartbeats, steering and `finalizeRun`.

## Design

- `packages/adapters/src/tool-completion-audit-queue.ts` is a process-wide queue with the
  bounds described in `docs/run-execution.md`. All three callers (Pi hook, scripted tools,
  MCP discovery failure) already go through `appendToolCompletionAudit`, so the bound
  covers them all. The Pi hook is still fire-and-forget. Scripted and MCP awaiters resolve
  when their audit settles.
- Retries only happen when a transaction never started. The shared `withTransactionRetry`
  is unchanged, so `finalizeRun` and the required writers behave as before.
- Every `appendToolCompletionAudit` call gets its own `auditId`, which retries of that
  invocation reuse. The partial unique index `events_runId_auditId_key` is defense in
  depth for one invocation: two inserts of the same `auditId` (raced connections, or a
  retry after a commit the client missed) produce one row. It is built `CONCURRENTLY`,
  in a single-statement migration. When an `agent.tool.completed` append violates the
  index, `appendEvent` returns the row that already committed.
- Why not `(runId, executionId)`: run turn checkpoints are stored per run. On resume, the
  pending call runs again with the same call id, so one `executionId` completes twice
  (once paused, then final). Provider tool-call ids can also repeat within a run. And
  `executionId` is encrypted at rest, so `payload->>'executionId'` is NULL on encrypted
  rows. Keying on `executionId` would drop real audits.
- `auditId` was added to the plain (queryable) event payload keys. It is an opaque random
  id.
- The worker `stop()` drains the queue after `jobHost.stop()` and before the pool closes.

## Bounds

| Constant | Value | Why |
| --- | --- | --- |
| `TOOL_COMPLETION_AUDIT_PER_RUN_CONCURRENCY` | 1 | Same-run audits update one threads row (`nextEventSeq`). |
| `TOOL_COMPLETION_AUDIT_PROCESS_CONCURRENCY` | 2 | Worker pool 8, minus about 3 reserved, leaves about 5. Using 2 leaves room for required writes. |
| `TOOL_COMPLETION_AUDIT_QUEUE_CAPACITY` | 32 | Pending audits, not counting in-flight ones. |
| `TOOL_COMPLETION_AUDIT_QUEUE_WAIT_MS` | 30 000 | Longest an audit waits for a slot. |
| `TOOL_COMPLETION_AUDIT_RETRY_ATTEMPTS` | 3 | Total attempts, for never-started P2028 only. |
| `TOOL_COMPLETION_AUDIT_RETRY_BASE_MS` / `_MAX_MS` | 250 / 2 000 | Full jitter. |
| `TOOL_COMPLETION_AUDIT_SHUTDOWN_DRAIN_MS` | 5 000 | Worker stop drain. |

These bounds apply per process. Running N worker processes allows up to 2N concurrent audit
transactions.

## Tests

- `packages/adapters/src/tool-completion-audit-queue.test.ts`: concurrency, per-run order,
  overflow, the retry classifier, jitter, `auditId` reuse, a paused completion followed by
  its resumed one, the queue timeout and the drain.
- `packages/db/src/events.test.ts`: on a unique violation, `appendEvent` returns the
  committed row. Any other unique violation is still thrown.
- `packages/db/src/tool-completion-audit.postgres.test.ts`: two pools race on the same
  `auditId` and produce one row with no sequence hole. Also covers retry no-op, pause plus
  resume, order within one run, encrypted rows, and rows without an `auditId`.
- `packages/adapters/src/tool-completion-audit.postgres.test.ts`: a burst on a 4-connection
  pool stays within the cap while a required write commits. A starved 1-connection pool
  either retries to success or ends with `retries_exhausted`.
- The existing `concurrent-migrations.test.ts` checks that the new migration is a single
  statement.

## Staging smoke

Not run yet. Run a parallel tool burst (for example, one prompt that fans out 20 or more
read-only tool calls across a few concurrent runs) on one worker, then check:

- The worker logs show no unbounded stream of P2028 `agent tool completion audit append failed`
  warnings. Any audit warnings carry `reason` and `attempts`.
- Postgres has no duplicate `agent.tool.completed` rows for one `runId` and `auditId`:
  `SELECT "runId", payload->>'auditId', count(*) FROM events WHERE type = 'agent.tool.completed' GROUP BY 1, 2 HAVING count(*) > 1;`
  returns nothing.
- A forced audit failure, such as a briefly starved pool, does not fail the run and does not
  show as a model or provider error in the thread.

## Rollback

Revert the PR. The index migration is additive. If the index must go, ship a follow-up
migration with `DROP INDEX CONCURRENTLY IF EXISTS "events_runId_auditId_key";` as its only
statement. Rows that carry `auditId` stay readable without it.
