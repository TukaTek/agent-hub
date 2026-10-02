import {
  buildPlaybookFromRecording,
  type SkillPlaybook,
  type TeachRecordingEvent,
} from "@cortexai-agent-hub/core";
import { describe, expect, it } from "vitest";
import {
  type PurgePrisma,
  purgeTaughtSkillSecrets,
  redactPlaybook,
  sanitizeStoredTeachEvent,
  scrubDraftPlaybook,
  scrubTaughtSkill,
} from "./teaching-secrets.js";

const SECRET = "Summer2026!";
const at = (ms: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, 0, ms)).toISOString();

function typed(text: string, extra: Partial<TeachRecordingEvent> = {}): TeachRecordingEvent[] {
  return [...text].map((key, index) => ({ at: at(index), kind: "key" as const, key, ...extra }));
}

/** What the pre-fix code stored: raw keystrokes and the literal in the playbook. */
function legacyRow(id: string, overrides: Partial<SkillRow> = {}): SkillRow {
  const events: TeachRecordingEvent[] = [
    { at: at(0), kind: "pointer", x: 10, y: 20, type: "click" },
    ...typed(SECRET),
    { at: at(30), kind: "key", key: "Enter" },
    { at: at(31), kind: "clipboard", text: "pasted-sk-live-abcdefgh1234" },
  ];
  return {
    id,
    goal: "Sign in",
    status: "saved",
    updatedAt: new Date("2026-09-01T00:00:00.000Z"),
    recording: { events, snapshots: [], controlLeaseId: "lease-1" },
    playbook: {
      ...buildPlaybookFromRecording("Sign in", []),
      whenToUse: "Edited by the user",
      steps: [
        "Click left button at (10, 20).",
        `Type "${SECRET}".`,
        "Press key: Enter.",
        "Paste or type: pasted-sk-live-abcdefgh1234.",
      ],
    },
    ...overrides,
  };
}

describe("sanitizeStoredTeachEvent", () => {
  it("runs opted-in literal text through Agent Hub's secret redaction", () => {
    expect(
      sanitizeStoredTeachEvent({
        at: at(0),
        kind: "clipboard",
        text: "token=abc123 for bob@example.com",
        keepLiteral: true,
      }),
    ).toEqual({
      at: at(0),
      kind: "clipboard",
      text: "token=[Redacted] for bob@example.com",
      keepLiteral: true,
    });
  });
});

describe("redactPlaybook", () => {
  it("leaves Teach Me placeholders intact while redacting credentials around them", () => {
    const playbook = redactPlaybook({
      ...buildPlaybookFromRecording("Sign in", []),
      steps: [
        'Type "{{secret:password}}".',
        "Paste or type: {{input:pasted text 1}}.",
        "token=abc123",
      ],
    });
    expect(playbook.steps).toEqual([
      'Type "{{secret:password}}".',
      "Paste or type: {{input:pasted text 1}}.",
      "token=[Redacted]",
    ]);
  });
});

describe("scrubTaughtSkill", () => {
  it("strips typed and pasted values from a legacy row and rebuilds its steps", () => {
    const before = legacyRow("skill-1");
    const after = scrubTaughtSkill(before);

    expect(JSON.stringify(after.recording)).not.toContain("Summer");
    expect(JSON.stringify(after.playbook)).not.toContain(SECRET);
    expect(JSON.stringify(after)).not.toContain("sk-live");
    expect(after.recording.controlLeaseId).toBe("lease-1");
    expect(after.playbook.steps).toEqual([
      "Click left button at (10, 20).",
      'Type "{{input:typed text 1}}".',
      "Press key: Enter.",
      "Paste or type: {{input:pasted text 1}}.",
    ]);
    expect(after.playbook.whenToUse).toBe("Edited by the user");
    expect(after.recordingChanged).toBe(true);
    expect(after.playbookChanged).toBe(true);
  });

  it("is a no-op on its own output", () => {
    const once = scrubTaughtSkill(legacyRow("skill-1"));
    const twice = scrubTaughtSkill({ ...legacyRow("skill-1"), ...once });
    expect(twice.recordingChanged).toBe(false);
    expect(twice.playbookChanged).toBe(false);
    expect(twice.playbook).toEqual(once.playbook);
  });

  it("keeps the user's own step edits on rows whose recording is already clean", () => {
    const clean = scrubTaughtSkill(legacyRow("skill-1"));
    const edited: SkillPlaybook = {
      ...clean.playbook,
      steps: ['Type "Weekly CRM".', "Press key: Enter."],
    };
    const result = scrubTaughtSkill({
      ...legacyRow("skill-1"),
      recording: clean.recording,
      playbook: edited,
    });
    expect(result.playbookChanged).toBe(false);
    expect(result.playbook.steps).toEqual(edited.steps);
  });

  it("redacts credentials the user wrote into an edited playbook", () => {
    const clean = scrubTaughtSkill(legacyRow("skill-1"));
    const result = scrubTaughtSkill({
      ...legacyRow("skill-1"),
      recording: clean.recording,
      playbook: { ...clean.playbook, steps: ["Use api_key=sk-abcdefgh12345"] },
    });
    expect(result.playbookChanged).toBe(true);
    expect(result.playbook.steps).toEqual(["Use api_key=[Redacted]"]);
  });
});

