import { buildPlaybookFromRecording, type TeachRecordingEvent } from "@cortexai-agent-hub/core";
import { describe, expect, it, vi } from "vitest";
import { createTaughtSkillsService, teachFieldMetadata } from "./taught-skills.js";

const SECRET = "Summer2026!";
const actor = { spaceId: "space-1", userId: "user-1" } as never;

function legacyEvents(): TeachRecordingEvent[] {
  return [
    { at: "2026-01-01T00:00:00.000Z", kind: "pointer", x: 1, y: 2, type: "click" },
    ...[...SECRET].map((key) => ({ at: "2026-01-01T00:00:01.000Z", kind: "key" as const, key })),
  ];
}

function serviceWith(row: Record<string, unknown>) {
  const state = { row: { ...row } };
  const prisma = {
    taughtSkill: {
      findFirst: vi.fn(async () => state.row),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        state.row = { ...state.row, ...data };
        return state.row;
      }),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string; updatedAt: Date };
          data: Record<string, unknown>;
        }) => {
          const current = state.row.updatedAt as Date;
          if (state.row.id !== where.id || current.getTime() !== where.updatedAt.getTime()) {
            return { count: 0 };
          }
          // Prisma's @updatedAt bumps the version on every write.
          state.row = { ...state.row, ...data, updatedAt: new Date(current.getTime() + 1000) };
          return { count: 1 };
        },
      ),
      findUniqueOrThrow: vi.fn(async () => state.row),
    },
    bot: { findUnique: vi.fn(async () => null) },
  };
  const service = createTaughtSkillsService({ prisma, events: { append: vi.fn() } } as never);
  return { service, state, prisma };
}

