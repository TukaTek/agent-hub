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
      steps: ['Type "Weekly CRM".', "Use password=hunter2 then Enter"],
    };
    const updated = await service.updateDraft(actor, "skill-1", { playbook });
    expect(updated.playbook.steps).toEqual([
      'Type "Weekly CRM".',
      "Use password=[Redacted] then Enter",
    ]);
    expect(JSON.stringify(state.row)).not.toContain("hunter2");
  });

  it("updateDraft cannot write a legacy literal back over a dirty recording", async () => {
    const { service, state } = serviceWith(skillRow());
    const updated = await service.updateDraft(actor, "skill-1", {
      name: "Renamed",
      playbook: skillRow().playbook,
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
