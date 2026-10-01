import { describe, expect, it } from "vitest";
import {
  ATTACH_FAILURE_GUIDANCE,
  attachFailure,
  unsupportedAttachmentError,
} from "./attach-file-errors.js";

describe("attach_file errors", () => {
  it("names the type, lists what works, and forbids path links", () => {
    const message = unsupportedAttachmentError("out/macro.xlsm");
    expect(message).toMatch(/^unsupported attachment type "\.xlsm"\./);
    for (const extension of [".pdf", ".csv", ".xlsx", ".docx", ".pptx", ".xls", ".zip"]) {
      expect(message).toContain(extension);
    }
    expect(message).toMatch(/do not link the workspace path/i);
  });

  it("describes a file with no extension", () => {
    expect(unsupportedAttachmentError("out/README")).toMatch(
      /^unsupported attachment type "\(none\)"/,
    );
  });

  it("adds the same guidance to every other attach failure", () => {
    expect(attachFailure("file not found or unreadable")).toBe(
      `file not found or unreadable. ${ATTACH_FAILURE_GUIDANCE}`,
    );
  });
});
