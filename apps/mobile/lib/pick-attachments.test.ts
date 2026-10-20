import { attachmentMaxBytes } from "@cortexai-agent-hub/contracts";
import { inferAttachmentMimeType } from "@cortexai-agent-hub/core";
import { describe, expect, it } from "vitest";
import { filterPickedAttachments } from "./pick-attachments-filter.js";

describe("filterPickedAttachments", () => {
  it("accepts picked MP3 audio but retains the 10 MiB cap", () => {
    const candidate = {
      name: "song.mp3",
      mimeType: inferAttachmentMimeType("song.mp3", "audio/mp3"),
      size: 10 * 1024 * 1024,
      contentBase64: "YXVkaW8=",
    };
    const result = filterPickedAttachments(0, [
      candidate,
      { ...candidate, name: "large.mp3", size: candidate.size + 1 },
    ]);
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0]).toMatchObject({ name: "song.mp3", mimeType: "audio/mpeg" });
    expect(result.skipped).toEqual([{ name: "large.mp3", reason: "over 10 MiB" }]);
  });
  it("uses the server limit and falls back for older servers", () => {
    const candidate = {
      name: "large.txt",
      mimeType: "text/plain",
      size: 11 * 1024 * 1024,
      contentBase64: "",
    };
    expect(
      filterPickedAttachments(
        0,
        [candidate],
        attachmentMaxBytes({ maxUploadSizeBytes: 12 * 1024 * 1024 }),
      ).attachments,
    ).toHaveLength(1);
    expect(filterPickedAttachments(0, [candidate], attachmentMaxBytes({})).skipped[0]?.reason).toBe(
      "over 10 MiB",
    );
    expect(
      filterPickedAttachments(
        0,
        [candidate],
        attachmentMaxBytes({ maxUploadSizeBytes: 2 * 1024 * 1024 }),
      ).skipped[0]?.reason,
    ).toBe("over 2 MiB");
  });
  it("skips unsupported mime types and oversize files", () => {
    const result = filterPickedAttachments(0, [
      {
        name: "notes.txt",
        mimeType: "text/plain",
        size: 12,
        contentBase64: "aGVsbG8=",
      },
      {
        name: "bundle.zip",
        mimeType: inferAttachmentMimeType("bundle.zip", "application/x-zip-compressed"),
        size: 12,
        contentBase64: "UEsDBA==",
      },
      {
        name: "payload.exe",
        mimeType: null,
        size: 12,
        contentBase64: "aGVsbG8=",
      },
      {
        name: "big.zip",
        mimeType: "application/zip",
        size: 10 * 1024 * 1024 + 1,
        contentBase64: "aGVsbG8=",
      },
    ]);
    expect(result.attachments.map((item) => item.name)).toEqual(["notes.txt", "bundle.zip"]);
    expect(result.attachments[1]).toMatchObject({
      name: "bundle.zip",
      mimeType: "application/zip",
    });
    expect(result.skipped.map((item) => item.name)).toEqual(["payload.exe", "big.zip"]);
  });

  it("assigns distinct ids to duplicate files", () => {
    const candidate = {
      name: "notes.txt",
      mimeType: "text/plain",
      size: 12,
      contentBase64: "aGVsbG8=",
    };
    const result = filterPickedAttachments(0, [candidate, candidate]);
    expect(result.attachments.map((attachment) => attachment.id)).toEqual([
      "notes.txt-12-0",
      "notes.txt-12-1",
    ]);
  });

  it("accepts Office documents and zip archives from the document picker", () => {
    const picked = [
      { name: "macro.xlsm", reported: "application/vnd.ms-excel.sheet.macroEnabled.12" },
      { name: "report.xlsx", reported: "" },
      { name: "brief.docx", reported: "application/octet-stream" },
      { name: "deck.pptx", reported: undefined },
      { name: "bundle.zip", reported: "application/x-zip-compressed" },
    ];
    const result = filterPickedAttachments(
      0,
      picked.map(({ name, reported }) => ({
        name,
        mimeType: inferAttachmentMimeType(name, reported),
        size: 12,
        contentBase64: "UEs=",
      })),
    );
    expect(result.attachments.map((item) => [item.name, item.mimeType])).toEqual([
      ["report.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
      ["brief.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
      ["deck.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
      ["bundle.zip", "application/zip"],
    ]);
    expect(result.skipped).toEqual([{ name: "macro.xlsm", reason: "unsupported type" }]);
  });
});
