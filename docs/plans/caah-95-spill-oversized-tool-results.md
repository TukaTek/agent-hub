# CAAH-95: Spill Oversized Tool Results to the Bot Computer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Approved by Agent Hub PM with the decisions recorded under "Decisions".**

**Goal:** When a tool result is longer than its delivery limit, save the full secret-redacted text to a private file on that bot's computer. The model gets a head/tail preview, the absolute path, the total character count and a hint for reading the file. If no computer is available, today's truncation still applies, with a notice that says so.

**Architecture:** The clip stays in the provider-neutral runtime (`pi-runtime.ts`). Before it clips, the runtime calls a new optional `AgentRunRequest.spillToolResult` callback. The executor implements the callback because it is the only layer that knows the sandbox, computer, run user and run secrets. The callback checks the isolation policy, redacts the text, writes the file with `SandboxProvider.writeFile` and returns a receipt. The runtime formats a receipt that starts with a header line, so later context shortening can't cut the path out. Results under the limit take the same code path as today.

**Tech stack:** TypeScript in `packages/adapters` and `packages/adapter-kit`, Vitest with the fake sandbox and fake connector. Offline and deterministic.

## Global constraints

- Results under the limit are byte-identical to today on every path. CAAH-89 budgets (`maxResultChars`, `resultCharsByToolId`) still decide the limit; spilling only happens above that limit.
- The file path is built only from constants, a user hash, the run ID and a sanitized tool slug. Model arguments and tool output never contribute to it.
- No provider-specific code or UI. The one new environment variable is `TOOL_RESULT_TEXT_LIMIT` (decision 4). Only the model-facing receipt and notice text is new (quoted below for the PR).

---

## Where the clip happens today

Every connector and built-in result goes through one `AgentTool.execute` in `pi-runtime.ts` (about lines 1177–1316):

| Path | Code | Limit |
| --- | --- | --- |
| Executor returns plain data (Composio, MCP, Pipedream, GraphQL, HTTP/secret requests, most built-ins) | `serializeToolResult` → `clipToolResultText` (`current` strategy) or `shortenToolResultText` middle cut (other strategies) | `resultLimit`, otherwise `TOOL_RESULT_TEXT_LIMIT` (12,000 when planned; 100,000 after decision 4) |
| Executor returns `{ content: [...] }` (MCP native content, computer screenshots) | `boundAgentToolResult` → `clipToolResultContent` (one budget shared by all text parts) | same |
| `request_secret` with an executor | `serializeToolResult`, default limit | default |
| Catalog wrapper `__catalog_execute` | Same two paths. `toolResultChars(tool, args)` picks the budget of the resolved tool ID (`lazy-tool-catalog.ts` `catalogResultBudgets`) | per resolved tool |
| `run_subagent` | `clipToolResultText` at line 1606 | default |
| `shell` | `shell-command-stream.ts` clips each of stdout and stderr | default, each |
| `skill_read` | `VERBATIM_TOOL_RESULTS`, never clipped | — |
| `read_history` / `search_history` | The executor refuses results over 11,000 bytes | — |

Composio (Fathom) tools don't declare `maxResultChars`, so they take the default (12,000 when planned). The remainder is dropped.

**Spill scope.** Spilling applies to the `serializeToolResult` and `boundAgentToolResult` branches of the connector `execute` path, for every tool **except** a fixed `NO_SPILL_TOOLS` set: `read_file`, `list_files`, `shell`, `run_subagent`, `skill_read`, `read_history`, `search_history` and the `computer_*` screen tools. These either already come from the computer, already have their own budget, or are model-generated. Leaving out `read_file` also prevents a loop where reading a spill file spills it again.

## Design

### 1. Runtime hook (`adapter-kit` + `pi-runtime.ts`)

Add to `AgentRunRequest` (`packages/adapter-kit/src/types.ts`, next to `executeTool`):

