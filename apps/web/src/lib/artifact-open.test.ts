// @vitest-environment jsdom

import { afterEach, expect, it, vi } from "vitest";

vi.mock("./rpc", () => ({ rpc: {} }));

import { downloadArtifactBytes } from "./artifact-open";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("downloads through an anchor with a download name instead of navigating", () => {
  vi.stubGlobal("URL", { ...URL, createObjectURL: () => "blob:test/1", revokeObjectURL: () => {} });
  const clicked: HTMLAnchorElement[] = [];
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    clicked.push(this);
  });

  downloadArtifactBytes(
    "report.xlsx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    new Uint8Array([0x50, 0x4b]),
  );

  expect(clicked).toHaveLength(1);
  expect(clicked[0]?.download).toBe("report.xlsx");
  expect(clicked[0]?.href).toBe("blob:test/1");
  expect(clicked[0]?.target).toBe("");
});
