import path from "node:path";
import { supportedAttachmentExtensions } from "@cortexai-agent-hub/core";

/** A workspace path in chat is a dead link on every surface, so failures must say so in words. */
export const ATTACH_FAILURE_GUIDANCE =
  "Tell the user plainly that the file could not be attached; do not link the workspace path.";

export function attachFailure(reason: string): string {
  return `${reason}. ${ATTACH_FAILURE_GUIDANCE}`;
}

export function unsupportedAttachmentError(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase() || "(none)";
  return attachFailure(
    `unsupported attachment type "${extension}". Supported: ${supportedAttachmentExtensions().join(" ")}`,
  );
}
