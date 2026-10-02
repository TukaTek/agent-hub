import { describe, expect, it } from "vitest";
import {
  buildPlaybookFromRecording,
  promptInvokesSkill,
  sanitizeTeachRecordingEvent,
} from "./teach-playbook.js";

describe("promptInvokesSkill", () => {
  it("matches an explicit request to run the skill", () => {
    expect(promptInvokesSkill("run Export weekly CRM list", "Export weekly CRM list")).toBe(true);
    expect(promptInvokesSkill("Please use the Export CRM skill now", "Export CRM")).toBe(true);
  });

  it("ignores prompts that only mention the name in passing", () => {
    expect(promptInvokesSkill("export the notes to markdown", "Export")).toBe(false);
    expect(promptInvokesSkill("run the exporter script", "Export")).toBe(false);
    expect(promptInvokesSkill("run a report", "Export weekly CRM list")).toBe(false);
  });

  it("skips prompts that already carry the playbook and very short names", () => {
    expect(promptInvokesSkill("Run taught skill: Export\nSteps:", "Export")).toBe(false);
    expect(promptInvokesSkill("run cs now", "cs")).toBe(false);
  });
});

describe("buildPlaybookFromRecording", () => {
  it("turns pointer and typing events into steps", () => {
    const playbook = buildPlaybookFromRecording(
      "Export weekly CRM list",
      [
        { at: "2026-01-01T00:00:00.000Z", kind: "pointer", x: 120, y: 40, type: "click" },
        { at: "2026-01-01T00:00:01.000Z", kind: "clipboard", text: "weekly-export.csv", keepLiteral: true },
      ],
      [{ at: "2026-01-01T00:00:02.000Z", summary: "Export dialog open" }],
    );

    expect(playbook.steps.some((step) => step.includes("Click"))).toBe(true);
    expect(playbook.steps.some((step) => step.includes("weekly-export.csv"))).toBe(true);
    expect(playbook.steps.some((step) => step.includes("Export dialog open"))).toBe(false);
    expect(playbook.howToCheck).toContain("Export dialog open");
    expect(playbook.whenToUse).toContain("Export weekly CRM list");
    expect(playbook.approvalBoundaries.length).toBeGreaterThan(0);
    expect(playbook.failureHandling.length).toBeGreaterThan(0);
  });

  it("fills approval and failure fields when the demo lacked them", () => {
    const playbook = buildPlaybookFromRecording("Save a note", []);
    expect(playbook.approvalBoundaries).toContain("approval");
    expect(playbook.failureHandling).toContain("stop");
    expect(playbook.steps.length).toBeGreaterThan(0);
  });

  it("redacts obvious password-like input", () => {
    const playbook = buildPlaybookFromRecording("Sign in", [
      { at: "2026-01-01T00:00:00.000Z", kind: "clipboard", text: "my-password" },
    ]);
    expect(playbook.steps.join(" ")).toContain("[redacted input]");
  });

  it("coalesces consecutive typed characters and keeps repeated keys", () => {
    const playbook = buildPlaybookFromRecording("Search", [
      { at: "2026-01-01T00:00:00.000Z", kind: "key", key: "b", keepLiteral: true },
      { at: "2026-01-01T00:00:00.100Z", kind: "key", key: "o", keepLiteral: true },
      { at: "2026-01-01T00:00:00.200Z", kind: "key", key: "o", keepLiteral: true },
      { at: "2026-01-01T00:00:00.300Z", kind: "key", key: "k", keepLiteral: true },
      { at: "2026-01-01T00:00:00.400Z", kind: "key", key: "Enter" },
    ]);
    expect(playbook.steps).toEqual(['Type "book".', "Press key: Enter."]);
  });

  it("keeps spaces typed during a demo", () => {
    const playbook = buildPlaybookFromRecording("Search", [
      { at: "2026-01-01T00:00:00.000Z", kind: "key", key: "h", keepLiteral: true },
      { at: "2026-01-01T00:00:00.100Z", kind: "key", key: "i", keepLiteral: true },
      { at: "2026-01-01T00:00:00.200Z", kind: "key", key: " ", keepLiteral: true },
      { at: "2026-01-01T00:00:00.300Z", kind: "key", key: "t", keepLiteral: true },
      { at: "2026-01-01T00:00:00.400Z", kind: "key", key: "h", keepLiteral: true },
      { at: "2026-01-01T00:00:00.500Z", kind: "key", key: "e", keepLiteral: true },
      { at: "2026-01-01T00:00:00.600Z", kind: "key", key: "r", keepLiteral: true },
      { at: "2026-01-01T00:00:00.700Z", kind: "key", key: "e", keepLiteral: true },
    ]);
    expect(playbook.steps).toEqual(['Type "hi there".']);
  });

  it("collapses a run of protected keystrokes into one redacted step", () => {
    const playbook = buildPlaybookFromRecording("Sign in", [
      { at: "2026-01-01T00:00:00.000Z", kind: "key", key: "u", keepLiteral: true },
      { at: "2026-01-01T00:00:00.100Z", kind: "key", key: "s", keepLiteral: true },
      { at: "2026-01-01T00:00:00.200Z", kind: "key", key: "e", keepLiteral: true },
      { at: "2026-01-01T00:00:00.300Z", kind: "key", key: "r", keepLiteral: true },
      { at: "2026-01-01T00:00:00.400Z", kind: "key", sensitive: true },
      { at: "2026-01-01T00:00:00.500Z", kind: "key", sensitive: true },
      { at: "2026-01-01T00:00:00.600Z", kind: "key", sensitive: true },
      { at: "2026-01-01T00:00:00.700Z", kind: "key", sensitive: true },
      { at: "2026-01-01T00:00:00.800Z", kind: "key", key: "Enter" },
    ]);
    expect(playbook.steps).toEqual([
      'Type "user".',
      'Type "[redacted input]".',
      "Press key: Enter.",
    ]);
  });

  it("never renders the payload of a protected event", () => {
    const playbook = buildPlaybookFromRecording("Sign in", [
      { at: "2026-01-01T00:00:00.000Z", kind: "key", key: "x", sensitive: true },
      { at: "2026-01-01T00:00:00.100Z", kind: "clipboard", text: "hunter2", sensitive: true },
    ]);
    expect(playbook.steps.join(" ")).toContain("[redacted input]");
    expect(playbook.steps.join(" ")).not.toContain("hunter2");
    expect(playbook.steps.join(" ")).not.toContain('"x"');
  });

  it("resumes ordinary typing after a protected run", () => {
    const playbook = buildPlaybookFromRecording("Sign in", [
      { at: "2026-01-01T00:00:00.000Z", kind: "key", sensitive: true },
      { at: "2026-01-01T00:00:00.100Z", kind: "key", sensitive: true },
      { at: "2026-01-01T00:00:00.200Z", kind: "key", key: "o" },
      { at: "2026-01-01T00:00:00.300Z", kind: "key", key: "k" },
    ]);
    expect(playbook.steps).toEqual(['Type "[redacted input]".', 'Type "ok".']);
  });

  it("redacts typed credentials the same way as clipboard input", () => {
    const playbook = buildPlaybookFromRecording("Sign in", [
      { at: "2026-01-01T00:00:00.000Z", kind: "key", key: "p" },
      { at: "2026-01-01T00:00:00.100Z", kind: "key", key: "a" },
      { at: "2026-01-01T00:00:00.200Z", kind: "key", key: "s" },
      { at: "2026-01-01T00:00:00.300Z", kind: "key", key: "s" },
      { at: "2026-01-01T00:00:00.400Z", kind: "key", key: "w" },
      { at: "2026-01-01T00:00:00.500Z", kind: "key", key: "o" },
      { at: "2026-01-01T00:00:00.600Z", kind: "key", key: "r" },
      { at: "2026-01-01T00:00:00.700Z", kind: "key", key: "d" },
    ]);
    expect(playbook.steps.join(" ")).toContain("[redacted input]");
    expect(playbook.steps.join(" ")).not.toContain("password");
  });

  it("coalesces a press-and-release into a click and keeps a drag", () => {
    const click = buildPlaybookFromRecording("Open", [
      { at: "2026-01-01T00:00:00.000Z", kind: "pointer", x: 10, y: 20, type: "down" },
      { at: "2026-01-01T00:00:00.050Z", kind: "pointer", x: 10, y: 20, type: "up" },
    ]);
    expect(click.steps).toEqual(["Click left button at (10, 20)."]);

    const drag = buildPlaybookFromRecording("Move", [
      { at: "2026-01-01T00:00:00.000Z", kind: "pointer", x: 10, y: 20, type: "down" },
      { at: "2026-01-01T00:00:00.050Z", kind: "pointer", x: 80, y: 90, type: "move" },
      { at: "2026-01-01T00:00:00.080Z", kind: "pointer", x: 80, y: 90, type: "up" },
    ]);
    expect(drag.steps).toEqual(["Drag left button from (10, 20) to (80, 90)."]);
  });

  it("records scroll steps from a demo", () => {
    const playbook = buildPlaybookFromRecording("Scroll the list", [
      { at: "2026-01-01T00:00:00.000Z", kind: "scroll", type: "down", text: "3" },
    ]);
    expect(playbook.steps).toEqual(["Scroll down 3 times."]);
  });
});

