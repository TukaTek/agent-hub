import { describe, expect, it } from "vitest";
import {
  ATTACHMENT_ALLOWED_MIME_TYPES,
  ATTACHMENT_AUDIO_MIME_TYPES,
  appContract,
  artifactPreviewKind,
  attachmentMaxCount,
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

  it("falls back to four attachments for older servers", () => {
    expect(attachmentMaxCount()).toBe(4);
    expect(attachmentMaxCount(null)).toBe(4);
    expect(attachmentMaxCount({})).toBe(4);
    expect(attachmentMaxCount({ maxAttachmentsPerMessage: 8 })).toBe(8);
  });
  it("allows configured counts through the RPC schema up to the hard ceiling", () => {
    const schema = appContract.threads.send["~orpc"].inputSchema!;
    for (const count of [4, 5, 100]) {
      expect(
        schema.safeParse({
          botId: "bot-1",
          artifactIds: Array.from({ length: count }, (_, i) => `artifact-${i}`),
        }).success,
      ).toBe(true);
    }
    expect(
      schema.safeParse({
        botId: "bot-1",
        artifactIds: Array.from({ length: 101 }, (_, i) => `artifact-${i}`),
      }).success,
    ).toBe(false);
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

  it("previews text files as text on every client", () => {
    expect(artifactPreviewKind("text/plain")).toBe("text");
    expect(artifactPreviewKind("text/csv; charset=utf-8")).toBe("text");
    expect(artifactPreviewKind("application/json")).toBe("text");
    expect(artifactPreviewKind("text/markdown")).toBe("markdown");
    expect(artifactPreviewKind("text/html")).toBe("html");
    expect(artifactPreviewKind("video/mp4")).toBe("video");
    expect(artifactPreviewKind("application/pdf")).toBe("pdf");
    expect(artifactPreviewKind("image/png")).toBe("image");
    expect(artifactPreviewKind("application/zip")).toBe("none");
  });
});
