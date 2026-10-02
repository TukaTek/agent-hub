import { describe, expect, it } from "vitest";
import { formatSkillRunPrompt } from "@cortexai-agent-hub/core";
import { buildPlaybookFromRecording } from "@cortexai-agent-hub/core";
import type { TeachRecordingEvent } from "@cortexai-agent-hub/core";

describe("teach me replay secret protection", () => {
  it("never includes actual password values in the skill run prompt", () => {
    const passwordEvents: TeachRecordingEvent[] = [
      { at: "2026-01-01T00:00:00.000Z", kind: "key", key: "S", fieldType: "password", fieldLabel: "password" },
      { at: "2026-01-01T00:00:01.000Z", kind: "key", key: "u", fieldType: "password", fieldLabel: "password" },
      { at: "2026-01-01T00:00:02.000Z", kind: "key", key: "m", fieldType: "password", fieldLabel: "password" },
      { at: "2026-01-01T00:00:03.000Z", kind: "key", key: "m", fieldType: "password", fieldLabel: "password" },
      { at: "2026-01-01T00:00:04.000Z", kind: "key", key: "e", fieldType: "password", fieldLabel: "password" },
      { at: "2026-01-01T00:00:05.000Z", kind: "key", key: "r", fieldType: "password", fieldLabel: "password" },
      { at: "2026-01-01T00:00:06.000Z", kind: "key", key: "2", fieldType: "password", fieldLabel: "password" },
      { at: "2026-01-01T00:00:07.000Z", kind: "key", key: "0", fieldType: "password", fieldLabel: "password" },
      { at: "2026-01-01T00:00:08.000Z", kind: "key", key: "2", fieldType: "password", fieldLabel: "password" },
      { at: "2026-01-01T00:00:09.000Z", kind: "key", key: "6", fieldType: "password", fieldLabel: "password" },
      { at: "2026-01-01T00:00:10.000Z", kind: "key", key: "!", fieldType: "password", fieldLabel: "password" },
    ];

    const playbook = buildPlaybookFromRecording("Sign in", passwordEvents);
    const prompt = formatSkillRunPrompt("Sign in to dashboard", playbook, false);

    expect(prompt).toContain("{{secret:password}}");
    expect(prompt).not.toContain("Summer");
    expect(prompt).not.toContain("Summer2026");
    expect(prompt).not.toContain("Summer2026!");
    expect(prompt.toLowerCase()).not.toContain("summer");
  });

  it("never includes Protected input values in the skill run prompt", () => {
    const protectedEvents: TeachRecordingEvent[] = [
      { at: "2026-01-01T00:00:00.000Z", kind: "key", key: "h", sensitive: true },
      { at: "2026-01-01T00:00:01.000Z", kind: "key", key: "u", sensitive: true },
      { at: "2026-01-01T00:00:02.000Z", kind: "clipboard", text: "hunter2", sensitive: true },
    ];

    const playbook = buildPlaybookFromRecording("Sign in", protectedEvents);
    const prompt = formatSkillRunPrompt("Sign in to dashboard", playbook, false);

    expect(prompt).toContain("[redacted input]");
    expect(prompt).not.toContain("hunter2");
    expect(prompt).not.toContain("hunter");
  });

  it("never includes autocomplete=one-time-code values in the skill run prompt", () => {
    const otpEvents: TeachRecordingEvent[] = [
      { at: "2026-01-01T00:00:00.000Z", kind: "key", key: "1", autocomplete: "one-time-code", fieldLabel: "mfa-code" },
      { at: "2026-01-01T00:00:01.000Z", kind: "key", key: "2", autocomplete: "one-time-code", fieldLabel: "mfa-code" },
      { at: "2026-01-01T00:00:02.000Z", kind: "key", key: "3", autocomplete: "one-time-code", fieldLabel: "mfa-code" },
      { at: "2026-01-01T00:00:03.000Z", kind: "key", key: "4", autocomplete: "one-time-code", fieldLabel: "mfa-code" },
      { at: "2026-01-01T00:00:04.000Z", kind: "key", key: "5", autocomplete: "one-time-code", fieldLabel: "mfa-code" },
      { at: "2026-01-01T00:00:05.000Z", kind: "key", key: "6", autocomplete: "one-time-code", fieldLabel: "mfa-code" },
    ];

    const playbook = buildPlaybookFromRecording("Enter MFA code", otpEvents);
    const prompt = formatSkillRunPrompt("Enter MFA code", playbook, false);

    expect(prompt).toContain("{{secret:mfa-code}}");
    expect(prompt).not.toContain("123456");
  });

  it("includes regular typed text that doesn't contain secrets", () => {
    const normalEvents: TeachRecordingEvent[] = [
      { at: "2026-01-01T00:00:00.000Z", kind: "key", key: "t", fieldType: "text" },
      { at: "2026-01-01T00:00:01.000Z", kind: "key", key: "e", fieldType: "text" },
      { at: "2026-01-01T00:00:02.000Z", kind: "key", key: "s", fieldType: "text" },
      { at: "2026-01-01T00:00:03.000Z", kind: "key", key: "t", fieldType: "text" },
    ];

    const playbook = buildPlaybookFromRecording("Search", normalEvents);
    const prompt = formatSkillRunPrompt("Search", playbook, false);

    expect(prompt).toContain("test");
    expect(prompt).not.toContain("{{secret:");
  });

  it("mixed scenario with both secret and non-secret fields", () => {
    const mixedEvents: TeachRecordingEvent[] = [
      { at: "2026-01-01T00:00:00.000Z", kind: "key", key: "u", fieldType: "text" },
      { at: "2026-01-01T00:00:01.000Z", kind: "key", key: "s", fieldType: "text" },
      { at: "2026-01-01T00:00:02.000Z", kind: "key", key: "e", fieldType: "text" },
      { at: "2026-01-01T00:00:03.000Z", kind: "key", key: "r", fieldType: "text" },
      { at: "2026-01-01T00:00:04.000Z", kind: "key", key: "Enter" },
      { at: "2026-01-01T00:00:05.000Z", kind: "key", key: "P", fieldType: "password", fieldLabel: "password" },
      { at: "2026-01-01T00:00:06.000Z", kind: "key", key: "a", fieldType: "password", fieldLabel: "password" },
      { at: "2026-01-01T00:00:07.000Z", kind: "key", key: "s", fieldType: "password", fieldLabel: "password" },
      { at: "2026-01-01T00:00:08.000Z", kind: "key", key: "s", fieldType: "password", fieldLabel: "password" },
      { at: "2026-01-01T00:00:09.000Z", kind: "key", key: "Enter" },
    ];

    const playbook = buildPlaybookFromRecording("Sign in", mixedEvents);
    const prompt = formatSkillRunPrompt("Sign in to dashboard", playbook, false);

    expect(prompt).toContain("user");
    expect(prompt).toContain("{{secret:password}}");
    expect(prompt).not.toContain("Pass");
    const steps = playbook.steps.join(" ");
    expect(steps).not.toMatch(/\bpass\b/i);
  });

  it("includes placeholder resolution instructions in the formatted prompt", () => {
    const passwordEvents: TeachRecordingEvent[] = [
      { at: "2026-01-01T00:00:00.000Z", kind: "key", key: "P", fieldType: "password", fieldLabel: "password" },
      { at: "2026-01-01T00:00:01.000Z", kind: "key", key: "a", fieldType: "password", fieldLabel: "password" },
    ];

    const playbook = buildPlaybookFromRecording("Sign in", passwordEvents);
    const prompt = formatSkillRunPrompt("Sign in to dashboard", playbook, false);

    // Prompt should instruct agent to ask user for placeholder values
    expect(prompt).toContain("{{secret:<label>}}");
    expect(prompt).toContain("{{input:<label>}}");
    expect(prompt).toContain("Ask the user for the <label> value");
    expect(prompt).toContain("[redacted input]");
    expect(prompt).toContain("Never use or guess placeholder values");
    
    // And should still contain the actual placeholder
    expect(prompt).toContain("{{secret:password}}");
  });
});