```ts
/** Save an oversized result off-context. Undefined means no computer could take it. */
spillToolResult?: (input: {
  toolName: string;
  executionId: string;
  text: string;
}) => Promise<ToolResultSpill | { unavailable: "no-computer" | "shared-computer" }>;

export interface ToolResultSpill {
  path: string;        // absolute on the computer; also accepted by read_file
  totalChars: number;  // chars of the redacted text
  savedChars: number;  // < totalChars only when the size cap applied
}
```

In `pi-runtime.ts`, replace both clip calls with an async `deliverToolText(text, limit, ctx)`:

1. If `text.length <= limit` or the tool is in `NO_SPILL_TOOLS`, do exactly what happens today.
2. Otherwise call `spillToolResult`. On success, return `formatSpillReceipt(receipt, text, limit)`.
3. When the callback returns `unavailable` or throws, return today's clip followed by the matching fallback notice. With no callback at all (a scripted runtime, or a host that doesn't spill), the output is exactly today's.

For content arrays, the text parts are joined with `"\n"` and spilled as one file. Non-text parts (images) stay as they are. The preview takes the place of the text parts.

### 2. Receipt format (`packages/adapters/src/tool-result-spill.ts`, new, pure)

**JSON objects keep their shape.** Paginated tools put cursors and IDs next to the large field, and a raw head and tail cut can lose them. So an oversized JSON object is delivered as today's structure-preserving shortening, with a `fullResult` field added first and a shortening marker that points to it:

```
{"fullResult":{"path":"/home/…/04-fathom-get-transcript.txt","totalChars":200000,"read":"Read it with read_file (offset, limit) or search it with shell grep -n."},"nextCursor":"…","transcript":"<head>\n[Shortened here; the full result is at fullResult.path.]\n<tail>","contextTruncated":true}
```

Later structured shortening keeps `path` keys and numbers, so the path survives. `savedChars` appears only when the size cap applied. If the object already has a `fullResult` key, or its required fields alone don't fit, the text receipt below is used.

**Everything else** (arrays, strings, native text content) gets plain text, not JSON, so `shortenStructuredResult` can't shorten the path as a JSON leaf:

```
[Full result saved: 200,000 characters at /home/cortexai-agent-hub/.cortexai/tool-results/3f9c…/run_abc/04-fathom-get-transcript.txt. Read it with read_file (offset, limit) or search it with shell grep.]
<head>
…
<tail>
```

- The header is at most 400 characters, so it always survives `runtime-context.ts`'s 1,024-character shortening of older results (512-character head) and the context selector's middle cut.
- `tail = min(2,000, ⌊(limit − header)/4⌋)` and `head = limit − header − tail − separators`. For a CAAH-89 tool with a 64k budget, the model sees roughly the same leading page as before, plus the path.
- When the size cap applied, the header says `first 2,000,000 of N characters`.

Fallback notice, appended to today's `toolResultTruncationNotice(limit)`:

- `A full copy was not saved because no bot computer is available.`
- `A full copy was not saved because this bot's computer belongs to another user.`

### 3. Executor writer (`executor.ts`, next to `applyTool`)

`spillToolResult` is built once per run and passed as `executeTool: scripted ? undefined : applyTool, spillToolResult: scripted ? undefined : spill`.

1. **Policy** (see Isolation). If it fails, return `{ unavailable }`.
2. **Redact:** `redactSecrets(text, runSecrets)`. This applies the run's registered secrets (model keys, bot secrets, credentials added mid-run), the same as `read_file` output. Adapters already apply `redactConnectorPayload` before results reach the executor, so the file gets the same treatment as today's delivered result plus run-secret redaction, because a file is a longer-lived sink than the context. Redact before applying the cap so a cut can't expose part of a secret, as `bot-secrets.ts:740` does.
3. **Cap:** `MAX_SPILL_CHARS = 2_000_000`, roughly a 5-hour transcript. Longer text keeps the first 2,000,000 characters and the header says so.
4. **Path (home-relative):** `.cortexai/tool-results/<userKey>/<runId>/<seq>-<slug>.txt`
   - `userKey = sha256(spaceId + ":" + run.userId).slice(0, 16)`, so internal IDs aren't shown to the model.
   - `seq` is a per-run counter. `slug` is the resolved tool name (or the catalog `id`), lowercased to `[a-z0-9-]`, at most 40 characters.
   - The path goes through `resolveBotWorkspacePath(computerMode, bot.id, …)`, so on a Team Computer it lands under `bots/<bot-id>/`.
