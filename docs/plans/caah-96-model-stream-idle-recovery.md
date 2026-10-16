# CAAH-96: Recover from Model Stream Idle Timeouts — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Approved by Agent Hub PM with the decisions recorded under "Decisions".**

**Goal:** When a model stream returns 2xx and then goes silent before any content or tool call, retry that model call up to 2 times, using the space's backup model for the final retry when one fits. Never retry once output has started. Make the idle and first-event bounds configurable, log every model call, and give subagents the same backup-model fallback as the main agent.

**Architecture:** The retry lives in one place: `fallbackAwareModelStream`, which already owns the backup chain. It gains a per-call *stall budget* and is provider-neutral: it retries any stream that ends in a watchdog stall. The watchdog (`codexStreamIdleWatchdog`) gains a first-event timer. Both timers abort with today's `Codex stream idle timeout` message and tag the terminal message with the stall reason. The main agent and subagents route every call through the wrapper, with or without backups, so there is one retry path instead of three.

**Tech stack:** TypeScript in `packages/adapters`, Vitest with fake timers and the existing fake-provider harness in `pi-runtime-fallback.test.ts` and `pi-runtime-stream-idle.test.ts`. Offline and deterministic.

## Global constraints

- Calls that don't stall behave the same as today. The watchdog exists only for Codex (decision 1), so other providers can't stall-retry until a follow-up adds watchdogs for them.
- No new user-facing copy. A retry on the same model is invisible. A final retry on a backup reuses today's `Provider unavailable. Switched to backup model <id>.` progress text, as the main progress line or the subagent row's progress.
- The new env vars are generic, not provider-specific: `MODEL_STREAM_IDLE_TIMEOUT_MS` and `MODEL_STREAM_FIRST_EVENT_TIMEOUT_MS`. The retry count is a constant (2) because the ticket fixes it.
- A caller abort (user stop, run cancel, lease loss) is never retried.

---

## Today

| Layer | Where | What it retries | After 2xx? |
| --- | --- | --- | --- |
| pi SDK retry | `reliableStreamOptions` sets `maxRetries` (`MODEL_STREAM_MAX_RETRIES`, default 1). `observedPiStream` forces `0` when a `ModelCallObserver` is present, which is the case in production. | Transport failures before headers | Never |
| Codex watchdog | `codexStreamIdleWatchdog` (`pi-runtime.ts` ~2852). Armed on a 2xx `onResponse`, re-armed on every event, 180s. | Nothing: it aborts and relabels the error as `Codex stream idle timeout` | — |
| Backup switch | `fallbackAwareModelStream` (~2574), main agent only, only when `request.fallbackModels` is non-empty | Any `isRetryableProviderUnavailable` failure before output. The idle message matches `timeout`, so **a stall switches to the backup on the first stall** (test "switches after a Codex idle timeout before output"). | Yes, if no output yet |
| Subagents | `executeSubagent` (~1478) calls `reliableModelStream` directly | Nothing | — |
| Run level | Executor | No run re-execution on model failure | — |

So with no backups a single stall ends the run (the incident). With backups, the main agent abandons the primary after one stall and never retries it. Subagents can't fall back at all (the comment's incident).

**Task 0 findings (pi-ai 0.87.1, `api/openai-codex-responses.js`):** the SSE path pushes `start` immediately after a 2xx response, *before* reading the body. `response.created` produces no pi event. So `start` can't mark the first event. The provider does honor `options.fetch` (line 267), so the first-event timer clears on the first body chunk of the 2xx response.

## Design

### 1. Timeouts (`pi-runtime-limits.ts`)

```ts
export const MODEL_STREAM_IDLE_TIMEOUT_MS = 180_000;        // unchanged default
export const MODEL_STREAM_FIRST_EVENT_TIMEOUT_MS = 120_000; // decision 2
export const MODEL_STREAM_STALL_RETRIES = 2;

export function modelStreamIdleTimeoutMs(value = process.env.MODEL_STREAM_IDLE_TIMEOUT_MS): number;
export function modelStreamFirstEventTimeoutMs(
  value = process.env.MODEL_STREAM_FIRST_EVENT_TIMEOUT_MS,
  idle = modelStreamIdleTimeoutMs(),
): number;
```

- Idle: an integer from 30,000 to 900,000. Invalid or blank values use 180,000.
- First event: an integer from 10,000 to 900,000, capped at the effective idle value. Invalid or blank values use `min(120,000, idle)`.
- They are read when each call's watchdog is created, so tests can stub env without reloading the module.
- Both are documented in `.env.example` next to `MODEL_STREAM_MAX_RETRIES`, in the same format.

### 2. Watchdog: first-event timer (`codexStreamIdleWatchdog`, `codexRequestFetch`)

