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

The discovered budget follows direct tools and catalog wrapper calls through both
JSON and native tool-result delivery. Catalog budgets are keyed to discovered tool
IDs; other tools retain their existing default. The runtime enforces the bound
again and shares it across all text parts. This behavior is in the shared adapter
package used by hosted and desktop runtimes; no native UI setting is required.

A larger limit does not guarantee that arbitrary raw output fits. Servers should
return whole, byte-bounded pages and continuation cursors, with no duplicated large
text/structured representations. Include serialization overhead in the budget.
An oversized response is still clipped by the client; use a smaller page and
verify intact end-to-end JSON delivery before relying on the larger budget.