5. **Prune** (before each spill, so the 50-file cap holds after the write). The command is a constant built with `shellQuote`, run through `deps.sandbox.execute` from the bot home: delete files older than 7 days, then keep the newest 50 files in this user's directory and remove empty run directories. A failure is logged and doesn't block the write.
6. **Write:** `deps.sandbox.writeFile(computer, { path, content: utf8 }, context)`. It doesn't call `workspaceCheckpoint.markDirty()` and doesn't post a `computer.command` Activity row (no new UI).
7. **Absolute path:** add an optional `workspaceRoot?: string` to `SandboxCapabilities`. Docker sets `/home/cortexai-agent-hub`, CreateOS `/home/desktop/cortexai-agent-hub-home`, E2B, Daytona and Box their equivalent homes, and the fake sandbox `/workspace`. The receipt path is `workspaceRoot + "/" + storedPath`. `resolveBotWorkspacePath` strips a leading `workspaceRoot` prefix, the way `docker-sandbox.ts:685` already handles `cwd`, so the same absolute path works in `read_file` and `shell`. The host desktop has no fixed root, so it returns the home-relative path. Shell's default cwd and `read_file` both resolve that from the bot home.
8. A `writeFile` failure (for example a computer suspended mid-run) returns `{ unavailable: "no-computer" }` and logs.

### 4. Reading it back: small `read_file` extension

Shell is optional (`disabledBuiltinTools`), and its output is clipped at the default limit per stream, so add optional `offset` and `limit` (characters) to `read_file`:

- When either is set, read with `maxBytes = 8 MB` instead of 250 KB. Return `{ path, offset, total_chars, next_offset?, content }`, with the keys in that order so `next_offset` survives a clip. `limit` defaults to 64,000 and is capped at 64,000 (8,000 when the default limit was 12,000). A page shrinks until its JSON-escaped form fits 1,500 characters under the delivery limit.
- Without `offset` and `limit`, behavior is unchanged.
- Content goes through `redactSecrets(…, runSecrets)` as today. The file is already redacted, so this doesn't change the content.
- **Random access.** `offset` can be any position, not only a `next_offset` from an earlier page. `offset` and `total_chars` count UTF-16 code units, the same unit as the receipt's total, so `offset ≈ fraction × total_chars` jumps to that part of the transcript. A page never splits a surrogate pair: an offset inside one moves back one unit, and a page that would end on a high surrogate ends one unit earlier. Every quoted character is then intact at any position. An offset at or past the end returns empty `content` and no `next_offset`.
- **Finding a passage.** The receipt points to `shell grep -n -C 3 '<phrase>' <path>`. Its output is line-based, so the byte-versus-character mismatch of `grep -b` doesn't apply. Without shell, the agent jumps by fraction with `read_file`.

### 5. Isolation

| Computer | Spill? | Why |
| --- | --- | --- |
| Private (`scope = "dedicated"`) and `computer.userId === run.userId` | Yes | Only this user's bot uses it |
| Private, but `run.userId` isn't the owner | No → `shared-computer` | Another user's machine |
| Team (`scope = "team"`), any number of members | Yes, under `bots/<bot-id>/.cortexai/…` | Space-trusted, like attachments (decision 1). The per-user path guard still applies in the file tools |
| Host desktop (Electron, `kind = "desktop"`) | Yes | A single local user |
| No computer, scripted runtime, intro (`created`) run | No → `no-computer` | — |

Defense in depth: `read_file`, `list_files`, `open_path` and `attach_file` refuse any path under `.cortexai/tool-results/<key>/` whose key isn't the current run's `userKey` (`error: "not found"`). Tenant isolation already comes from computers being per space.

