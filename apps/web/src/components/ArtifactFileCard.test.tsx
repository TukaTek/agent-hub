// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

// The macros compile away in the app build; tests run the source.
vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
}));
vi.mock("@lingui/react/macro", async () => {
  const { t } = await import("@lingui/core/macro");
  return { Trans: ({ children }: { children: unknown }) => children, useLingui: () => ({ t }) };
});
vi.mock("../lib/artifact-open", () => ({
  downloadArtifact: vi.fn(async () => undefined),
  downloadArtifactBytes: vi.fn(),
  fetchArtifactBytes: vi.fn(async () => new Uint8Array()),
}));
vi.mock("./PdfViewer", () => ({ PdfViewer: () => null }));

import { downloadArtifact } from "../lib/artifact-open";
import { ArtifactFileCard } from "./ArtifactFileCard";

const DOWNLOAD_ONLY_TYPES = [
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.ms-excel",
  "application/msword",
  "application/vnd.ms-powerpoint",
  "application/zip",
];

let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
  vi.clearAllMocks();
});

async function render(mimeType: string) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <ArtifactFileCard
        target={{ botId: "bot_1" }}
        artifactId="art_1"
        name="report"
        mimeType={mimeType}
        size={10}
      />,
    );
  });
  cleanup = async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  };
  return container;
}

describe("ArtifactFileCard", () => {
  it.each(DOWNLOAD_ONLY_TYPES)("renders %s as a download-only card", async (mimeType) => {
    const container = await render(mimeType);
    const buttons = [...container.querySelectorAll("button")];
    expect(buttons.some((button) => button.getAttribute("aria-label")?.startsWith("Preview"))).toBe(
      false,
    );
    expect(container.querySelector("iframe, embed, object")).toBeNull();
    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.textContent).toBe("report10 B");
    await act(async () => buttons[0]?.click());
    expect(downloadArtifact).toHaveBeenCalledWith({ botId: "bot_1" }, "art_1", "report", mimeType);
  });

  it("still previews PDFs", async () => {
    const container = await render("application/pdf");
    expect(container.querySelector('button[aria-label="Preview report"]')).not.toBeNull();
  });
});
