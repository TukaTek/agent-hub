import type { ThreadMessage } from "@cortexai-agent-hub/contracts";
import { previewMessageText as previewText } from "@cortexai-agent-hub/core";
import { t } from "@lingui/core/macro";

export type PendingAttachment = {
  id: string;
  threadKey: string;
  file: File;
  previewUrl?: string;
};

/** Identity colour for bots the roster no longer knows about. */
export const FALLBACK_BOT_COLOR = "#85858A";

export function previewMessageText(message: ThreadMessage): string {
  return previewText(message, { photo: t`Photo`, attachment: t`Attachment`, message: t`Message` });
}
