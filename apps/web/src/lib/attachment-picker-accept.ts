import { ATTACHMENT_ACCEPT } from "@cortexai-agent-hub/core";

/**
 * Android's document picker can filter out CSV files when the accept attribute
 * combines many MIME types. Allow the picker to show files on Android; the
 * attachment preparation and API still reject unsupported formats and sizes.
 * Elsewhere, list extensions too, because some OS pickers mislabel Office files.
 */
export function attachmentPickerAccept(userAgent: string): string {
  if (/\bAndroid\b/i.test(userAgent)) return "*/*";
  return ATTACHMENT_ACCEPT;
}
