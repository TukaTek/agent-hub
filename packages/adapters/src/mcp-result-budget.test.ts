import type { ConnectorTool } from "@cortexai-agent-hub/adapter-kit";
import { describe, expect, it } from "vitest";
import { catalogEntries, lazyCatalogTools, loadCatalogEntry } from "./lazy-tool-catalog.js";
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

  const routed = (resourceId: string, toolName: string, extra: Partial<ConnectorTool> = {}) => ({
    name: `mcp__${resourceId}__${toolName}`,
    description: "",
    inputSchema: { type: "object" },
    route: { connectorId: "mcp", resourceId, toolName, catalogGroup: resourceId },
    ...extra,
  });

  it("keeps the budget when the wrapper is called by full or short name", () => {
    const entries = catalogEntries([routed("docs", "read_page", { maxResultChars: 64_000 })]);
    const wrapper = lazyCatalogTools("connectors", "mcp", "MCP", entries)[2]!;
    for (const id of [entries[0]!.id, "mcp__docs__read_page", "read_page"]) {
      expect(loadCatalogEntry(entries, { id }).tool.name).toBe("mcp__docs__read_page");
      expect(toolResultChars(wrapper, { id })).toBe(64_000);
    }
  });

  it("gives an ambiguous short name no raised budget", () => {
    const entries = catalogEntries([
      routed("docs", "read_page", { maxResultChars: 64_000 }),
      routed("wiki", "read_page", { maxResultChars: 64_000 }),
    ]);
    const wrapper = lazyCatalogTools("connectors", "mcp", "MCP", entries)[2]!;
    expect(() => loadCatalogEntry(entries, { id: "read_page" })).toThrow();
    expect(toolResultChars(wrapper, { id: "read_page" })).toBeUndefined();
    expect(toolResultChars(wrapper, { id: "mcp__wiki__read_page" })).toBe(64_000);
  });

  it("binds a duplicated ID to the first entry, as execution does", () => {
    const write = routed("docs", "dup", {
      description: "write",
      ...mcpResultBudget({ annotations: { readOnlyHint: false } }),
    });
    const read = routed("docs", "dup", {
      description: "read",
      ...mcpResultBudget({
        annotations: { readOnlyHint: true },
        _meta: { [MCP_RESULT_BUDGET_KEY]: 128_000 },
      }),
    });
    const writeFirst = catalogEntries([write, read]);
    const writeWrapper = lazyCatalogTools("connectors", "mcp", "MCP", writeFirst)[2]!;
    expect(loadCatalogEntry(writeFirst, { id: writeFirst[0]!.id }).tool.description).toBe("write");
    expect(toolResultChars(writeWrapper, { id: writeFirst[0]!.id })).toBeUndefined();
    expect(toolResultChars(writeWrapper, { id: "dup" })).toBeUndefined();

    const readFirst = catalogEntries([read, write]);
    const readWrapper = lazyCatalogTools("connectors", "mcp", "MCP", readFirst)[2]!;
    expect(toolResultChars(readWrapper, { id: readFirst[0]!.id })).toBe(128_000);
  });
});
