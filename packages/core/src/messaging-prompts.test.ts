import { describe, expect, it } from "vitest";
import { isMessagingChannelRun, messagingDmSurfaceNote } from "./messaging-prompts.js";

describe("messagingDmSurfaceNote", () => {
  it("says attached files are not mirrored to the messaging chat", () => {
    const note = messagingDmSurfaceNote();
    expect(note).toMatch(/only text is mirrored/i);
    expect(note).toMatch(/attach_file/);
    expect(note).toMatch(/Agent Hub/);
  });
});

describe("isMessagingChannelRun", () => {
  const channelBlock = {
    kind: "channel_message" as const,
    provider: "sendblue",
    channelId: "ch-1",
    fromAddress: "+15551234567",
    fromLabel: "Alice",
    text: "hi",
  };

  it("detects channel runs from the source message blocks", () => {
    expect(isMessagingChannelRun("messaging", [channelBlock])).toBe(true);
    expect(isMessagingChannelRun("messaging", [{ kind: "text", text: "hi" }])).toBe(false);
    expect(isMessagingChannelRun("user", [channelBlock])).toBe(false);
    expect(isMessagingChannelRun("messaging", undefined)).toBe(false);
  });
});