### 6. Context selection

- **At delivery** (`serializeToolResult`, non-`current` strategies): a spill replaces the `shortenToolResultText` middle cut. Without a spill, the middle cut stays as it is today.
- **Later turns** (`runtime-context.ts:355` shortens older results to 1,024 characters; `selectContext` halves protected results under pressure): both keep the head, so the header with the path survives. The full text stays recoverable from the file, so "omitted evidence is unavailable" is no longer true for spilled results. That wording isn't changed; the header next to it is enough.
- `shouldSkipPortableWorkspaceFile` (`computer-workspace.ts`) also skips `.cortexai/tool-results/`. Transferred-workspace checkpoints (E2B, CreateOS) and `AgentHomeStore` backups then don't keep third-party payloads. Docker mounts the home directly, so pruning bounds it there.

## Files

- Create: `packages/adapters/src/tool-result-spill.ts` and `tool-result-spill.test.ts` (receipt, preview math, slug, user key, path, `NO_SPILL_TOOLS`, prune command)
- Modify: `packages/adapter-kit/src/types.ts` (`spillToolResult`, `ToolResultSpill`, `SandboxCapabilities.workspaceRoot`)
- Modify: `packages/adapters/src/pi-runtime.ts` (`deliverToolText` in `serializeToolResult` and `boundAgentToolResult`), `pi-runtime-limits.ts` (fallback notice variant)
- Modify: `packages/adapters/src/executor.ts` (spill writer, policy, `read_file` offset/limit, spill-path guard), `builtin-tools.ts` (`read_file` schema)
- Modify: `packages/adapters/src/computer-support.ts` (strip `workspaceRoot`), `computer-workspace.ts` (skip spill directory)
- Modify: `docker-sandbox.ts`, `createos-sandbox.ts`, `e2b-sandbox.ts`, `daytona-sandbox.ts`, `box-sandbox.ts`, `fake-sandbox.ts` (`workspaceRoot` in `describe()`)
- Tests: `pi-runtime-tool-dispatch.test.ts`, new `executor-tool-result-spill.test.ts`, `runtime-context` or `context-selection` test, `computer-workspace.test.ts`, `computer-support.test.ts`
- Docs: `docs/mcp-result-delivery.md` gets an "Oversized results" section

## Tasks (test first)

### Task 1: Pure receipt and path helpers

- [ ] Write `tool-result-spill.test.ts`:
  - The receipt is at most `limit` characters, and the header is at most 400 characters and sits in the first 512.
  - The head and tail are exact slices of the input.
  - With the size cap, the header reads "first 2,000,000 of N".
  - Slugs are sanitized (`../x`, unicode, 200 characters).
  - `userKey` is stable and differs per user and per space.
  - The prune command is constant and quoted.
- [ ] Run `pnpm --filter @cortexai-agent-hub/adapters exec vitest run src/tool-result-spill.test.ts` and confirm it FAILS.
- [ ] Implement, re-run until it passes, then commit `CAAH-95: tool result spill receipt helpers`.

### Task 2: Runtime hook

- [ ] In `pi-runtime-tool-dispatch.test.ts`, with a fake `spillToolResult` that records its input:
  1. A **200,000-character** fake connector result: the recorded `text` equals the original serialization **byte for byte**. The delivered text holds the path and `200,000`, and is at most the limit.
  2. **Under the limit**, on both the JSON and native-content paths: output is identical to today and spill is never called.
  3. **CAAH-89:** a 64k-budget paged tool with a 60k result, direct and through the catalog wrapper by ID, is unchanged and spill isn't called. A 100k result spills and its head is the same as today's 64k clip, minus the receipt length.
  4. No callback, or `unavailable`: today's clip plus the matching notice. A callback that throws behaves the same way.
  5. `NO_SPILL_TOOLS` tools never call spill.
  6. With a non-`current` strategy, a spill replaces the middle cut.
- [ ] Watch it fail. Implement `deliverToolText` and the `adapter-kit` type, watch it pass, then commit.