describe("scrubDraftPlaybook", () => {
  it("replaces literal Type and Paste steps of a deleted skill's chat card", () => {
    const playbook = scrubDraftPlaybook({
      ...buildPlaybookFromRecording("Sign in", []),
      steps: [
        `Type "${SECRET}".`,
        'Type "{{secret:password}}".',
        "Paste or type: hunter2.",
        "Paste or type: [redacted input].",
        "Click left button at (1, 2).",
      ],
    });
    expect(playbook.steps).toEqual([
      'Type "{{input:typed text 1}}".',
      'Type "{{secret:password}}".',
      "Paste or type: {{input:pasted text 1}}.",
      "Paste or type: [redacted input].",
      "Click left button at (1, 2).",
    ]);
    expect(scrubDraftPlaybook(playbook)).toEqual(playbook);
  });
});

type SkillRow = {
  id: string;
  goal: string;
  status: string;
  updatedAt: Date;
  recording: { events: TeachRecordingEvent[]; snapshots: unknown[]; controlLeaseId?: string };
  playbook: SkillPlaybook;
};
type MessageRow = { id: string; blocks: unknown };

function fakePrisma(skills: SkillRow[], messages: MessageRow[] = []) {
  const writes = { skills: 0, messages: 0 };
  let beforeWrite: ((id: string) => void) | undefined;
  const byId = <T extends { id: string }>(
    rows: T[],
    args: { where?: { id?: { gt: string } }; take: number },
  ) =>
    [...rows]
      .sort((a, b) => a.id.localeCompare(b.id))
      .filter((row) => !args.where?.id || row.id > args.where.id.gt)
      .slice(0, args.take);
  const prisma = {
    taughtSkill: {
      findMany: async (args: { where?: { id?: { gt: string } }; take: number }) =>
        structuredClone(byId(skills, args)),
      findUnique: async ({ where }: { where: { id: string } }) =>
        structuredClone(skills.find((row) => row.id === where.id) ?? null),
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: string; updatedAt: Date };
        data: Partial<SkillRow>;
      }) => {
        beforeWrite?.(where.id);
        const row = skills.find(
          (candidate) =>
            candidate.id === where.id &&
            candidate.updatedAt.getTime() === where.updatedAt.getTime(),
        );
        if (!row) return { count: 0 };
        Object.assign(row, structuredClone(data));
        writes.skills += 1;
        return { count: 1 };
      },
    },
    message: {
      findMany: async (args: { where?: { id?: { gt: string } }; take: number }) =>
        structuredClone(
          byId(messages, args).filter((row) =>
            JSON.stringify(row.blocks).includes('"skill_draft"'),
          ),
        ),
      update: async ({ where, data }: { where: { id: string }; data: { blocks: unknown } }) => {
        const row = messages.find((candidate) => candidate.id === where.id);
        if (row) row.blocks = structuredClone(data.blocks);
        writes.messages += 1;
        return row;
      },
    },
  };
  return {
    prisma: prisma as unknown as PurgePrisma,
    skills,
    messages,
    writes,
    onBeforeWrite(fn: (id: string) => void) {
      beforeWrite = fn;
    },
  };
}

describe("purgeTaughtSkillSecrets", () => {
  it("scrubs legacy rows and their chat cards, reports counts only, and a rerun changes nothing", async () => {
    const legacy = legacyRow("skill-a");
    const clean = { ...legacyRow("skill-b"), ...scrubTaughtSkill(legacyRow("skill-b")) };
    const db = fakePrisma(
      [legacy, clean],
      [
        {
          id: "m-1",
          blocks: [
            { kind: "text", text: "Draft ready" },
            {
              kind: "skill_draft",
              skillId: "skill-a",
              name: "Sign in",
              goal: "Sign in",
              playbook: legacy.playbook,
              status: "saved",
            },
          ],
        },
        {
          id: "m-2",
          blocks: [
            {
              kind: "skill_draft",
              skillId: "deleted-skill",
              name: "Old",
              goal: "Old",
              playbook: { ...legacy.playbook, steps: [`Type "${SECRET}".`] },
              status: "draft",
            },
          ],
        },
        { id: "m-3", blocks: [{ kind: "text", text: `Type "${SECRET}" is just chat` }] },
      ],
    );
    const updatedAt = legacy.updatedAt.getTime();

    const first = await purgeTaughtSkillSecrets(db.prisma, { batchSize: 1 });
    expect(first).toEqual({
      skillsScanned: 2,
      skillsChanged: 1,
      recordingsScrubbed: 1,
      playbooksScrubbed: 1,
      skippedConcurrent: 0,
      draftMessagesScanned: 2,
      draftMessagesScrubbed: 2,
    });
    expect(JSON.stringify(db.skills)).not.toContain("Summer");
    expect(JSON.stringify(db.skills)).not.toContain("sk-live");
    expect(JSON.stringify(db.messages.slice(0, 2))).not.toContain(SECRET);
    expect(db.messages[2]).toEqual({
      id: "m-3",
      blocks: [{ kind: "text", text: `Type "${SECRET}" is just chat` }],
    });
    expect(db.skills[0]?.updatedAt.getTime()).toBe(updatedAt);
    expect(db.skills[0]?.status).toBe("saved");

    const writes = { ...db.writes };
    const second = await purgeTaughtSkillSecrets(db.prisma);
    expect(second).toMatchObject({ skillsScanned: 2, skillsChanged: 0, draftMessagesScrubbed: 0 });
    expect(db.writes).toEqual(writes);
  });

  it("skips a row another writer changed meanwhile instead of overwriting it", async () => {
    const db = fakePrisma([legacyRow("skill-a")]);
    db.onBeforeWrite((id) => {
      const row = db.skills.find((candidate) => candidate.id === id);
      if (row) row.updatedAt = new Date("2026-10-02T00:00:00.000Z");
    });
    const result = await purgeTaughtSkillSecrets(db.prisma);
    expect(result).toMatchObject({ skillsChanged: 0, skippedConcurrent: 1 });
  });
});
