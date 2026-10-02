import { describe, expect, it } from "vitest";
import type { TeachRecordingEvent } from "@cortexai-agent-hub/core";
import { buildPlaybookFromRecording } from "@cortexai-agent-hub/core";
import { purgeTaughtSkillSecrets } from "./teaching-purge.js";

describe("purgeTaughtSkillSecrets", () => {
  const makeMockPrisma = (skills: Array<{ id: string; goal: string; recording: unknown; playbook: unknown; status: string }>) => {
    const updates: Array<{ id: string; recording: unknown; playbook: unknown }> = [];
    let findCalls = 0;
    return {
      updates,
      prisma: {
        taughtSkill: {
          findMany: async (query: { where?: { id?: { gt: string } }; orderBy: unknown; take: number; select: unknown }) => {
            findCalls++;
            if (findCalls > 1) return [];
            return skills;
          },
          update: async ({ where, data }: { where: { id: string }; data: { recording: unknown; playbook: unknown } }) => {
            updates.push({ id: where.id, recording: data.recording, playbook: data.playbook });
            return {};
          },
        },
      } as never,
    };
  };

  it("scans and counts skills without changing clean data", async () => {
    const { prisma } = makeMockPrisma([
      {
        id: "skill-1",
        goal: "Search",
        status: "saved",
        recording: { events: [{ at: "2026-01-01T00:00:00.000Z", kind: "key", key: "h" }], snapshots: [] },
        playbook: buildPlaybookFromRecording("Search", [{ at: "2026-01-01T00:00:00.000Z", kind: "key", key: "h" }]),
      },
    ]);

    const result = await purgeTaughtSkillSecrets(prisma);
    expect(result.scanned).toBe(1);
    expect(result.changed).toBe(0);
  });

  it("redacts password field events and rebuilds playbook", async () => {
    const passwordEvent: TeachRecordingEvent = {
      at: "2026-01-01T00:00:00.000Z",
      kind: "key",
      key: "S",
      text: "Summer2026!",
      fieldType: "password",
    };

    const { prisma, updates } = makeMockPrisma([
      {
        id: "skill-1",
        goal: "Sign in",
        status: "saved",
        recording: { events: [passwordEvent], snapshots: [] },
        playbook: { steps: ['Type "Summer2026!".'] },
      },
    ]);

    const result = await purgeTaughtSkillSecrets(prisma);
    expect(result.scanned).toBe(1);
    expect(result.changed).toBe(1);
    expect(updates).toHaveLength(1);
    const sanitized = updates[0];
    expect(sanitized).toBeDefined();
    const recording = sanitized.recording as { events: TeachRecordingEvent[] };
    expect(recording.events[0].key).toBeUndefined();
    expect(recording.events[0].text).toBeUndefined();
    expect(recording.events[0].sensitive).toBe(true);
    const playbook = sanitized.playbook as { steps: string[] };
    expect(playbook.steps.join(" ")).toContain("{{secret:");
    expect(playbook.steps.join(" ")).not.toContain("Summer2026!");
  });

  it("redacts sensitive Protected input events", async () => {
    const { prisma, updates } = makeMockPrisma([
      {
        id: "skill-1",
        goal: "Sign in",
        status: "saved",
        recording: {
          events: [
            { at: "2026-01-01T00:00:00.000Z", kind: "key", key: "p", sensitive: true },
            { at: "2026-01-01T00:00:01.000Z", kind: "clipboard", text: "hunter2", sensitive: true },
          ],
          snapshots: [],
        },
        playbook: { steps: ['Type "p".', 'Paste or type: hunter2.'] },
      },
    ]);

    const result = await purgeTaughtSkillSecrets(prisma);
    expect(result.changed).toBe(1);
    expect(updates).toHaveLength(1);
    const sanitized = updates[0];
    expect(sanitized).toBeDefined();
    const recording = sanitized.recording as { events: TeachRecordingEvent[] };
    expect(recording.events[0].key).toBeUndefined();
    expect(recording.events[1].text).toBeUndefined();
    const playbook = sanitized.playbook as { steps: string[] };
    expect(playbook.steps.join(" ")).not.toContain("hunter2");
    expect(playbook.steps.join(" ")).toContain("[redacted input]");
  });

  it("is idempotent - rerunning changes 0 rows", async () => {
    const alreadySanitizedEvent: TeachRecordingEvent = {
      at: "2026-01-01T00:00:00.000Z",
      kind: "key",
      fieldType: "password",
      sensitive: true,
      fieldLabel: "password",
    };

    const { prisma } = makeMockPrisma([
      {
        id: "skill-1",
        goal: "Sign in",
        status: "saved",
        recording: { events: [alreadySanitizedEvent], snapshots: [] },
        playbook: buildPlaybookFromRecording("Sign in", [alreadySanitizedEvent]),
      },
    ]);

    const result = await purgeTaughtSkillSecrets(prisma);
    expect(result.scanned).toBe(1);
    expect(result.changed).toBe(0);
  });

  it("purges legacy rows without fieldType by dropping ALL key/clipboard events", async () => {
    const { prisma, updates } = makeMockPrisma([
      {
        id: "skill-legacy",
        goal: "Old workflow",
        status: "saved",
        recording: {
          events: [
            { at: "2026-01-01T00:00:00.000Z", kind: "key", key: "p" },
            { at: "2026-01-01T00:00:01.000Z", kind: "key", key: "a" },
            { at: "2026-01-01T00:00:02.000Z", kind: "key", key: "s" },
            { at: "2026-01-01T00:00:03.000Z", kind: "clipboard", text: "password123" },
            { at: "2026-01-01T00:00:04.000Z", kind: "pointer", x: 100, y: 200, button: "left", type: "click" },
          ],
          snapshots: [],
        },
        playbook: { steps: ['Type "pas".', 'Paste or type: password123.', 'Click left button at (100, 200).'] },
      },
    ]);

    const result = await purgeTaughtSkillSecrets(prisma);
    expect(result.scanned).toBe(1);
    expect(result.changed).toBe(1);
    expect(updates).toHaveLength(1);
    const sanitized = updates[0];
    expect(sanitized).toBeDefined();
    const recording = sanitized.recording as { events: TeachRecordingEvent[] };
    // All key events should have key stripped
    expect(recording.events[0].key).toBeUndefined();
    expect(recording.events[1].key).toBeUndefined();
    expect(recording.events[2].key).toBeUndefined();
    expect(recording.events[0].sensitive).toBe(true);
    // Clipboard event should have text stripped
    expect(recording.events[3].text).toBeUndefined();
    expect(recording.events[3].sensitive).toBe(true);
    // Pointer event should be unchanged
    expect(recording.events[4].x).toBe(100);
    expect(recording.events[4].y).toBe(200);
    // Playbook should be rebuilt without the literal values
    const playbook = sanitized.playbook as { steps: string[] };
    expect(playbook.steps.join(" ")).not.toContain("password123");
    expect(playbook.steps.join(" ")).not.toContain("pas");
  });
});
