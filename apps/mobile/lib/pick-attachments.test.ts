import { inferAttachmentMimeType } from "@cortexai-agent-hub/core";
import { describe, expect, it } from "vitest";
import { filterPickedAttachments } from "./pick-attachments-filter.js";

describe("filterPickedAttachments", () => {
  it("skips unsupported mime types and oversize files", () => {
    const result = filterPickedAttachments(0, [
      {
        name: "notes.txt",
        mimeType: "text/plain",
        size: 12,
        contentBase64: "aGVsbG8=",
      },
      {
        name: "evil.exe",
        mimeType: null,
        size: 12,
        contentBase64: "aGVsbG8=",
      },
      {
        name: "big.bin",
        mimeType: "text/plain",
        size: 11 * 1024 * 1024,
        contentBase64: "aGVsbG8=",
      },
    ]);
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0]?.name).toBe("notes.txt");
    expect(result.skipped.map((item) => item.name)).toEqual(["evil.exe", "big.bin"]);
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
