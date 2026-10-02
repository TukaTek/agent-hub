import { describe, expect, it } from "vitest";
import {
  buildPlaybookFromRecording,
  formatSkillRunPrompt,
  isSecretTeachField,
  promptInvokesSkill,
  sanitizeTeachRecordingEvent,
  type TeachRecordingEvent,
} from "./teach-playbook.js";

const at = (ms: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, 0, ms)).toISOString();

function typed(text: string, extra: Partial<TeachRecordingEvent> = {}): TeachRecordingEvent[] {
  return [...text].map((key, index) => ({ at: at(index), kind: "key" as const, key, ...extra }));
}

function serialized(value: unknown): string {
  return JSON.stringify(value);
}

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
  it("turns pointer and opted-in literal input into steps", () => {
    const playbook = buildPlaybookFromRecording(
      "Export weekly CRM list",
      [
        { at: at(0), kind: "pointer", x: 120, y: 40, type: "click" },
        { at: at(1), kind: "clipboard", text: "weekly-export.csv", keepLiteral: true },
      ],
      [{ at: at(2), summary: "Export dialog open" }],
    );

    expect(playbook.steps).toEqual([
      "Click left button at (120, 40).",
      "Paste or type: weekly-export.csv.",
    ]);
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

  describe("typed text", () => {
    it("stores ordinary typed text as a numbered placeholder, never literally", () => {
      const playbook = buildPlaybookFromRecording("Search", [
        ...typed("Summer2026!"),
        { at: at(20), kind: "key", key: "Enter" },
        ...typed("second"),
      ]);
      expect(playbook.steps).toEqual([
        'Type "{{input:typed text 1}}".',
        "Press key: Enter.",
        'Type "{{input:typed text 2}}".',
      ]);
      expect(serialized(playbook)).not.toContain("Summer2026!");
      expect(serialized(playbook)).not.toContain("second");
    });

    it("keeps typed text literally only when each keystroke opted in", () => {
      const playbook = buildPlaybookFromRecording("Search", [
        ...typed("hi there", { keepLiteral: true }),
        { at: at(20), kind: "key", key: "Enter" },
      ]);
      expect(playbook.steps).toEqual(['Type "hi there".', "Press key: Enter."]);
    });

    it("still redacts opted-in text that looks like a credential", () => {
      const playbook = buildPlaybookFromRecording(
        "Sign in",
        typed("password", { keepLiteral: true }),
      );
      expect(playbook.steps).toEqual(['Type "[redacted input]".']);
    });

    it("names the placeholder after the field when the client reported its label", () => {
      const playbook = buildPlaybookFromRecording(
        "Search",
        typed("acme", { fieldType: "search", fieldLabel: 'Customer "name"' }),
      );
      expect(playbook.steps).toEqual(['Type "{{input:Customer name}}".']);
    });

    it("never emits a literal from legacy rows that still hold raw keystrokes", () => {
      const playbook = buildPlaybookFromRecording("Sign in", [
        ...typed("alice"),
        { at: at(10), kind: "key", key: "Tab" },
        ...typed("Summer2026!"),
        { at: at(30), kind: "key", key: "Shift+S" },
      ]);
      expect(serialized(playbook)).not.toContain("Summer2026!");
      expect(serialized(playbook)).not.toContain("alice");
      expect(serialized(playbook)).not.toContain("Shift+S");
      expect(playbook.steps).toEqual([
        'Type "{{input:typed text 1}}".',
        "Press key: Tab.",
        'Type "{{input:typed text 2}}".',
      ]);
    });

    it("builds the same steps from sanitized events as from raw ones", () => {
      const raw = [...typed("user"), { at: at(10), kind: "key" as const, key: "Enter" }];
      expect(buildPlaybookFromRecording("x", raw.map(sanitizeTeachRecordingEvent)).steps).toEqual(
        buildPlaybookFromRecording("x", raw).steps,
      );
    });
  });

  describe("password, one-time-code and user-marked secret fields", () => {
    it.each([
      ["type=password", { fieldType: "password" }, "password"],
      ["autocomplete=current-password", { autocomplete: "current-password" }, "password"],
      ["autocomplete=new-password", { autocomplete: "section-x new-password" }, "password"],
      ["autocomplete=one-time-code", { autocomplete: "one-time-code" }, "one-time code"],
      ["a sensitive-looking label", { fieldType: "text", fieldLabel: "PIN" }, "PIN"],
    ] as const)(
      "replaces keystrokes in a %s field with a secret placeholder",
      (_name, field, label) => {
        const playbook = buildPlaybookFromRecording("Sign in", [
          ...typed("Summer2026!", { ...field, keepLiteral: true }),
          { at: at(20), kind: "key", key: "Enter", ...field },
        ]);
        expect(playbook.steps).toEqual([`Type "{{secret:${label}}}".`, "Press key: Enter."]);
        expect(serialized(playbook)).not.toContain("Summer2026!");
      },
    );

    it("uses the reported field label in the secret placeholder", () => {
      const playbook = buildPlaybookFromRecording(
        "Sign in",
        typed("hunter2", { fieldType: "password", fieldLabel: "Account password" }),
      );
      expect(playbook.steps).toEqual(['Type "{{secret:Account password}}".']);
    });

    it("replaces a paste or autofill into a password field even when opted in", () => {
      const playbook = buildPlaybookFromRecording("Sign in", [
        {
          at: at(0),
          kind: "clipboard",
          text: "Summer2026!",
          fieldType: "password",
          keepLiteral: true,
        },
        { at: at(1), kind: "clipboard", text: "481516", autocomplete: "one-time-code" },
      ]);
      expect(playbook.steps).toEqual([
        "Paste or type: {{secret:password}}.",
        "Paste or type: {{secret:one-time code}}.",
      ]);
      expect(serialized(playbook)).not.toMatch(/Summer2026!|481516/);
    });
  });

  describe("pasted text", () => {
    it("stores ordinary pastes as a numbered placeholder", () => {
      const playbook = buildPlaybookFromRecording("Fill", [
        { at: at(0), kind: "clipboard", text: "Summer2026!" },
        { at: at(1), kind: "clipboard", text: "weekly" },
      ]);
      expect(playbook.steps).toEqual([
        "Paste or type: {{input:pasted text 1}}.",
        "Paste or type: {{input:pasted text 2}}.",
      ]);
    });

    it("redacts obvious password-like input even when opted in", () => {
      const playbook = buildPlaybookFromRecording("Sign in", [
        { at: at(0), kind: "clipboard", text: "my-password", keepLiteral: true },
      ]);
      expect(playbook.steps).toEqual(["Paste or type: [redacted input]."]);
    });
  });

  describe("Protected input (unchanged)", () => {
    it("collapses a run of protected keystrokes into one redacted step", () => {
      const playbook = buildPlaybookFromRecording("Sign in", [
        ...typed("user", { keepLiteral: true }),
        { at: at(4), kind: "key", sensitive: true },
        { at: at(5), kind: "key", sensitive: true },
        { at: at(6), kind: "key", sensitive: true },
        { at: at(8), kind: "key", key: "Enter" },
      ]);
      expect(playbook.steps).toEqual([
        'Type "user".',
        'Type "[redacted input]".',
        "Press key: Enter.",
      ]);
    });

    it("never renders the payload of a protected event", () => {
      const playbook = buildPlaybookFromRecording("Sign in", [
        { at: at(0), kind: "key", key: "x", sensitive: true },
        { at: at(1), kind: "clipboard", text: "hunter2", sensitive: true },
      ]);
      expect(playbook.steps).toEqual([
        'Type "[redacted input]".',
        "Paste or type: [redacted input].",
      ]);
    });

    it("resumes ordinary typing after a protected run", () => {
      const playbook = buildPlaybookFromRecording("Sign in", [
        { at: at(0), kind: "key", sensitive: true },
        { at: at(1), kind: "key", sensitive: true },
        ...typed("ok", { keepLiteral: true }),
      ]);
      expect(playbook.steps).toEqual(['Type "[redacted input]".', 'Type "ok".']);
    });
  });

  it("coalesces a press-and-release into a click and keeps a drag", () => {
    const click = buildPlaybookFromRecording("Open", [
      { at: at(0), kind: "pointer", x: 10, y: 20, type: "down" },
      { at: at(50), kind: "pointer", x: 10, y: 20, type: "up" },
    ]);
    expect(click.steps).toEqual(["Click left button at (10, 20)."]);

    const drag = buildPlaybookFromRecording("Move", [
      { at: at(0), kind: "pointer", x: 10, y: 20, type: "down" },
      { at: at(50), kind: "pointer", x: 80, y: 90, type: "move" },
      { at: at(80), kind: "pointer", x: 80, y: 90, type: "up" },
    ]);
    expect(drag.steps).toEqual(["Drag left button from (10, 20) to (80, 90)."]);
  });

  it("records scroll steps from a demo", () => {
    const playbook = buildPlaybookFromRecording("Scroll the list", [
      { at: at(0), kind: "scroll", type: "down", text: "3" },
    ]);
    expect(playbook.steps).toEqual(["Scroll down 3 times."]);
  });
});

