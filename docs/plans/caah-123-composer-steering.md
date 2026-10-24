# CAAH-123: Composer steering hint, Stop button and queued marker

The ticket is the contract. Frontend only: the API already turns a send during a running
turn into a `SteeringMessage` (`apps/api/src/thread-target.ts`, group path in
`apps/api/src/router.ts`), and the run emits `run.steering.claimed` with
`{ steeringIds, nextMessageSeq }` when it takes the message (`packages/db/src/events.ts`).
No backend, contract or migration changes.

## Behaviour

| State | Placeholder | Actions |
| --- | --- | --- |
| Idle | `Message {name}` (unchanged) | Send (unchanged) |
| Conversational run working | `{name} is working — {key} sends this into the running turn` | Stop; Send appears once the draft has content |
| Run active but not steerable (waiting on the user, routine/webhook/intro turn) | `Message {name}` | Stop; Send once the draft has content |

- `{key}` follows `lib/composer-enter-to-send-pref.ts`: `Enter` when Enter sends,
  otherwise `⌘ Enter` on Apple platforms and `Ctrl+Enter` elsewhere.
- The steer hint only shows for a working, conversational run (`isRunWorking` +
  `isConversationalRun`), matching where the backend actually injects steering.
  Other active runs only hold the message until a continuation, so the hint would be wrong there.
- Stop reuses the existing `stopRun` → `threads.stop` path.
- Sending while a conversational run is working uses the existing `threads.send`; the
  server decides it is steering. The response carries the message `seq`.

## Queued marker

- `apps/web/src/lib/steering-queue.ts` (pure, unit tested) keeps the client's own sends
  made during a working conversational run: `{ threadKey, seq, text }`.
- While an entry is queued, its message is hidden from the transcript and shown in a
  "Queued" row above the composer.
- An entry clears when:
  - `run.steering.claimed` arrives for that thread with `nextMessageSeq > seq` (the ack);
  - `run.cancelled` or `run.failed` arrives (Stop deletes pending steering server-side,
    so the message is then just a normal user message);
  - the user presses Stop.
- The marker only shows while the thread still has an active run, so a missed event
  cannot leave a stale marker. Once cleared, the message renders as a normal user bubble.
- Scope is the sender's tab. Other devices and reloads show the message as a normal
  bubble, which is the current behaviour.

## Copy (new user-facing strings)

- `{name} is working — {key} sends this into the running turn`: the placeholder is the only
  place that says text sent now goes into the running turn instead of starting a new one.
  It replaces the existing placeholder, so no chrome is added.
- `Queued`: marks a sent message the bot has not taken yet. Without it the message looks
  delivered and answered-next, which is wrong while the turn is still running.
- `Queued message`: accessible name of the queued row.
- `Ctrl+Enter`, `⌘ Enter`, `Enter`: key labels inside the placeholder.

Translated in every Lingui locale (`pnpm --filter @cortexai-agent-hub/web intl:extract`).

## Tests

- Unit: `steering-queue.test.ts` (add, ack watermark, cancel/fail clear, per-thread scope,
  key label); `composer.test.tsx` (steer placeholder per Enter pref, Stop replaces Send
  until there is content, queued marker renders).
- Playwright `apps/web/e2e/composer-steering.spec.ts` (full stack): start a long turn with
  the scripted fake runtime (`work for N seconds`), type and press Enter → steering
  `threads/send` request, queued marker visible, cleared when the continuation claims it
  and the message renders in the transcript; then a `keep working until I stop you`
  turn, Stop → composer idle.
- Playwright fixture `apps/web/e2e/fixtures/composer-steering.{html,tsx}` + spec renders
  the Composer standalone for idle / running / queued screenshots in light and dark.
- `golden.spec.ts` asserted the old running state (`Message Chief` placeholder, Send
  visible with an empty draft, steered text immediately in the transcript); updated to
  the ticket's behaviour.

## Environment note

The full-stack Playwright suite needs Postgres via testcontainers (Docker). Docker is not
available in this workspace, so `composer-steering.spec.ts` and `golden.spec.ts` are
written but run in CI only. The fixture spec needs only Vite and is run locally for the
before/after screenshots.

## Open question

Upstream #460 deliberately replaced the steer placeholder with `Message {name}` under
the minimal-copy rule. This ticket brings back a steer hint. That is a product decision
for the fork, and it will conflict when that area is synced from upstream.