- `responded()` runs on a 2xx `onResponse`. It arms the idle timer (today's `ping()`) and a first-event timer.
- `firstByte()` clears the first-event timer. `codexRequestFetch` passes 2xx bodies through a `TransformStream` whose first chunk calls it. Any delivered event other than `start` also calls it, since such events can only be parsed from body bytes. Headers are copied without `content-encoding` and `content-length`, as `boundRetryableErrorBody` does.
- Either timer firing aborts with `CODEX_STREAM_IDLE_TIMEOUT_MESSAGE`, so the error users and logs see is unchanged. The relabeled terminal message is recorded in a module-private `WeakMap<AssistantMessage, "first-event" | "idle">`, which the wrapper reads to detect a stall and log its reason. No message fields change.
- The idle bound comes from `modelStreamIdleTimeoutMs()` everywhere it's used today, including `boundRetryableErrorBody`.

### 3. Stall budget in `fallbackAwareModelStream`

Each wrapper invocation (one model call inside a turn) gets `stallRetries = MODEL_STREAM_STALL_RETRIES`. In the error branch, before today's switch check:

```
stall = stallReason(event.error)
if stall && beforeOutput && stallRetries > 0:
  stallRetries -= 1
  if stallRetries === 0:              // final retry: try a backup first
    next = await resolveNext(target)
    if next: await state.onSwitch(next)
  retry the loop                      // same target unless switched
// today's generic switch now requires !stall
```

- "Output" is the existing `eventHasPartialOutput`/`assistantHasPartialOutput` test: text, thinking or any tool-call event.
- **No double retry.** A stall never goes through the generic "provider unavailable → switch" branch. It only consumes the stall budget. The generic branch keeps handling non-stall failures (503, 429 and the like) exactly as today, and those don't consume the stall budget. The pi SDK retry can't overlap because it never runs after headers.
- Worst case per call is 3 stalled attempts (1 + 2 retries). The stall budget is per call and isn't reset by a switch, so a backup that also stalls on the final retry fails with today's error.
- **A switch is sticky** (decision 3) for the rest of the run, or for the rest of the subagent's life. `state.attempted` and `getActive()` already persist across calls, so later calls start on the backup and never return to a model that stalled.
- With no backup (none configured, none resolvable, or none fits the context via `fallbackSupportsContext`), the final retry uses the same model.

### 4. One stream path for all calls

- **Passthrough mode with no backups.** When `request.fallbackModels` is empty, the wrapper keeps today's no-backup behavior, which the existing "passes the original stream options … with absent/empty backups" test pins. Caller options pass through unchanged (no `apiKey`/`reasoning` override), and pre-output events are forwarded immediately instead of buffered. On a same-model retry the new attempt's `start` is dropped, because the Agent already saw one, and the stalled attempt's error is never forwarded. That's safe because a stalled attempt has no content by definition. With backups, events stay buffered as today, because a switch changes the partial's provider and model.
- **Main agent:** `streamFn` always calls `fallbackAwareModelStream(fallbackState, …)`. The separate no-backup branch at ~407 is removed. The other `hasBackups` conditionals stay as they are, since they're equivalent when the active model never changes.
- **Subagents:** `executeSubagent` builds its own `FallbackStreamState`:
  - `request: host.request`, so it uses the parent's `fallbackModels` and `resolveFallbackModel`.
  - `getActive` returns the subagent's target (an explicitly selected subagent model included).
  - A fresh `attempted` set, `nextIndex: 0`, its own `providerFailures` set and the parent's abort signal (as today).
  - `onSwitch` updates only the nested agent: `nested.state.model`, its thinking level, `nestedHost.activeModel`/`models`/`model`/`apiKey`, and a rebuilt `contextPolicy`. It does **not** call `request.onModelChange`, which rewrites the parent run's model and requires the lease. It pushes the existing switch text as the subagent row's `progress`.
- To avoid copying the stream factory, extract `targetModelStream(target, ctx, options, push, observer, attribution, hooks)` (the `state.stream` body at ~349-373), which both states use.

### 5. Per-call log (`fallbackAwareModelStream`)

One structured line per attempt through `getLogger()`: `info` for `ok`, `warn` otherwise. The message is `"model call"`.

| Field | Source |
| --- | --- |
| `runId`, `agentId` (`main` or the subagent ID) | state |
| `provider`, `model` | active target |
| `attempt` (1-3), `fallback` (boolean: running on a backup) | stall loop and state |
| `requestSizeEstimate` (estimated tokens; the logger redacts any key containing "token") | `estimateModelContextTokens(context, estimatePiImageTokens)`, before context shortening |
| `timeToFirstEventMs` | time to the first event other than `start` or `error` (pi emits `start` on headers), or `null` |
| `durationMs` | from the attempt's start to its terminal event |
| `lastEventType` | last pi event type seen, for example `start`, `text_delta`, `error` |
| `outcome` | `ok`, `idle-timeout-retried` or `failed` (ticket wording), plus `switched` for today's non-stall provider-unavailable switch |
| `stall` | `first-event` or `idle` when the attempt stalled |
| `errorMessage` | for `failed` and `switched`, after `sanitizeError` (`error` is reserved by the logger) |

No prompt text, keys or error bodies go in the log.

### 6. Spill hint (`tool-result-spill.ts`, decision 4)

Change `READ_HINT` to `Search it with shell grep -n first, then read only the lines you need with read_file (offset, limit).` The receipt header stays at most 400 characters (an existing test). This is model-facing text, not UI.

## Files

- Modify: `packages/adapters/src/pi-runtime-limits.ts` (timeouts and constants), `pi-runtime-limits.test.ts`
- Modify: `packages/adapters/src/pi-runtime.ts` (watchdog first-event timer and stall tag, 2xx body tap in `codexRequestFetch`, stall budget, passthrough mode and log in `fallbackAwareModelStream`, single main-agent stream path, subagent fallback state, `targetModelStream`)
- Modify: `packages/adapters/src/tool-result-spill.ts` and its test
- Tests: `pi-runtime-stream-idle.test.ts`, `pi-runtime-fallback.test.ts` (the existing idle-switch case now switches on the 3rd attempt), new `pi-runtime-stall-retry.test.ts` (Tasks 3 and 4)
- Docs: `.env.example`

## Tasks (test first)

### Task 0: Confirm pi event timing (read only) — done, see findings above

### Task 1: Limits

- [ ] `pi-runtime-limits.test.ts`: defaults are 180,000 and 120,000. Valid overrides are respected. Blank, non-integer and out-of-range values fall back. First event above idle is capped at idle.
- [ ] Watch it fail, implement, watch it pass, commit `CAAH-96: configurable model stream idle and first-event timeouts`.

### Task 2: Watchdog first-event timer

- [ ] `pi-runtime-stream-idle.test.ts`:
  - A 2xx with no body bytes aborts at the first-event bound with the idle message, tagged `first-event`.
  - A first byte before the bound disarms the first-event timer, and only the idle bound applies after that (tagged `idle`).
  - Env overrides change both bounds.
  - 2xx bodies pass through byte for byte, with `content-type` kept.
  - The existing cases (retry backoff not covered, caller abort not relabeled, cleanup) still pass.
- [ ] Watch it fail, implement, watch it pass, commit.

### Task 3: Stall retry (`pi-runtime-stall-retry.test.ts`, fake timers, Codex fake provider)

- [ ] Cases:
  1. **Stalled 2xx then success:** the first attempt sends 2xx and no events. The second answers. The run gets the answer, the provider is called twice and no switch progress is emitted.
  2. **Three stalls:** the run fails with `Codex stream idle timeout`, the provider is called exactly 3 times and there is no 4th attempt.
  3. **Idle after text:** an attempt emits `text_delta` and then goes silent. It fails after the idle bound with no retry, and the partial text is kept (today's behavior).
  4. **Idle after a tool-call or thinking event:** no retry.
  5. **Final retry uses the backup and sticks:** with a backup configured, the primary stalls twice and the third call goes to the backup. `onModelChange` is called once with the backup, and the next model call in the run starts on the backup.
  6. **No double retry:** with a backup, one stall retries on the primary, it does **not** switch. A 503 before output still switches at once and doesn't consume the stall budget.
  7. **Caller abort** during a stall window: no retry.
  8. **Log fields:** with `createTestSink`, each attempt logs every field in the table above. Outcomes are `idle-timeout-retried`, `idle-timeout-retried`, `ok` for case 5 and `failed` for the last attempt in case 2.
- [ ] Update the existing "switches after a Codex idle timeout before output" test: the switch now happens on the 3rd attempt.
- [ ] Watch it fail, implement, watch it pass, commit.

### Task 4: Subagent fallback

- [ ] `pi-runtime-stall-retry.test.ts`:
  - **A subagent switches models after a Codex idle timeout before output.** The parent has a backup, and the subagent's Codex primary stalls on every attempt, so its final retry goes to the backup and returns a reply. `onModelChange` is **not** called, and the parent's next call still uses the primary.
  - With no backup, a stalled subagent retries on its own model.
- [ ] Watch it fail, implement, watch it pass, commit.

### Task 5: Spill hint, then verification

- [ ] Update `READ_HINT` and its test (header at most 400 characters), then commit.
- [ ] Run `pnpm --filter @cortexai-agent-hub/adapters test`, `pnpm --filter @cortexai-agent-hub/testkit test`, `pnpm lint` and `pnpm typecheck`.
- [ ] Acceptance on TukaTek after deploy: when a Chief run hits a first-event stall, the run completes with no user action. The logs show `idle-timeout-retried` followed by `ok` for the same run. The PR records the outcome in words.

## Cost and latency bounds

- **Attempts:** at most 3 per stalled model call. A stall can't trigger more than that, and no retry happens after output, so a model is never billed twice for generated tokens.
- **Latency of a typical stall** (headers fast, then no bytes): recovery takes about 120s plus the successful call, instead of a failed run at 180s. Three first-event stalls fail after about 360s, compared with 180s today.
- **Worst case per call:** each attempt can spend up to 120s waiting for headers (`MODEL_STREAM_TIMEOUT_MS`) plus 180s idle if bytes arrive but no events do. That's 300s per attempt and 900s per call. The executor heartbeat renews the run lease (see the `modelStreamMaxRetries` comment), so long turns aren't reclaimed mid-call.
- **Cost:** a stalled attempt produces no output tokens. Usage-billed providers may still bill the input, so the extra cost is at most 2× the request's input tokens per stalled call. At the incident sizes (34K and 11.7K tokens), that's under 70K extra input tokens. Codex over ChatGPT OAuth isn't billed per token but counts toward plan limits. Every attempt goes through `ModelCallObserver.beforeCall`, so space budgets and reservations apply per attempt and a space out of budget doesn't retry.
- **Fan-out:** parallel subagents each have their own budget, so N stalled subagents can make up to 3N attempts. That's bounded by `subagentGate` (4).

## Risks

1. **The first-event bound kills a slow but healthy call.** If Codex sends no bytes for more than 120s after headers, today's call succeeds and the new one retries it. Mitigations: the timer clears on the first body byte, not the first content (Codex sends `response.created` right away). Operators can raise `MODEL_STREAM_FIRST_EVENT_TIMEOUT_MS`. The new `timeToFirstEventMs` log shows the real distribution, so the default can be tuned.
2. **Passthrough retry on the no-backup path.** The Agent sees one `start`, then the retried attempt's events. That's correct only because a stalled attempt has no content, which the stall condition guarantees. Task 3 covers it.
3. **Subagent switch side effects.** It must not touch the parent's active model, `onModelChange` or the run row. Task 4 asserts all three.
4. **Log volume:** one line per model call attempt. That's comparable to the existing usage events, with no payloads.

## Decisions (Agent Hub PM)

1. **Stall retries apply wherever a watchdog exists.** The retry in the wrapper is provider-neutral. Only Codex has a watchdog today, and adding one to every provider is a larger, riskier change, so it stays a follow-up:
   - The pi providers differ in their hooks. `anthropic-messages`, `openai-completions`, `openai-responses`, `azure-openai-responses`, `mistral-conversations` and `pi-messages` expose both `onResponse` and `fetch`. `google-generative-ai` and `google-vertex` expose only `fetch`. `bedrock-converse-stream` has no custom `fetch`, and the Cloudflare bindings expose neither.
   - The repo's own local and OpenAI-compatible providers would need their own wiring.
   - Each provider would gain a new abort with no stall evidence. Slow local models (CPU prompt processing before the first byte) are the main risk.

   Follow-up: add a provider-neutral watchdog behind the same env vars, starting with the providers that expose both hooks, gated per provider by their own tests.
2. **First-event default is 120s**; idle stays at 180s. Both are env-configurable.
3. **A backup switch is sticky** for the rest of the run, and for the rest of a subagent's life.
4. **The spill-receipt grep hint is included.**

## Self-review

- Done-means coverage:
  - 1, retry before output up to 2 times then today's error: section 3, Task 3 cases 1-4.
  - 2, env timeouts (180s and 120s) and final retry on the backup: sections 1-3, Tasks 1-2, Task 3 case 5.
  - 3, logs: section 5, Task 3 case 8.
  - 4, spill hint: section 6, Task 5.
  - 5, subagents use `fallbackAwareModelStream` with their own state and the parent's backups: section 4, Task 4.
  - 6, tests: Tasks 1-4. Each ticket test maps to a named case.
- Interaction with fallback and cost/latency bounds: section 3 ("No double retry") and the bounds section.
- Names are consistent: `MODEL_STREAM_FIRST_EVENT_TIMEOUT_MS`, `MODEL_STREAM_STALL_RETRIES`, `modelStreamIdleTimeoutMs`, `modelStreamFirstEventTimeoutMs`, `targetModelStream`, `CODEX_STREAM_IDLE_TIMEOUT_MESSAGE`.
