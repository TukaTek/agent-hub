import { describe, expect, it } from "vitest";
import type { TeachRecordingEvent } from "@cortexai-agent-hub/core";
import { purgeTaughtSkillSecrets } from "@cortexai-agent-hub/adapters";
import { createDb } from "@cortexai-agent-hub/db";

const databaseAvailable = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);

describe.skipIf(!databaseAvailable)("purgeTaughtSkillSecrets Postgres integration", () => {
  it("purges password field keystrokes from real database", async () => {
    const { prisma } = createDb(process.env.DATABASE_URL!, { applicationName: "test-purge" });

    try {
      // Create a skill with password keystrokes
      const spaceId = `space-${Date.now()}`;
      const userId = `user-${Date.now()}`;
      const botId = `bot-${Date.now()}`;

      await prisma.space.create({
        data: { id: spaceId, name: "Test Space" },
      });

      await prisma.user.create({
        data: { id: userId, email: `test-${Date.now()}@example.com` },
      });

      await prisma.spaceMember.create({
        data: {
          spaceId,
          userId,
          role: "admin",
          joinedAt: new Date(),
        },
      });

      await prisma.bot.create({
        data: {
          id: botId,
          spaceId,
          userId,
          name: "Test Bot",
          title: "Test Bot",
        },
      });

      const passwordEvents: TeachRecordingEvent[] = [
        { at: "2026-01-01T00:00:00.000Z", kind: "key", key: "S", fieldType: "password", fieldLabel: "password" },
        { at: "2026-01-01T00:00:01.000Z", kind: "key", key: "e", fieldType: "password", fieldLabel: "password" },
        { at: "2026-01-01T00:00:02.000Z", kind: "key", key: "c", fieldType: "password", fieldLabel: "password" },
        { at: "2026-01-01T00:00:03.000Z", kind: "key", key: "r", fieldType: "password", fieldLabel: "password" },
        { at: "2026-01-01T00:00:04.000Z", kind: "key", key: "e", fieldType: "password", fieldLabel: "password" },
        { at: "2026-01-01T00:00:05.000Z", kind: "key", key: "t", fieldType: "password", fieldLabel: "password" },
      ];

      const skill = await prisma.taughtSkill.create({
        data: {
          spaceId,
          botId,
          userId,
          goal: "Sign in",
          status: "saved",
          recording: { events: passwordEvents, snapshots: [] } as never,
          playbook: { steps: ['Type "Secret".'] } as never,
        },
      });

      // Verify password is in the recording before purge
      const beforeRecording = skill.recording as { events: TeachRecordingEvent[] };
      expect(beforeRecording.events[0].key).toBe("S");
      expect(beforeRecording.events[5].key).toBe("t");

      // Run purge
      const result = await purgeTaughtSkillSecrets(prisma);
      expect(result.scanned).toBeGreaterThan(0);
      expect(result.changed).toBeGreaterThanOrEqual(1);

      // Verify password is gone after purge
      const afterSkill = await prisma.taughtSkill.findUnique({
        where: { id: skill.id },
      });
      expect(afterSkill).toBeTruthy();

      const afterRecording = afterSkill!.recording as { events: TeachRecordingEvent[] };
      expect(afterRecording.events[0].key).toBeUndefined();
      expect(afterRecording.events[0].sensitive).toBe(true);
      expect(afterRecording.events[5].key).toBeUndefined();

      const afterPlaybook = afterSkill!.playbook as { steps: string[] };
      expect(afterPlaybook.steps.join(" ")).toContain("{{secret:password}}");
      expect(afterPlaybook.steps.join(" ")).not.toContain("Secret");

      // Rerun purge - should be idempotent (0 changes)
      const rerunResult = await purgeTaughtSkillSecrets(prisma);
      expect(rerunResult.changed).toBe(0);
    } finally {
      await prisma.$disconnect();
    }
  });

  it("purges legacy rows without fieldType", async () => {
    const { prisma } = createDb(process.env.DATABASE_URL!, { applicationName: "test-purge-legacy" });

    try {
      const spaceId = `space-legacy-${Date.now()}`;
      const userId = `user-legacy-${Date.now()}`;
      const botId = `bot-legacy-${Date.now()}`;

      await prisma.space.create({
        data: { id: spaceId, name: "Legacy Space" },
      });

      await prisma.user.create({
        data: { id: userId, email: `legacy-${Date.now()}@example.com` },
      });

      await prisma.spaceMember.create({
        data: {
          spaceId,
          userId,
          role: "admin",
          joinedAt: new Date(),
        },
      });

      await prisma.bot.create({
        data: {
          id: botId,
          spaceId,
          userId,
          name: "Legacy Bot",
          title: "Legacy Bot",
        },
      });

      // Old events without fieldType
      const legacyEvents: TeachRecordingEvent[] = [
        { at: "2026-01-01T00:00:00.000Z", kind: "key", key: "p" },
        { at: "2026-01-01T00:00:01.000Z", kind: "key", key: "a" },
        { at: "2026-01-01T00:00:02.000Z", kind: "key", key: "s" },
        { at: "2026-01-01T00:00:03.000Z", kind: "clipboard", text: "secret123" },
      ];

      const skill = await prisma.taughtSkill.create({
        data: {
          spaceId,
          botId,
          userId,
          goal: "Old workflow",
          status: "saved",
          recording: { events: legacyEvents, snapshots: [] } as never,
          playbook: { steps: ['Type "pas".', 'Paste or type: secret123.'] } as never,
        },
      });

      // Verify before purge
      const beforeRecording = skill.recording as { events: TeachRecordingEvent[] };
      expect(beforeRecording.events[0].key).toBe("p");
      expect(beforeRecording.events[3].text).toBe("secret123");

      // Run purge
      const result = await purgeTaughtSkillSecrets(prisma);
      expect(result.scanned).toBeGreaterThan(0);
      expect(result.changed).toBeGreaterThanOrEqual(1);

      // Verify after purge - all key/clipboard events should be stripped
      const afterSkill = await prisma.taughtSkill.findUnique({
        where: { id: skill.id },
      });
      expect(afterSkill).toBeTruthy();

      const afterRecording = afterSkill!.recording as { events: TeachRecordingEvent[] };
      expect(afterRecording.events[0].key).toBeUndefined();
      expect(afterRecording.events[1].key).toBeUndefined();
      expect(afterRecording.events[2].key).toBeUndefined();
      expect(afterRecording.events[3].text).toBeUndefined();
      expect(afterRecording.events[0].sensitive).toBe(true);
      expect(afterRecording.events[3].sensitive).toBe(true);

      const afterPlaybook = afterSkill!.playbook as { steps: string[] };
      expect(afterPlaybook.steps.join(" ")).not.toContain("pas");
      expect(afterPlaybook.steps.join(" ")).not.toContain("secret123");
    } finally {
      await prisma.$disconnect();
    }
  });
});

