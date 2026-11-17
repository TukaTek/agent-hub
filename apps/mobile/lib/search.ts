import type { SearchHit } from "@cortexai-agent-hub/contracts";
import { rpc } from "./api";

export async function querySpaceSearch(q: string, signal?: AbortSignal): Promise<SearchHit[]> {
  const trimmed = q.trim();
  if (!trimmed) return [];
  const result = await rpc("search/query", { q: trimmed }, { signal });
  return result.hits;
}