describe("sanitizeTeachRecordingEvent", () => {
  it("strips the captured value from a protected event", () => {
    expect(
      sanitizeTeachRecordingEvent({
        at: "2026-01-01T00:00:00.000Z",
        kind: "clipboard",
        text: "hunter2",
        sensitive: true,
      }),
    ).toEqual({ at: "2026-01-01T00:00:00.000Z", kind: "clipboard", sensitive: true });
    expect(
      sanitizeTeachRecordingEvent({
        at: "2026-01-01T00:00:00.000Z",
        kind: "key",
        key: "x",
        sensitive: true,
      }),
    ).toEqual({ at: "2026-01-01T00:00:00.000Z", kind: "key", sensitive: true });
  });

  it("leaves ordinary events untouched", () => {
    const event = {
      at: "2026-01-01T00:00:00.000Z",
      kind: "clipboard" as const,
      text: "weekly-export.csv",
    };
    expect(sanitizeTeachRecordingEvent(event)).toEqual(event);
  });
});

describe("secret field detection and redaction", () => {
  it("treats password type fields as sensitive", () => {
    const playbook = buildPlaybookFromRecording("Sign in", [
      { at: "2026-01-01T00:00:00.000Z", kind: "key", key: "S", fieldType: "password" },
      { at: "2026-01-01T00:00:01.000Z", kind: "key", key: "u", fieldType: "password" },
      { at: "2026-01-01T00:00:02.000Z", kind: "key", key: "m", fieldType: "password" },
      { at: "2026-01-01T00:00:03.000Z", kind: "key", key: "m", fieldType: "password" },
      { at: "2026-01-01T00:00:04.000Z", kind: "key", key: "e", fieldType: "password" },
      { at: "2026-01-01T00:00:05.000Z", kind: "key", key: "r", fieldType: "password" },
      { at: "2026-01-01T00:00:06.000Z", kind: "key", key: "2", fieldType: "password" },
      { at: "2026-01-01T00:00:07.000Z", kind: "key", key: "0", fieldType: "password" },
      { at: "2026-01-01T00:00:08.000Z", kind: "key", key: "2", fieldType: "password" },
      { at: "2026-01-01T00:00:09.000Z", kind: "key", key: "6", fieldType: "password" },
      { at: "2026-01-01T00:00:10.000Z", kind: "key", key: "!", fieldType: "password" },
    ]);
    expect(playbook.steps.join(" ")).toContain("{{secret:");
    expect(playbook.steps.join(" ")).not.toContain("Summer2026!");
  });

  it("treats autocomplete=current-password fields as sensitive", () => {
    const playbook = buildPlaybookFromRecording("Sign in", [
      {
        at: "2026-01-01T00:00:00.000Z",
        kind: "clipboard",
        text: "MyP@ssw0rd!",
        autocomplete: "current-password",
      },
    ]);
    expect(playbook.steps.join(" ")).toContain("{{secret:");
    expect(playbook.steps.join(" ")).not.toContain("MyP@ssw0rd!");
  });

  it("treats autocomplete=new-password fields as sensitive", () => {
    const playbook = buildPlaybookFromRecording("Change password", [
      {
        at: "2026-01-01T00:00:00.000Z",
        kind: "key",
        key: "N",
        autocomplete: "new-password",
      },
      {
        at: "2026-01-01T00:00:01.000Z",
        kind: "key",
        key: "e",
        autocomplete: "new-password",
      },
      {
        at: "2026-01-01T00:00:02.000Z",
        kind: "key",
        key: "w",
        autocomplete: "new-password",
      },
    ]);
    expect(playbook.steps.join(" ")).toContain("{{secret:");
    expect(playbook.steps.join(" ")).not.toContain("New");
  });

  it("treats autocomplete=one-time-code fields as sensitive", () => {
    const playbook = buildPlaybookFromRecording("Enter MFA code", [
      { at: "2026-01-01T00:00:00.000Z", kind: "key", key: "1", autocomplete: "one-time-code" },
      { at: "2026-01-01T00:00:01.000Z", kind: "key", key: "2", autocomplete: "one-time-code" },
      { at: "2026-01-01T00:00:02.000Z", kind: "key", key: "3", autocomplete: "one-time-code" },
      { at: "2026-01-01T00:00:03.000Z", kind: "key", key: "4", autocomplete: "one-time-code" },
      { at: "2026-01-01T00:00:04.000Z", kind: "key", key: "5", autocomplete: "one-time-code" },
      { at: "2026-01-01T00:00:05.000Z", kind: "key", key: "6", autocomplete: "one-time-code" },
    ]);
    expect(playbook.steps.join(" ")).toContain("{{secret:");
    expect(playbook.steps.join(" ")).not.toContain("123456");
  });

  it("stores regular text from non-sensitive fields", () => {
    const playbook = buildPlaybookFromRecording("Search", [
      { at: "2026-01-01T00:00:00.000Z", kind: "key", key: "h", fieldType: "text" },
      { at: "2026-01-01T00:00:01.000Z", kind: "key", key: "i", fieldType: "text" },
    ]);
    expect(playbook.steps.join(" ")).toContain('"hi"');
    expect(playbook.steps.join(" ")).not.toContain("{{secret:");
  });

  it("respects user-marked sensitive flag even without password type", () => {
    const playbook = buildPlaybookFromRecording("Enter API key", [
      { at: "2026-01-01T00:00:00.000Z", kind: "key", key: "s", sensitive: true },
      { at: "2026-01-01T00:00:01.000Z", kind: "key", key: "k", sensitive: true },
    ]);
    expect(playbook.steps.join(" ")).toContain("[redacted input]");
    expect(playbook.steps.join(" ")).not.toContain("sk");
  });

  it("keeps Protected input working as before", () => {
    const playbook = buildPlaybookFromRecording("Sign in", [
      { at: "2026-01-01T00:00:00.000Z", kind: "key", key: "h", sensitive: true },
      { at: "2026-01-01T00:00:01.000Z", kind: "key", key: "i", sensitive: true },
    ]);
    expect(playbook.steps).toContain('Type "[redacted input]".');
  });
});
