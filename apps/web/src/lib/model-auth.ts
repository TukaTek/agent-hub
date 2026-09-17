import { waitForModelOAuthCompletion } from "@cortexai-agent-hub/core";
import { rpc } from "./rpc";

export type {
  ModelCatalogEntry,
  ModelCredential,
  ModelOAuthBegin,
} from "@cortexai-agent-hub/contracts";
export { cancelModelOAuthAttempt, finishModelOAuthAttempt } from "@cortexai-agent-hub/core";

export async function waitForModelOAuth(loginId: string, signal?: AbortSignal) {
  return waitForModelOAuthCompletion(() => rpc.models.completeOAuth({ loginId }, { signal }), {
    signal,
  });
}