describe("isSecretTeachField", () => {
  it("flags Protected input, password and one-time-code fields and secret labels", () => {
    expect(isSecretTeachField({ sensitive: true })).toBe(true);
    expect(isSecretTeachField({ fieldType: "PASSWORD" })).toBe(true);
    expect(isSecretTeachField({ autocomplete: "username current-password" })).toBe(true);
    expect(isSecretTeachField({ autocomplete: "one-time-code" })).toBe(true);
    expect(isSecretTeachField({ fieldLabel: "Verification code" })).toBe(true);
    expect(isSecretTeachField({ fieldLabel: "API key" })).toBe(true);
  });

  it("leaves ordinary fields alone", () => {
    expect(isSecretTeachField({})).toBe(false);
    expect(isSecretTeachField({ fieldType: "email", autocomplete: "username" })).toBe(false);
    expect(isSecretTeachField({ fieldLabel: "Search customers" })).toBe(false);
  });
});

describe("sanitizeTeachRecordingEvent", () => {
  it("strips the captured value from a protected event exactly as before", () => {
    expect(
      sanitizeTeachRecordingEvent({
        at: at(0),
        kind: "clipboard",
        text: "hunter2",
        sensitive: true,
      }),
    ).toEqual({ at: at(0), kind: "clipboard", sensitive: true });
    expect(
      sanitizeTeachRecordingEvent({ at: at(0), kind: "key", key: "x", sensitive: true }),
    ).toEqual({ at: at(0), kind: "key", sensitive: true });
  });

  it("drops ordinary typed characters and pastes and marks them redacted", () => {
    expect(sanitizeTeachRecordingEvent({ at: at(0), kind: "key", key: "S" })).toEqual({
      at: at(0),
      kind: "key",
      redacted: true,
    });
    expect(sanitizeTeachRecordingEvent({ at: at(0), kind: "key", key: "Shift+S" })).toEqual({
      at: at(0),
      kind: "key",
      redacted: true,
    });
    expect(
      sanitizeTeachRecordingEvent({ at: at(0), kind: "clipboard", text: "Summer2026!" }),
    ).toEqual({ at: at(0), kind: "clipboard", redacted: true });
  });

  it("keeps navigation keys, which carry no typed value", () => {
    const event = { at: at(0), kind: "key" as const, key: "Enter", fieldType: "password" };
    expect(sanitizeTeachRecordingEvent(event)).toEqual(event);
  });

  it("keeps opted-in literal text outside secret fields only", () => {
    const literal = {
      at: at(0),
      kind: "clipboard" as const,
      text: "weekly.csv",
      keepLiteral: true,
    };
    expect(sanitizeTeachRecordingEvent(literal)).toEqual(literal);
    expect(
      sanitizeTeachRecordingEvent({ ...literal, text: "Summer2026!", fieldType: "password" }),
    ).toEqual({ at: at(0), kind: "clipboard", fieldType: "password", redacted: true });
    expect(
      sanitizeTeachRecordingEvent({
        at: at(0),
        kind: "key",
        key: "S",
        keepLiteral: true,
        sensitive: true,
      }),
    ).toEqual({ at: at(0), kind: "key", sensitive: true });
  });

  it("is idempotent and leaves non-input events untouched", () => {
    const events: TeachRecordingEvent[] = [
      ...typed("ab"),
      { at: at(3), kind: "clipboard", text: "x", fieldType: "password" },
      { at: at(4), kind: "pointer", x: 1, y: 2, type: "click" },
      { at: at(5), kind: "snapshot", summary: "Done" },
    ];
    const once = events.map(sanitizeTeachRecordingEvent);
    expect(once.map(sanitizeTeachRecordingEvent)).toEqual(once);
    expect(once.slice(3)).toEqual(events.slice(3));
  });
});

describe("formatSkillRunPrompt", () => {
  it("tells the model how to resolve placeholders without values in the prompt", () => {
    const playbook = buildPlaybookFromRecording("Sign in", [
      ...typed("alice"),
      ...typed("Summer2026!", { fieldType: "password" }),
    ]);
    const prompt = formatSkillRunPrompt("Sign in", playbook);
    expect(prompt).toContain('1. Type "{{input:typed text 1}}".');
    expect(prompt).toContain('2. Type "{{secret:password}}".');
    expect(prompt).toContain("fill_secret");
    expect(prompt).toContain("request_secret");
    expect(prompt).not.toContain("Summer2026!");
    expect(prompt).not.toContain("alice");
  });

  it("adds no placeholder guidance to playbooks without placeholders", () => {
    const playbook = buildPlaybookFromRecording("Open", [
      { at: at(0), kind: "pointer", x: 1, y: 2, type: "click" },
    ]);
    expect(formatSkillRunPrompt("Open", playbook)).not.toContain("Placeholders");
  });
});
