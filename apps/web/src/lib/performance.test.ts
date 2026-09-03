import { beforeEach, describe, expect, it, vi } from "vitest";
import { markAfterPaint, markOnce } from "./performance";

describe("performance marks", () => {
  beforeEach(() => {
    performance.clearMarks();
  });

  it("records a named mark only once", () => {
    markOnce("cortexai-agent-hub:test:once");
    markOnce("cortexai-agent-hub:test:once");

    expect(performance.getEntriesByName("cortexai-agent-hub:test:once")).toHaveLength(1);
  });

  it("records an after-paint mark after two animation frames", () => {
    const callbacks: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callbacks.push(callback);
      return callbacks.length;
    });

    markAfterPaint("cortexai-agent-hub:test:painted");
    expect(performance.getEntriesByName("cortexai-agent-hub:test:painted")).toHaveLength(0);
    callbacks.shift()?.(1);
    expect(performance.getEntriesByName("cortexai-agent-hub:test:painted")).toHaveLength(0);
    callbacks.shift()?.(2);
    expect(performance.getEntriesByName("cortexai-agent-hub:test:painted")).toHaveLength(1);

    vi.unstubAllGlobals();
  });
});
