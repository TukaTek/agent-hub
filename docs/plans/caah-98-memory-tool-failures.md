# CAAH-98: Memory Tools Surface Provider Failures — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development with superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax. **Status: awaiting Agent Hub PM approval. No implementation code until then.**

**Goal:** When `save_memory`, `forget_memory` or `recall_memory` gets `{ok:false}` or an exception from any memory provider, mark the tool call failed, give the model an unambiguous error, log a content-free warning, and persist the outcome on the `agent.tool.completed` run event. Successful calls behave the same as today.

**Architecture:** One small helper, `runMemoryTool`, in `packages/adapters/src/memory-tools.ts`, which already owns memory tool selection. The three executor handlers call it instead of calling the provider directly. It:

1. Awaits the provider call. It catches throws, except a caller abort, which it rethrows so cancel semantics don't change.
2. Turns `{ok:false, error}` or a throw into `{ ok: false, error: "<tool> failed: <message>" }`. Because `error` is at the top level, the existing `isFailedToolResult` / `toolResultError` / `isErrorToolResult` paths mark the completion `outcome: "error"`, persist `error` on the event, and skip result spilling. No new failure plumbing is needed.
3. Logs `getLogger().warn("memory tool failed", { provider, operation, error })`. `provider` is `describe().id`, `operation` is `save | forget | recall`, and `error` goes through `sanitizeConnectorError(message, runSecrets)` and is truncated. Arguments and content are never logged.
4. Passes successful values through unchanged.

For auditing successful calls, `toolCompletionAuditPayload` gains a content-free `result` summary for the three memory tools only: `{ok:true}` for save, `{ok:true, count}` for recall, and `{ok:true, id, expired}` for forget. Memory text is never written to the event.

**Tech stack:** TypeScript in `packages/adapters`, Vitest, fake providers, a spied logger. Offline and deterministic.

## Today (main @ `a5516949`)

| Piece | Where | Behavior |
| --- | --- | --- |
| Supermemory provider | `supermemory-memory-provider.ts` L249-311 | `recall`, `save` and `purgeHistory` return `{ok:false, error}` and never throw on HTTP or network failure. The error strings are status codes and container tags, no content or keys (`supermemory-client.ts` L326, L356, L389). |
| Serenity provider | `serenity-memory-provider.ts` L223-329 | Same contract. It also returns `{ok:false}` when writes are disabled. `save` of `history` is a no-op success. |
| Factory / resolver | `memory-provider-factory.ts` | Builds the providers without wrapping them. A throw from `create*Provider` happens at run setup, outside the tools. |
| `recall_memory` | `executor.ts` L5662-5675 | Returns the raw provider response. No `finish`, since it's read-only. |
| `save_memory` | `executor.ts` L5700-5712 | `finish(await save(...))`: the raw `{ok:false, error}` is passed through. |
| `forget_memory` | `executor.ts` L5713-5733 | Same as save. When the provider has no `forget` it already returns `{error}`. |
| Run event | `toolCompletionAuditPayload` L2756, `appendToolCompletionAudit` L2801 | It persists `name`, `executionId`, `durationMs`, `outcome` and `error`, but **no result**. Since `4226be0b` (2026-09-20), a top-level `error` in `details` audits as `outcome: "error"`. |
| Throw path | `pi-runtime.ts` L1306-1320 | The completion records `error`. Pi turns the throw into an error tool result. Nothing is logged, and a raw provider exception message reaches the model and the event. |

**Gap analysis.** Reading the code, `{ok:false}` from Supermemory should already audit as `error` on main. So the `succeeded` events on runs `cmvdt9fih00072jlamb06owmw` and `cmvdt9x9i000b2jla8c7bqjk0` mean one of two things: the deployed build predates `4226be0b`, or the provider returned 2xx. Task 0 checks this before any fix. Either way, the ticket's gaps are real: nothing is logged, a success can't be audited because no result is persisted, throws aren't normalized, and the error the model gets is a bare provider string.

## Files

