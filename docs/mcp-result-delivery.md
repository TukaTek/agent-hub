# Bounded MCP result pages

Agent Hub normally gives a tool result 12,000 characters of model-visible text.
An MCP server that already paginates its results can request a larger budget on an
individual read-only tool at discovery time:

```json
{
  "name": "read_cached_page",
  "inputSchema": { "type": "object", "properties": {} },
  "annotations": { "readOnlyHint": true },
  "_meta": { "io.cortexai/max-result-chars": 64000 }
}
```

This is an optional Agent Hub extension, not a standard MCP pagination capability.
Clients that do not implement it may ignore the hint. Servers must keep their
response size compatible with the clients actually deployed.

The hint must be a safe integer at least 12,000; the host clamps it to 128,000.
Invalid or absent hints and tools without an explicit read-only annotation retain
the original limit. It does not grant authorization or change approval behavior.
HTTP transport limits are unchanged. Result bodies and model arguments cannot ask
for a larger budget.

Both `readOnlyHint` and the budget hint come from the server and are untrusted: a
server can mark any tool read-only. The read-only check only keeps write tools at
the default by mistake; it is not a security boundary. The 128,000-character cap is
the backstop on how much text any one server can place in front of the model per
call.

The discovered budget follows direct tools and catalog wrapper calls through both
JSON and native tool-result delivery. A catalog call keeps the budget of the tool it
executes, whether addressed by ID, full name, or unique short name; an ambiguous
name or a tool whose name collides with another connector's tool keeps the default.
The runtime enforces the bound again and shares it across all text parts. A clipped
result ends with an explicit truncation notice. This behavior is in the shared
adapter package used by hosted and desktop runtimes; no native UI setting is
required.

A larger limit does not guarantee that arbitrary raw output fits. Servers should
return whole, byte-bounded pages and continuation cursors, with no duplicated large
text/structured representations. Include serialization overhead in the budget.
An oversized response is still clipped by the client; use a smaller page and
verify intact end-to-end JSON delivery before relying on the larger budget.

The model's total context budget is independent of this per-tool allowance. A page
that cannot fit alongside required context may still be shortened by the context
selector. Choose page sizes that fit the selected model, and consume pages
incrementally; this hint does not disable context limits or guarantee that a whole
audit fits in one model call.

## Oversized results

When a result is longer than its delivery limit, whether the 12,000-character default or a page budget above, Agent Hub saves the full text to a file on the bot's computer instead of dropping the remainder. Secrets registered for the run are redacted first, and a file holds at most 2,000,000 characters. A JSON object is delivered with its shape kept, so cursors and IDs stay usable, and with a `fullResult` field (`path`, `totalChars`, how to read it) added first. Any other result gets a bounded preview with a header first:

```
[Full result saved: 200,000 characters at <path>. Read it with read_file (offset, limit) or search it with shell grep -n.]
```

`read_file` with `offset` and `limit` returns a page of at most 8,000 characters from any position, plus `total_chars` and `next_offset`. Offsets count the same characters as the header's total.

Files live under `.cortexai/tool-results/<user>/<run>/` in the bot's home (`bots/<bot-id>/` on a Team Computer). Each user's directory keeps files for 7 days and at most 50 files per computer, and workspace checkpoints skip it. File tools refuse other users' result paths. A Team Computer is space-trusted, so its `shell` can still reach them. A private computer only saves results for its owner. Results that already come from the computer (`read_file`, `list_files`, `shell`, screen and browser page tools), subagent replies, skills and history reads are never saved this way.

If no computer can take the file, the result is truncated as before, followed by a notice saying why a full copy was not saved.