function skillRow(overrides: Record<string, unknown> = {}) {
  const now = new Date("2026-09-01T00:00:00.000Z");
  return {
    id: "skill-1",
    spaceId: "space-1",
    botId: "bot-1",
    userId: "user-1",
    name: "Sign in",
    goal: "Sign in",
    status: "draft",
    recording: { events: legacyEvents(), snapshots: [] },
    playbook: {
      ...buildPlaybookFromRecording("Sign in", []),
      steps: ["Click left button at (1, 2).", `Type "${SECRET}".`],
    },
    startedAt: now,
    expiresAt: null,
    stoppedAt: now,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("taught skills server-side sanitization (CAAH-71)", () => {
  it("save strips raw input from a legacy draft and rebuilds the steps", async () => {
    const { service, state } = serviceWith(skillRow());
    const saved = await service.save(actor, "skill-1");
    expect(JSON.stringify(state.row.recording)).not.toContain("Summer");
    expect(JSON.stringify(state.row.playbook)).not.toContain(SECRET);
    expect(saved.playbook.steps).toEqual([
      "Click left button at (1, 2).",
      'Type "{{input:typed text 1}}".',
    ]);
    expect(saved.status).toBe("saved");
  });

  it("updateDraft keeps the user's edits on a clean recording but redacts credentials", async () => {
    const clean = skillRow({ recording: { events: [legacyEvents()[0]], snapshots: [] } });
    const { service, state } = serviceWith(clean);
    const playbook = {
      ...buildPlaybookFromRecording("Sign in", []),
      whenToUse: "Edited by the user",
      steps: [
        "Open the Weekly CRM report.",
        'Type "Weekly CRM".',
        "Use password=hunter2 then Enter",
      ],
    };
    const updated = await service.updateDraft(actor, "skill-1", {
      playbook,
      expectedUpdatedAt: clean.updatedAt.toISOString(),
    });
    // M1: a literal Type step the recording did not produce cannot be told apart from a
    // password sent back by a stale card, so it becomes a placeholder. Free-form edits stay.
    expect(updated.playbook.steps).toEqual([
      "Open the Weekly CRM report.",
      'Type "{{input:typed text 1}}".',
      "Use password=[Redacted] then Enter",
    ]);
    expect(updated.playbook.whenToUse).toBe("Edited by the user");
    expect(JSON.stringify(state.row)).not.toContain("hunter2");
  });

  it("updateDraft does not store the password a stale client sends back (GStack M1 probe)", async () => {
    const clean = skillRow({ recording: { events: [legacyEvents()[0]], snapshots: [] } });
    const { service, state } = serviceWith(clean);
    const playbook = {
      ...buildPlaybookFromRecording("Sign in", []),
      steps: ["Click left button at (1, 2).", 'Type "Summer2026!".', "Paste or type: hunter2pass."],
    };
    // Even with a current version token, the literal values never reach the row.
    const updated = await service.updateDraft(actor, "skill-1", {
      playbook,
      expectedUpdatedAt: clean.updatedAt.toISOString(),
    });
    expect(updated.playbook.steps).toEqual([
      "Click left button at (1, 2).",
      'Type "{{input:typed text 1}}".',
      "Paste or type: {{input:pasted text 1}}.",
    ]);
    for (const value of ["Summer2026!", "hunter2pass"]) {
      expect(JSON.stringify(state.row)).not.toContain(value);
      expect(JSON.stringify(updated)).not.toContain(value);
    }
  });

  it("updateDraft rejects a stale or missing expectedUpdatedAt with 409 and writes nothing", async () => {
    const clean = skillRow({ recording: { events: [legacyEvents()[0]], snapshots: [] } });
    const { service, state, prisma } = serviceWith(clean);
    const before = structuredClone(state.row);
    const playbook = { ...buildPlaybookFromRecording("Sign in", []), steps: ["Edited"] };
    for (const expectedUpdatedAt of [
      undefined,
      "",
      "not a date",
      new Date(clean.updatedAt.getTime() - 1).toISOString(),
    ]) {
      await expect(
        service.updateDraft(actor, "skill-1", { name: "Stale", playbook, expectedUpdatedAt }),
      ).rejects.toMatchObject({ code: "CONFLICT", status: 409 });
    }
    expect(prisma.taughtSkill.updateMany).not.toHaveBeenCalled();
    expect(prisma.taughtSkill.update).not.toHaveBeenCalled();
    expect(state.row).toEqual(before);
  });

  it("updateDraft returns 409 when another write lands between its read and its write", async () => {
    const clean = skillRow({ recording: { events: [legacyEvents()[0]], snapshots: [] } });
    const { service, state, prisma } = serviceWith(clean);
    const token = clean.updatedAt.toISOString();
    prisma.taughtSkill.findFirst.mockImplementationOnce(async () => {
      const read = { ...state.row };
      // A concurrent save bumps the row after this request read it.
      state.row = { ...state.row, name: "Concurrent", updatedAt: new Date("2026-09-02") };
      return read;
    });
    await expect(
      service.updateDraft(actor, "skill-1", {
        name: "Mine",
        playbook: { ...buildPlaybookFromRecording("Sign in", []), steps: ["Edited"] },
        expectedUpdatedAt: token,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT", status: 409 });
    expect(state.row.name).toBe("Concurrent");
  });

  it("updateDraft returns the new version token so the next edit can be sent", async () => {
    const clean = skillRow({ recording: { events: [legacyEvents()[0]], snapshots: [] } });
    const { service } = serviceWith(clean);
    const playbook = { ...buildPlaybookFromRecording("Sign in", []), steps: ["Edited"] };
    const first = await service.updateDraft(actor, "skill-1", {
      playbook,
      expectedUpdatedAt: clean.updatedAt.toISOString(),
    });
    expect(first.updatedAt).not.toBe(clean.updatedAt.toISOString());
    await expect(
      service.updateDraft(actor, "skill-1", {
        playbook,
        expectedUpdatedAt: clean.updatedAt.toISOString(),
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      service.updateDraft(actor, "skill-1", { playbook, expectedUpdatedAt: first.updatedAt }),
    ).resolves.toMatchObject({ playbook: { steps: ["Edited"] } });
  });

  it("updateDraft guards the draft card write and stamps the card with the new version", async () => {
    const clean = skillRow({ recording: { events: [legacyEvents()[0]], snapshots: [] } });
    const { state, prisma } = serviceWith(clean);
    const card = {
      kind: "skill_draft",
      skillId: "skill-1",
      name: "Sign in",
      goal: "Sign in",
      playbook: clean.playbook,
      status: "draft",
    };
    const stored: { id: string; blocks: Record<string, unknown>[] } = {
      id: "m-1",
      blocks: [{ kind: "text", text: "Draft ready" }, card],
    };
    let writes = 0;
    const updateMany = vi.fn(
      async ({
        where,
        data,
      }: {
        where: { id: string; blocks: { equals: unknown } };
        data: { blocks: Record<string, unknown>[] };
      }) => {
        writes += 1;
        // A concurrent write to the same message lands between the first read and write.
        if (writes === 1) stored.blocks = [{ kind: "text", text: "Concurrent" }, card];
        if (JSON.stringify(stored.blocks) !== JSON.stringify(where.blocks.equals)) {
          return { count: 0 };
        }
        stored.blocks = data.blocks;
        return { count: 1 };
      },
    );
    const append = vi.fn();
    const service = createTaughtSkillsService({
      prisma: {
        ...prisma,
        bot: { findUnique: vi.fn(async () => ({ id: "bot-1", thread: { id: "thread-1" } })) },
        message: { findMany: vi.fn(async () => [structuredClone(stored)]), updateMany },
      },
      events: { append },
    } as never);
    const updated = await service.updateDraft(actor, "skill-1", {
      name: "Renamed",
      playbook: { ...clean.playbook, steps: ["Edited"] },
      expectedUpdatedAt: clean.updatedAt.toISOString(),
    });
    expect(updateMany).toHaveBeenCalledTimes(2);
    // The concurrent write survives and the card carries the row's new version.
    expect(stored.blocks[0]).toEqual({ kind: "text", text: "Concurrent" });
    expect(stored.blocks[1]).toMatchObject({
      name: "Renamed",
      playbook: { steps: ["Edited"] },
      status: "draft",
      updatedAt: updated.updatedAt,
    });
    expect(updated.updatedAt).toBe((state.row.updatedAt as Date).toISOString());
    expect(append).toHaveBeenCalledTimes(1);
    expect(append.mock.calls[0]?.[0]).toMatchObject({
      type: "thread.message.updated",
      payload: { messageId: "m-1", blocks: stored.blocks },
    });
  });

  it("updateDraft cannot write a legacy literal back over a dirty recording", async () => {
    const { service, state } = serviceWith(skillRow());
    const updated = await service.updateDraft(actor, "skill-1", {
      name: "Renamed",
      playbook: skillRow().playbook,
      expectedUpdatedAt: skillRow().updatedAt.toISOString(),
    });
    expect(updated.name).toBe("Renamed");
    expect(JSON.stringify(state.row)).not.toContain(SECRET);
    expect(JSON.stringify(state.row.recording)).not.toContain("Summer");
  });
});

describe("teachFieldMetadata", () => {
  it("accepts short field metadata strings and ignores everything else", () => {
    expect(
      teachFieldMetadata({
        fieldType: " password ",
        autocomplete: "current-password",
        fieldLabel: "x".repeat(500),
        value: "hunter2",
      }),
    ).toEqual({
      fieldType: "password",
      autocomplete: "current-password",
      fieldLabel: "x".repeat(200),
    });
    expect(teachFieldMetadata({ fieldType: 3, autocomplete: "", fieldLabel: null })).toEqual({});
  });
});
