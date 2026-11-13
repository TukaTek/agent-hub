import { waitForModelOAuthCompletion } from "@cortexai-agent-hub/core";
import { rpc } from "./api";

export { cancelModelOAuthAttempt, finishModelOAuthAttempt } from "@cortexai-agent-hub/core";

/** Polls with the caller's calls, which go to the Space that began the sign-in. */
export async function waitForModelOAuth(loginId: string, signal?: AbortSignal, call = rpc) {
  return waitForModelOAuthCompletion(() => call("models/completeOAuth", { loginId }, { signal }), {
    signal,
  });
}
