import type { ListSearchOptions } from "@cortexai-agent-hub/core";
import { listSearch } from "@cortexai-agent-hub/core";
import { useState } from "react";

export function useListSearch<T>(items: readonly T[], options: ListSearchOptions<T>) {
  const [query, setQuery] = useState("");
  return { query, setQuery, ...listSearch(items, query, options) };
}