### Task 3: Executor writer, redaction, isolation, retention

- [ ] New `executor-tool-result-spill.test.ts`, following `executor-secret-pi.test.ts` (scripted Pi, fake sandbox, fake connector):
  1. **Byte-for-byte:** a 200k fake Composio result spills to `/workspace/.cortexai/tool-results/<key>/<run>/01-….txt`. Paging with `read_file` `offset`/`limit` until `next_offset` is absent and concatenating gives the redacted original exactly. The test uses non-ASCII, newlines and quotes.
  1b. **Quote from any position.** The fixture is a deterministic fake Fathom transcript of about 240,000 characters, with no randomness. It has one numbered utterance per line, `[hh:mm:ss] Speaker N: … marker-<index> …`, mixing in accented text, emoji (surrogate pairs) and escaped quotes. A table-driven test reads `read_file({ path, offset, limit: 8_000 })` at sampled offsets:
     - `0` (beginning)
     - the first character after the receipt's head preview, the start of the part the model hasn't seen
     - 10%, 25%, 33%, 50% (middle), 67%, 75% and 90% of `total_chars`
     - the first character before the tail preview
     - `total_chars − 100` (end), `total_chars` and `total_chars + 1` (both empty, no `next_offset`)
     - an offset that lands inside an emoji (moves back one unit)

     For every sample:
     - `content` equals `redacted.slice(o', o' + content.length)`, where `o'` is the offset after any surrogate adjustment.
     - `next_offset === o' + content.length`.
     - `content` contains every `marker-<index>` whose line falls wholly in that window, matched against an index computed from the fixture.

     A second case runs a scripted Pi turn: fetch the transcript, then `read_file` at the 50% offset, then reply with a quote. The tool result the model received contains the exact middle utterance, which the receipt preview leaves out. This shows the receipt plus random access gives the model text it couldn't see before, not just the head and tail.
  2. **Redaction:** a result that echoes a registered run secret and a bot secret has `[redacted]` in the file and never the raw value.
  3. **Cross-user denial:** user B runs a private computer owned by A, so nothing is written and the result carries the `shared-computer` notice. A multi-member Team Computer spills under `bots/<bot-id>/.cortexai/tool-results/<key>/`. On that Team Computer, B's run calling `read_file`, `list_files`, `open_path` or `attach_file` on A's spill path gets `not found`.
  4. **Retention:** the prune command runs before every write and never when nothing spills. A failing prune still writes.
  5. **Sandbox failure:** `writeFile` throws, so the run gets the `no-computer` notice and continues.
- [ ] Watch it fail, implement, watch it pass, then commit.

### Task 4: Paths, checkpoints and context survival

- [ ] Tests:
  - `resolveBotWorkspacePath` strips `workspaceRoot` (private and team computers, plus a traversal guard).
  - `shouldSkipPortableWorkspaceFile(".cortexai/tool-results/…") === true`.
  - A spilled receipt shortened by `runtime-context` (1,024 characters) and by `selectContext` still contains the full path.
- [ ] Implement, add `workspaceRoot` to each sandbox `describe()` and update `docs/mcp-result-delivery.md`, then commit.

### Task 5: Verification

- [ ] `pnpm --filter @cortexai-agent-hub/adapters test`, `pnpm --filter @cortexai-agent-hub/testkit test` (the `pi-offline` CAAH-89 cases), `pnpm lint` and `pnpm typecheck`.
- [ ] Acceptance on TukaTek after deploy: an agent fetches a full 1-hour Fathom transcript and quotes it accurately from the beginning (first 5 minutes), the middle (about 30:00) and the end (last 5 minutes). Each quote is checked word for word against the transcript in Fathom, with matching timestamps. The middle quote must come from text outside the receipt preview. The PR records the outcome in words.

## Risks