- `packages/adapters/src/memory-tools.ts`: add `runMemoryTool` and `memoryToolAuditSummary`.
- `packages/adapters/src/memory-tools.test.ts`: unit tests, three tools by four cases.
- `packages/adapters/src/executor.ts`: the three handlers (L5662-5733) call `runMemoryTool`. `toolCompletionAuditPayload` (L2756) adds `result` from `memoryToolAuditSummary`. The existing `./memory-tools.js` import is extended.
- `packages/adapters/src/executor.test.ts`: audit-payload tests and one end-to-end `save_memory` failure through the executor harness, using `memoryProviders.resolve` with a fake provider.
- No changes to the providers, the factory, the contracts, the UI or the Supermemory config, which the ticket puts out of scope. The provider contract (`SemanticMemoryResponse`) stays as is.

## Test-first steps

- [ ] **Task 0: reproduce.** In `executor.test.ts`, add a test that runs a save through `toolCompletionFromResult` and `toolCompletionAuditPayload` with the exact Pi-wrapped shape `{content, details:{ok:false, error}}`. Record whether it already says `error`. If it does, note in the PR that the incident build predates `4226be0b`, or that the provider returned 2xx, and ask DevOp for the deployed commit. Don't change the provider for this.
- [ ] **Task 1: failing unit tests** in `memory-tools.test.ts`, for each of `save`, `forget` and `recall`:
  - provider `{ok:false, error:"Supermemory save failed: 503"}` → the result has a top-level `error` that starts with `<tool> failed:`, and the logger gets one `warn` with `{provider, operation, error}`;
  - provider throws `new Error("boom")` → same result and log;
  - abort: the signal is aborted and the provider throws `AbortError` → it rethrows, with no log;
  - success → the result is deep-equal to the provider's value, with no log;
  - redaction: the content, query and fake API key (`sk-test-PLACEHOLDER`) appear nowhere in the serialized log calls, including when the provider's error echoes the key.
- [ ] **Task 2:** implement `runMemoryTool` until Task 1 passes.
- [ ] **Task 3: failing audit tests** in `executor.test.ts`: the memory failure gives `outcome:"error"` with `error` persisted; the save, recall and forget successes give `outcome:"succeeded"` with `result` equal to the summary; a recall payload has no memory text; non-memory tools get no `result` key, which keeps them unchanged.
- [ ] **Task 4:** implement `memoryToolAuditSummary` and wire it in.
- [ ] **Task 5: failing executor test.** A fake provider whose `save` returns `{ok:false}` → `agent.tool.completed` has `outcome:"error"`, and the scripted model sees the error text. Then wire the three handlers to `runMemoryTool` until it passes. Keep `finish(...)` around save and forget so effect persistence doesn't change.
- [ ] **Task 6:** `pnpm --filter @cortexai-agent-hub/adapters test`, typecheck and lint. Don't run the desktop e2e suite.

## Rebase with PR #50 (CAAH-97)

PR #50 changes `executor.ts` in the import block (~L33), ~L2647, ~L3262 (+170 lines), and from ~L7377 on. This change touches only L2756-2800 and L5662-5733, plus one existing import line. Those regions don't overlap, so whichever PR merges second should rebase cleanly, with at most a one-line conflict in the import block. The plan is to branch the implementation from `main` after #50 merges. If #50 is still open when coding starts, branch from `main` and rebase onto #50 before review.

## Risks

- **Model behavior:** the error text is model-facing, not UI copy. The text `"<tool> failed: <message>"` is meant to stop the model claiming success. The acceptance test is Chief saying the save failed.
- **Leakage:** provider error strings are logged after redaction. The run secrets don't include memory-provider credentials, so the redaction test covers a key echoed in an error, and messages are truncated (to 300 characters). Container tags hold bot and space IDs, which are identifiers, not secrets.
- **Audit summary:** it adds a field to `agent.tool.completed` for three tools only. Consumers that ignore unknown fields are unaffected. Persisting raw recall content was rejected on purpose, since it would copy memory text into the event store.
- **Abort semantics:** abort is rethrown, never turned into a failure, so cancel still behaves the same way.
- **Root cause may be elsewhere:** if Task 0 shows main was already correct, the incident's `succeeded` came from an older deploy or a provider 2xx. This change makes the next one auditable but can't make Supermemory durable.

## Decisions for Agent Hub PM

1. The successful-call event stores a content-free summary, not the raw result. Approve, or ask for raw results.
2. The model-facing error prefix is `"<tool> failed: "`.
