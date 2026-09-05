import type { AppContract } from "@cortexai-agent-hub/contracts";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ContractRouterClient } from "@orpc/contract";

const SPACE_STORAGE_KEY = "cortexai-agent-hub:space-id";

type RpcClientContext = { spaceId?: string | null };

export function selectedSpaceId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(SPACE_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function selectSpace(id: string): boolean {
  try {
    window.localStorage.setItem(SPACE_STORAGE_KEY, id);
    return true;
  } catch {
    try {
      // Write failed but the desired selection is already durable — treat as success.
      return window.localStorage.getItem(SPACE_STORAGE_KEY) === id;
    } catch {
      return false;
    }
  }
}

export function clearSpaceSelection(): void {
  try {
    window.localStorage.removeItem(SPACE_STORAGE_KEY);
  } catch {
    // Ignore storage failures on sign-out / reset paths.
  }
}

/** Adds `x-cortexai-agent-hub-space-id` when a space is selected. */
export function withSpaceHeaders(
  init?: HeadersInit,
  spaceId: string | null = selectedSpaceId(),
): Headers {
  const headers = new Headers(init);
  if (spaceId) headers.set("x-cortexai-agent-hub-space-id", spaceId);
  else headers.delete("x-cortexai-agent-hub-space-id");
  return headers;
}

const link = new RPCLink<RpcClientContext>({
  url: () =>
    typeof window === "undefined" ? "http://127.0.0.1:5173/rpc" : `${window.location.origin}/rpc`,
  fetch: (input, init, options) => {
    const request = new Request(input, init);
    const spaceId =
      options.context.spaceId === undefined ? selectedSpaceId() : options.context.spaceId;
    return fetch(request, {
      headers: withSpaceHeaders(request.headers, spaceId),
      credentials: "include",
    });
  },
});

export const rpc: ContractRouterClient<AppContract, RpcClientContext> = createORPCClient(link);