1. **Disk growth.** Each spill is capped at 2,000,000 characters, so at most a few MB on disk. Pruning keeps 7 days and at most 50 files per user per computer. Checkpoints skip the directory. Worst case per user is about 50 × 8 MB, but realistic transcripts are 100–500 KB.
2. **Sandbox not started or suspended.** The executor provisions the computer before the model runs, so it's normally up. If idle sleep or a provider error makes `writeFile` fail, the run falls back to today's truncation with the `no-computer` notice, and never fails the tool.
3. **Leaking large untrusted content.** The file holds third-party data that may contain prompt injection. It is redacted and capped, never in `shared/`, never attached or opened automatically, written as `.txt` and never executable. Reading it back returns a tool result with the same trust as today. Private computers refuse other users. On Team Computers the file is space-trusted, like attachments: the file tools refuse other users' spill paths, but `shell` on a Team Computer isn't a security boundary (`docs/computer-runtime.md`).
4. **Behavior change for CAAH-89 overshoot.** A paged tool that exceeds its own budget now gets a slightly shorter head (minus the receipt) plus a file instead of a longer head. Results under budget are unchanged.
5. **Redaction can lengthen text.** `totalChars` counts the redacted text, so the number the model sees always matches the file.
6. **Context window and cost at the 100,000-character default.** One full result is about 25k tokens, and the limit is per call, not per turn: four large results in one turn are about 100k tokens. The limit doesn't scale with the selected model's `contextWindow`.
   - On 32k-token or smaller models (common for local ones), a single result can take most of the window. `selectContext` then shortens older results and drops history, so earlier evidence and conversation fall out sooner, and the reply has less room.
   - On large-window models it's mostly cost and latency: every model call after the result resends it until `runtime-context` shortens it to 1,024 characters in later turns. Prompt caching softens this where the provider supports it.
   - Mitigation: operators running small-window models lower `TOOL_RESULT_TEXT_LIMIT` (the floor is 12,000, the old default). A possible follow-up is to cap the inline limit at a fraction of the model's `contextWindow`. That isn't part of this change.

## Decisions (Agent Hub PM, from Sanjay)

1. **Multi-member Team Computers spill.** They're space-trusted, like attachments. Files go under `bots/<bot-id>/`, and the per-user path guard stays in `read_file`, `list_files`, `open_path` and `attach_file`. The `shared-computer` fallback is only for a private computer used by someone other than its owner.
2. **Retention is 7 days**, with the 50-file cap per user per computer.
3. **Out of scope:** spilling `run_subagent` and `shell` output.
4. **Default inline limit is 100,000 characters** (about 25k tokens), set by `TOOL_RESULT_TEXT_LIMIT` (integer 12,000–1,000,000; invalid or blank values use 100,000). Results spill only above it, and receipts are unchanged. Everything that used the old 12,000 default follows it: JSON and native delivery, `run_subagent` replies and finished `shell` output. The CAAH-89 ceiling `MAX_TOOL_RESULT_CHARS` is `max(128,000, default)`, so a declared budget can only widen delivery; a declared budget below the default is ignored and the tool gets the default. `read_file` pages grow to 64,000 characters. Shortening of older results (`runtime-context` at 1,024 characters, `selectContext` under pressure) is unchanged.

## Self-review

- Ticket coverage:
  - Full save with preview, path and total: sections 2 and 3, Task 2 case 1.
  - Byte-for-byte retrieval at 200k: Task 3 case 1.
  - Accurate quotes from any position in a result over 100k (beginning, middle, end): section 4 (random access), Task 3 case 1b, Task 5 acceptance.
  - Redaction: section 3 step 2, Task 3 case 2.
  - Private files and cross-user denial: section 5, Task 3 case 3 (private computers refuse; file tools return not found on Team Computers).
  - Retention: section 3 step 5, Task 3 case 4.
  - Fallback notice: section 2, Task 2 case 4.
  - Under-limit and CAAH-89 unchanged: Task 2 cases 2–3.
  - TukaTek acceptance: Task 5.
- Names are consistent: `spillToolResult`, `ToolResultSpill`, `deliverToolText`, `NO_SPILL_TOOLS`, `MAX_SPILL_CHARS`, `userKey`, `workspaceRoot`.
