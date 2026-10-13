import { describe, expect, it } from "vitest";
import { catalogEntries, lazyCatalogTools } from "./lazy-tool-catalog.js";
import {
  boundedResultChars,
  MCP_RESULT_BUDGET_KEY,
  mcpResultBudget,
  toolResultChars,
} from "./mcp-result-budget.js";

describe("bounded MCP delivery hints", () => {
  it("uses discovery metadata only for explicitly read-only tools", () => {
    const _meta = { [MCP_RESULT_BUDGET_KEY]: 64_000 };
    expect(mcpResultBudget({ _meta })).toEqual({});
    expect(mcpResultBudget({ _meta, annotations: { readOnlyHint: false } })).toEqual({});
    expect(mcpResultBudget({ _meta, annotations: { readOnlyHint: true } })).toEqual({
      maxResultChars: 64_000,
    });
  });
  it.each([undefined, null, -1, 0, 11999, 12000.1, NaN, Infinity, "64000", {}, Number.MAX_VALUE])(
    "ignores invalid hint %s",
    (value) => {
      expect(boundedResultChars(value)).toBeUndefined();
    },
  );
  it("caps an otherwise valid request at the host ceiling", () => {
    expect(boundedResultChars(12_000)).toBe(12_000);
    expect(boundedResultChars(1_000_000)).toBe(128_000);
  });
  it("catalog budgets bind discovered IDs and cannot be enlarged by call arguments", () => {
    const entries = catalogEntries([
      {
        name: "paged",
        description: "Read a page",
        inputSchema: { type: "object" },
        maxResultChars: 64000,
      },
    ]);
    const wrapper = lazyCatalogTools("connectors", "mcp", "MCP", entries)[2]!;
    expect(toolResultChars(wrapper, { id: entries[0]!.id, maxResultChars: 999999 })).toBe(64000);
    expect(toolResultChars(wrapper, { id: "unknown", maxResultChars: 999999 })).toBeUndefined();
    expect(toolResultChars(wrapper, { id: "__proto__" })).toBeUndefined();
    expect(toolResultChars({}, { maxResultChars: 64000 })).toBeUndefined();
  });
});
