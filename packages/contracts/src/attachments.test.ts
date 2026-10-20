import { describe, expect, it } from "vitest";
import {
  ATTACHMENT_ALLOWED_MIME_TYPES,
  ATTACHMENT_AUDIO_MIME_TYPES,
  isAllowedAttachmentMimeType,
  isAttachmentAudioMimeType,
  isAttachmentImageMimeType,
  MessageBlock,
  validateThreadsSendInput,
} from "./index.js";

describe("attachment contracts", () => {
  it("allows Office documents and zip archives as files", () => {
    for (const mimeType of [
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "application/vnd.ms-excel",
      "application/msword",
      "application/vnd.ms-powerpoint",
      "application/zip",
    ]) {
      expect(isAllowedAttachmentMimeType(mimeType)).toBe(true);
      expect(isAttachmentImageMimeType(mimeType)).toBe(false);
    }
  });

  it("keeps macro-enabled and auto-run Office types out", () => {
    for (const mimeType of [
      "application/vnd.ms-excel.sheet.macroEnabled.12",
      "application/vnd.ms-excel.sheet.binary.macroEnabled.12",
      "application/vnd.ms-word.document.macroEnabled.12",
      "application/vnd.ms-powerpoint.presentation.macroEnabled.12",
      "application/vnd.openxmlformats-officedocument.presentationml.slideshow",
      "application/vnd.ms-powerpoint.slideshow.macroEnabled.12",
      "application/x-zip-compressed",
    ]) {
      expect(isAllowedAttachmentMimeType(mimeType)).toBe(false);
    }
    expect(new Set(ATTACHMENT_ALLOWED_MIME_TYPES).size).toBe(ATTACHMENT_ALLOWED_MIME_TYPES.length);
  });

  it.each(ATTACHMENT_AUDIO_MIME_TYPES)("allows %s as an audio file block", (mimeType) => {
    expect(isAllowedAttachmentMimeType(mimeType)).toBe(true);
    expect(isAttachmentAudioMimeType(mimeType)).toBe(true);
    expect(
      MessageBlock.parse({ kind: "file", artifactId: "audio-1", mimeType, name: "clip", size: 42 }),
    ).toMatchObject({ kind: "file", mimeType });
  });
  it("rejects unknown audio", () => {
    expect(isAllowedAttachmentMimeType("audio/flac")).toBe(false);
    expect(isAttachmentAudioMimeType("audio/flac")).toBe(false);
    expect(isAttachmentAudioMimeType("video/mp4")).toBe(false);
  });
  it("requires text or attachments for threads.send", () => {
    expect(validateThreadsSendInput({ text: "hello" })).toBe(true);
    expect(validateThreadsSendInput({ artifactIds: ["art_1"] })).toBe(true);
    expect(validateThreadsSendInput({})).toBe(false);
    expect(validateThreadsSendInput({ artifactIds: ["a", "b", "c", "d", "e"] })).toBe(true);
  });
});
