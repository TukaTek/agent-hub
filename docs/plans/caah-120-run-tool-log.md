# CAAH-120: Per-Tool-Call Run Log — Implementation Plan

**Goal:** Every tool call in a run produces a `run.tool` record
`{ runId, callId, tool, summary, status, startedAt, endedAt }` that streams live and replays
after a reload, so the "This run" panel (CAAH-117/CAAH-121) can list each call with its
redacted argument summary and outcome. Backend only; no UI in this change.

## Decisions

- **Persistence reuses the event log.** `run.tool` is a normal product event, appended with
  `runId`. The `events` table already has an `(runId, type, seq)` index, so the per-run list is
  a fold over those rows. **No schema change and no migration.**
- **One emission point for every runtime.** Both runtimes (Pi and scripted) report a call
  with a `tool` runtime event and finish it through the executor's completion audit
  (`onToolCompleted` for Pi, the executor's own `applyTool` audit for scripted). The executor
  feeds both into one provider-neutral tracker, so a new runtime gets the log for free as long
  as it honors the existing `AgentRuntime` contract.
- **Redaction = computer.command rules.** Summaries go through `redactSecrets(text, runSecrets)`,
  the same function and secret list that redact `computer.command` commands and output. Before
  that, argument keys that look like credentials (`password|secret|token|api_key|...`) are
  masked with the existing `redactToolArgsForReview`, so a token the model typed but the run
  never registered still never reaches the log. Redaction runs on the full text before
  clipping, so a clip can never expose part of a secret. Failure text (the only tool output we
  log) gets the same treatment through `sanitizeConnectorError`, then is clipped.
- **Summary** is one line, `key: value` pairs, whitespace collapsed, at most 200 chars
  (`RUN_TOOL_SUMMARY_MAX_CHARS`), ending in `…` when clipped.
- **Status:** `running` on the tool event; `done`/`failed` on completion. A paused call
  (approval, secret, takeover) stays `running`; the resumed attempt finishes it with the same
  `callId`. Completion can arrive before the start event is processed (Pi runs tools while the
  executor loop drains events), so the tracker and the fold both keep a finished call finished
  and derive `startedAt` from `durationMs` when the start was not seen.
- **Read API:** `runs.tools({ botId | groupId, runId })`. It resolves the thread with the
  same `resolveThreadTarget` used by `threads.get`/`threads.messages` (same space, same user,
  archived threads readable), then reads `run.tool` events scoped to that thread and run. A run
  from another user, space or thread returns nothing readable.
- Live delivery uses the existing thread subscription; peer and background run events stay
  filtered exactly as today.

## Steps (TDD)

1. **Contracts** (`packages/contracts/src/events.ts`): add `run.tool` to `ProductEventType`,
   `RunToolSchema`, `RUN_TOOL_SUMMARY_MAX_CHARS`, `foldRunTools`. Tests: fold ordering,
   finished stays finished, earliest `startedAt` kept.
2. **Adapter-kit** (`packages/adapter-kit/src/run-tool-log.ts`): `summarizeToolArgs` and
   `createRunToolLog({ runId, redact, record, now })` with `started` / `finished`. Tests: summary
   format and clip, fake-token redaction in arguments and failure text, out-of-order
   completion, paused calls, record failures never throw.
3. **Executor wiring** (`packages/adapters/src/executor.ts`): create the tracker per attempt;
   call `started` on each `tool` event and `finished` from one shared completion helper
   used by the Pi and scripted paths. Tests (`executor-run-tool-log.test.ts`): both runtime
   paths emit running then done/failed for every call; a fake token argument never appears in
   any `run.tool` payload.
4. **API** (`packages/contracts/src/rpc.ts`, `apps/api/src/router.ts`): `runs.tools`. Tests:
   owner reads the folded list; other user and other space are denied before any event read;
   events are scoped to the resolved thread.
5. Extend the offline Postgres product journey to read `runs/tools` after a real Pi run.
6. `pnpm lint`, `pnpm check`, targeted `vitest` runs.
