import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ComposioEmulator, purgeTaughtSkillSecrets } from "@cortexai-agent-hub/adapters";
import { buildPlaybookFromRecording, type TeachRecordingEvent } from "@cortexai-agent-hub/core";
import { describe, expect, it } from "vitest";
import { discardBotIntroRun } from "./discard-bot-intro.js";
import { sessionCookieHeader } from "./index.js";
import { type ModelEmulatorRequest, startModelEmulator } from "./model-emulator.js";

// CAAH-71: Teach Me must never store or send what the user typed. This suite drives the real
// API, Postgres, teaching capture, legacy purge and executor skill invocation end to end.

type App = { request: (input: string, init?: RequestInit) => Promise<Response> };
type Handles = Awaited<ReturnType<typeof import("../../../apps/api/src/app.ts")["createApp"]>>;

const databaseAvailable = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const fixtureOrigin = "http://127.0.0.1:5173";
const fixtureKey = "teach-secrets-fixture-key";

const PASSWORD = "Summer2026!";
const USERNAME = "alice.fixture";
const PROTECTED = "protected-pw-fixture";
const PASTED = "pasted-value-fixture";
const KEPT = "weekly-export.csv";
const NEVER_STORED = [PASSWORD, USERNAME, PROTECTED, PASTED];
// apps/api TAUGHT_SKILLS_PURGE_MARKER; pinned here because a changed name re-runs the purge.
const TAUGHT_SKILLS_PURGE_MARKER = "caah71-taught-skills-secret-purge";

type LogLine = { level: string; message: string; bindings?: Record<string, unknown> };

function captureLogger(lines: LogLine[]) {
  const logger = {
    level: "debug" as const,
    debug: (message: string, bindings?: Record<string, unknown>) =>
      lines.push({ level: "debug", message, bindings }),
    info: (message: string, bindings?: Record<string, unknown>) =>
      lines.push({ level: "info", message, bindings }),
    warn: (message: string, bindings?: Record<string, unknown>) =>
      lines.push({ level: "warn", message, bindings }),
    error: (message: string, bindings?: unknown) =>
      lines.push({ level: "error", message, bindings: bindings as Record<string, unknown> }),
    child: () => logger,
    withContext: <T>(_bindings: unknown, fn: () => T) => fn(),
    enrich: () => undefined,
    flush: async () => undefined,
  };
  return logger;
}

async function startApp(
  dataDir: string,
  overrides: Record<string, unknown> = {},
): Promise<Handles> {
  const { createApp } = await import("../../../apps/api/src/app.ts");
  return createApp({
    databaseUrl: process.env.DATABASE_URL!,
    realtimeDatabaseUrl: process.env.DATABASE_URL!,
    authUrl: fixtureOrigin,
    webOrigin: fixtureOrigin,
    dataDir,
    sandboxProvider: "fake",
    agentRuntime: "pi",
    wakeupDriver: "memory",
    signupsEnabled: "true",
    composio: new ComposioEmulator(),
    encryptionKey: "teach-secrets-fixture-encryption-key",
    ...overrides,
  } as never);
}

async function signedInBot(
  handles: Handles,
  model: { baseUrl: string; model: { provider: string; id: string } },
) {
  const signup = await handles.app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin: fixtureOrigin },
    body: JSON.stringify({
      email: `teach-secrets-${randomUUID()}@cortexai-agent-hub.test`,
      password: "password12",
      name: "Teach secrets fixture",
    }),
  });
  expect(signup.status).toBeLessThan(400);
  const cookie = sessionCookieHeader(signup);
  await rpc(handles.app, cookie, "models/connect", {
    provider: model.model.provider,
    modelId: model.model.id,
    baseUrl: model.baseUrl,
    apiKey: fixtureKey,
  });
  const bot = await rpc<{ id: string }>(handles.app, cookie, "bots/create", {
    name: "Teach fixture",
    title: "",
    description: "",
    instructions: "Complete the task.",
    notifyOnFinish: false,
  });
  await discardBotIntroRun(handles, cookie, bot.id);
  await rpc(handles.app, cookie, "bots/update", {
    botId: bot.id,
    modelProvider: model.model.provider,
    modelId: model.model.id,
  });
  return { cookie, botId: bot.id };
}

async function waitForRun(handles: Handles, runId: string, onFailed: () => void) {
  await expect
    .poll(
      async () => {
        const run = await handles.prisma.run.findUnique({
          where: { id: runId },
          select: { status: true },
        });
        if (run?.status === "failed") onFailed();
        return run?.status;
      },
      { timeout: 15_000, interval: 100 },
    )
    .toBe("completed");
}

async function storedSkillJson(handles: Handles, skillId: string, botId: string) {
  const skill = await handles.prisma.taughtSkill.findUniqueOrThrow({
    where: { id: skillId },
    select: { recording: true, playbook: true },
  });
  const messages = await handles.prisma.message.findMany({
    where: { thread: { botId } },
    select: { blocks: true },
  });
  return {
    recording: JSON.stringify(skill.recording),
    playbook: JSON.stringify(skill.playbook),
    messages: JSON.stringify(messages.map((message) => message.blocks)),
  };
}

describe.skipIf(!databaseAvailable)("Teach Me secret redaction (CAAH-71) on Postgres", () => {
  it("captures a demo without storing typed, pasted or protected values and replays it with placeholders only", async () => {
    const requests: ModelEmulatorRequest[] = [];
    const model = await startModelEmulator({
      apiKey: fixtureKey,
      steps: [
        {
          expect(request) {
            requests.push(request);
          },
          response: { type: "text", text: "I need the saved login to continue." },
        },
      ],
    });
    const dataDir = await mkdtemp(path.join(tmpdir(), "cortexai-agent-hub-teach-secrets-"));
    let handles: Handles | undefined;
    try {
      handles = await startApp(dataDir);
      const { cookie, botId } = await signedInBot(handles, model);
      const skill = await rpc<{ id: string }>(handles.app, cookie, "skills/start", {
        botId,
        goal: "Sign in to the CRM",
      });
      const input = (kind: string, payload: Record<string, unknown>) =>
        rpc(handles!.app, cookie, "computer/input", { botId, kind, payload });

      await input("pointer", { x: 100, y: 120, type: "click" });
      for (const key of USERNAME) await input("key", { key });
      await input("key", { key: "Tab" });
      for (const key of PASSWORD) {
        await input("key", { key, fieldType: "password", fieldLabel: "Password" });
      }
      await input("clipboard", { text: PROTECTED, sensitive: true, skillId: skill.id });
      await input("clipboard", { text: PASTED });
      await input("clipboard", {
        text: PASSWORD,
        keepLiteral: true,
        autocomplete: "one-time-code",
      });
      await input("clipboard", { text: KEPT, keepLiteral: true });
      await input("key", { key: "Enter" });
      await rpc(handles.app, cookie, "skills/stop", { skillId: skill.id });

      const draft = await rpc<{ playbook: { steps: string[] }; updatedAt: string }>(
        handles.app,
        cookie,
        "skills/get",
        {
          skillId: skill.id,
        },
      );
      expect(draft.playbook.steps).toEqual([
        "Click left button at (100, 120).",
        'Type "{{input:typed text 1}}".',
        "Press key: Tab.",
        'Type "{{secret:Password}}".',
        "Paste or type: [redacted input].",
        "Paste or type: {{input:pasted text 1}}.",
        "Paste or type: {{secret:one-time code}}.",
        `Paste or type: ${KEPT}.`,
        "Press key: Enter.",
      ]);
      await rpc(handles.app, cookie, "skills/updateDraft", {
        skillId: skill.id,
        name: "Sign in to CRM",
        playbook: draft.playbook,
        expectedUpdatedAt: draft.updatedAt,
      });
      await rpc(handles.app, cookie, "skills/save", { skillId: skill.id, name: "Sign in to CRM" });

      const stored = await storedSkillJson(handles, skill.id, botId);
      for (const value of NEVER_STORED) {
        expect(stored.recording, `recording stored ${value}`).not.toContain(value);
        expect(stored.playbook, `playbook stored ${value}`).not.toContain(value);
        expect(stored.messages, `draft card stored ${value}`).not.toContain(value);
      }
      expect(stored.recording).not.toMatch(/"key":"[^"]"/);
      expect(stored.recording).toContain(KEPT);
      expect(stored.playbook).toContain("{{secret:Password}}");

      const sent = await rpc<{ runId: string }>(handles.app, cookie, "threads/send", {
        botId,
        text: "run Sign in to CRM",
      });
      await waitForRun(handles, sent.runId, () => model.assertComplete());
      model.assertComplete();

      expect(requests).toHaveLength(1);
      const body = JSON.stringify(requests[0]);
      expect(body).toContain("Run taught skill: Sign in to CRM");
      expect(body).toContain("{{secret:Password}}");
      expect(body).toContain("{{input:typed text 1}}");
      expect(body).toContain("fill_secret");
      expect(body).toContain(KEPT);
      for (const value of NEVER_STORED) {
        expect(body, `model request contained ${value}`).not.toContain(value);
      }
    } finally {
      try {
        await handles?.stop();
      } finally {
        await model.close();
        await rm(dataDir, { recursive: true, force: true });
      }
    }
  }, 60_000);

  it("purges legacy rows after the API starts, logs counts only, records a marker, and later starts skip it", async () => {
    const requests: ModelEmulatorRequest[] = [];
    const model = await startModelEmulator({
      apiKey: fixtureKey,
      steps: [
        {
          expect(request) {
            requests.push(request);
          },
          response: { type: "text", text: "Done." },
        },
      ],
    });
    const dataDir = await mkdtemp(path.join(tmpdir(), "cortexai-agent-hub-teach-purge-"));
    let handles: Handles | undefined;
    try {
      handles = await startApp(dataDir);
      // This database has not been purged yet (as on the first start after the upgrade).
      await handles.prisma.maintenanceMarker.deleteMany({
        where: { name: TAUGHT_SKILLS_PURGE_MARKER },
      });
      const { cookie, botId } = await signedInBot(handles, model);
      const bot = await handles.prisma.bot.findUniqueOrThrow({
        where: { id: botId },
        include: { thread: true },
      });
      // What the pre-fix build stored: raw keystrokes plus the literal in the playbook and card.
      const legacyEvents: TeachRecordingEvent[] = [
        { at: "2026-09-01T00:00:00.000Z", kind: "pointer", x: 5, y: 6, type: "click" },
        ...[...PASSWORD].map((key) => ({
          at: "2026-09-01T00:00:01.000Z",
          kind: "key" as const,
          key,
        })),
        { at: "2026-09-01T00:00:02.000Z", kind: "key", key: "Enter" },
        { at: "2026-09-01T00:00:03.000Z", kind: "clipboard", text: PASTED },
      ];
      const legacyPlaybook = {
        ...buildPlaybookFromRecording("Legacy sign in", []),
        steps: [
          "Click left button at (5, 6).",
          `Type "${PASSWORD}".`,
          "Press key: Enter.",
          `Paste or type: ${PASTED}.`,
        ],
      };
      const legacy = await handles.prisma.taughtSkill.create({
        data: {
          spaceId: bot.spaceId,
          botId,
          userId: bot.userId,
          name: "Legacy sign in",
          goal: "Legacy sign in",
          status: "saved",
          recording: { events: legacyEvents, snapshots: [] } as never,
          playbook: legacyPlaybook as never,
        },
      });
      const thread = await handles.prisma.thread.update({
        where: { id: bot.thread!.id },
        data: { nextMessageSeq: { increment: 1 } },
        select: { nextMessageSeq: true },
      });
      await handles.prisma.message.create({
        data: {
          threadId: bot.thread!.id,
          seq: thread.nextMessageSeq - 1,
          role: "bot",
          botId,
          blocks: [
            {
              kind: "skill_draft",
              skillId: legacy.id,
              name: "Legacy sign in",
              goal: "Legacy sign in",
              playbook: legacyPlaybook,
              status: "saved",
            },
          ] as never,
        },
      });
      const before = await storedSkillJson(handles, legacy.id, botId);
      expect(before.recording).toContain('"key":"S"');
      expect(before.playbook).toContain(PASSWORD);
      expect(before.messages).toContain(PASSWORD);
      await handles.stop();
      handles = undefined;

      // A production start runs the purge in the background once the API is listening;
      // createApp itself no longer waits for it.
      const firstLines: LogLine[] = [];
      handles = await startApp(dataDir, {
        nodeEnv: "production",
        logger: captureLogger(firstLines),
      });
      expect(firstLines.some((line) => line.message.startsWith("taught_skills secret purge"))).toBe(
        false,
      );
      await handles.startBackgroundMaintenance();
      const first = firstLines.filter((line) =>
        line.message.startsWith("taught_skills secret purge"),
      );
      expect(first).toEqual([
        {
          level: "info",
          message: "taught_skills secret purge complete",
          bindings: {
            deployment: "127.0.0.1:5173",
            // Other suites' clean skills in this database are scanned and left alone.
            skillsScanned: expect.any(Number),
            skillsChanged: 1,
            recordingsScrubbed: 1,
            playbooksScrubbed: 1,
            skippedConcurrent: 0,
            draftMessagesScanned: expect.any(Number),
            draftMessagesScrubbed: 1,
            draftMessagesSkippedConcurrent: 0,
            markerRecorded: true,
            durationMs: expect.any(Number),
          },
        },
      ]);
      expect(JSON.stringify(firstLines)).not.toContain(PASSWORD);
      const after = await storedSkillJson(handles, legacy.id, botId);
      for (const value of [PASSWORD, PASTED]) {
        expect(after.recording).not.toContain(value);
        expect(after.playbook).not.toContain(value);
        expect(after.messages).not.toContain(value);
      }
      expect(after.recording).not.toContain('"key":"S"');
      expect(after.recording).toContain('"key":"Enter"');
      const purged = await handles.prisma.taughtSkill.findUniqueOrThrow({
        where: { id: legacy.id },
      });
      expect(purged.updatedAt.getTime()).toBe(legacy.updatedAt.getTime());
      expect((purged.playbook as { steps: string[] }).steps).toEqual([
        "Click left button at (5, 6).",
        'Type "{{input:typed text 1}}".',
        "Press key: Enter.",
        "Paste or type: {{input:pasted text 1}}.",
      ]);
      const marker = await handles.prisma.maintenanceMarker.findUnique({
        where: { name: TAUGHT_SKILLS_PURGE_MARKER },
      });
      expect(marker?.completedAt).toBeInstanceOf(Date);
      await handles.stop();
      handles = undefined;

      // The next deployment start (or a CAAH-36 self-restart) finds the marker and skips the
      // full scan.
      const secondLines: LogLine[] = [];
      handles = await startApp(dataDir, {
        nodeEnv: "production",
        logger: captureLogger(secondLines),
      });
      await handles.startBackgroundMaintenance();
      expect(
        secondLines.filter((line) => line.message.startsWith("taught_skills secret purge")),
      ).toEqual([
        {
          level: "info",
          message: "taught_skills secret purge skipped",
          bindings: {
            deployment: "127.0.0.1:5173",
            reason: "done",
            completedAt: marker!.completedAt.toISOString(),
          },
        },
      ]);
      expect(await storedSkillJson(handles, legacy.id, botId)).toEqual(after);
      // Run directly, the purge still finds nothing left to change.
      await expect(purgeTaughtSkillSecrets(handles.prisma)).resolves.toMatchObject({
        skillsChanged: 0,
        draftMessagesScrubbed: 0,
      });
      await handles.stop();
      handles = undefined;

      // The purged legacy skill still replays, with placeholders and no secret.
      handles = await startApp(dataDir);
      const sent = await rpc<{ runId: string }>(handles.app, cookie, "threads/send", {
        botId,
        text: "run Legacy sign in",
      });
      await waitForRun(handles, sent.runId, () => model.assertComplete());
      model.assertComplete();
      const body = JSON.stringify(requests[0]);
      expect(body).toContain("Run taught skill: Legacy sign in");
      expect(body).toContain("{{input:typed text 1}}");
      expect(body).not.toContain(PASSWORD);
      expect(body).not.toContain(PASTED);
    } finally {
      try {
        await handles?.stop();
      } finally {
        await model.close();
        await rm(dataDir, { recursive: true, force: true });
      }
    }
  }, 90_000);

  it("a card read before the purge cannot write the password back through updateDraft (M1)", async () => {
    const model = await startModelEmulator({ apiKey: fixtureKey, steps: [] });
    const dataDir = await mkdtemp(path.join(tmpdir(), "cortexai-agent-hub-teach-stale-"));
    let handles: Handles | undefined;
    try {
      handles = await startApp(dataDir);
      const { cookie, botId } = await signedInBot(handles, model);
      const bot = await handles.prisma.bot.findUniqueOrThrow({
        where: { id: botId },
        include: { thread: true },
      });
      // A pre-fix draft: raw keystrokes in the recording, literals in the steps and the card.
      const legacySteps = [
        "Click left button at (5, 6).",
        `Type "${PASSWORD}".`,
        "Press key: Enter.",
        `Paste or type: ${PASTED}.`,
      ];
      const legacyPlaybook = {
        ...buildPlaybookFromRecording("Legacy sign in", []),
        steps: legacySteps,
      };
      const legacy = await handles.prisma.taughtSkill.create({
        data: {
          spaceId: bot.spaceId,
          botId,
          userId: bot.userId,
          name: "Legacy sign in",
          goal: "Legacy sign in",
          status: "draft",
          recording: {
            events: [
              { at: "2026-09-01T00:00:00.000Z", kind: "pointer", x: 5, y: 6, type: "click" },
              ...[...PASSWORD].map((key) => ({
                at: "2026-09-01T00:00:01.000Z",
                kind: "key" as const,
                key,
              })),
              { at: "2026-09-01T00:00:02.000Z", kind: "key", key: "Enter" },
              { at: "2026-09-01T00:00:03.000Z", kind: "clipboard", text: PASTED },
            ],
            snapshots: [],
          } as never,
          playbook: legacyPlaybook as never,
        },
      });
      const thread = await handles.prisma.thread.update({
        where: { id: bot.thread!.id },
        data: { nextMessageSeq: { increment: 1 } },
        select: { nextMessageSeq: true },
      });
      // The old build's card carries no version.
      await handles.prisma.message.create({
        data: {
          threadId: bot.thread!.id,
          seq: thread.nextMessageSeq - 1,
          role: "bot",
          botId,
          blocks: [
            {
              kind: "skill_draft",
              skillId: legacy.id,
              name: "Legacy sign in",
              goal: "Legacy sign in",
              playbook: legacyPlaybook,
              status: "draft",
            },
          ] as never,
        },
      });
      // The open tab read the skill before the purge ran.
      const staleRead = await rpc<{ playbook: { steps: string[] }; updatedAt: string }>(
        handles.app,
        cookie,
        "skills/get",
        { skillId: legacy.id },
      );
      expect(staleRead.playbook.steps).toEqual(legacySteps);

      await expect(purgeTaughtSkillSecrets(handles.prisma)).resolves.toMatchObject({
        skillsChanged: 1,
        draftMessagesScrubbed: 1,
      });
      const purged = await storedSkillJson(handles, legacy.id, botId);
      expect(purged.playbook).not.toContain(PASSWORD);

      // 1. The old card sends no version: 409, nothing written.
      const unversioned = await rawRpc(handles.app, cookie, "skills/updateDraft", {
        skillId: legacy.id,
        name: "Legacy sign in",
        playbook: staleRead.playbook,
      });
      expect(unversioned.status).toBe(409);
      expect(await storedSkillJson(handles, legacy.id, botId)).toEqual(purged);

      // 2. The purge keeps updatedAt, so the stale read's version still matches. The literal
      // steps are scrubbed anyway: the value is not stored even with a matching token.
      const matching = await rpc<{ playbook: { steps: string[] }; updatedAt: string }>(
        handles.app,
        cookie,
        "skills/updateDraft",
        {
          skillId: legacy.id,
          name: "Legacy sign in",
          playbook: {
            ...staleRead.playbook,
            steps: [...legacySteps, "Paste or type: hunter2pass."],
          },
          expectedUpdatedAt: staleRead.updatedAt,
        },
      );
      expect(matching.playbook.steps).toEqual([
        "Click left button at (5, 6).",
        'Type "{{input:typed text 1}}".',
        "Press key: Enter.",
        "Paste or type: {{input:pasted text 1}}.",
        "Paste or type: {{input:pasted text 2}}.",
      ]);
      const after = await storedSkillJson(handles, legacy.id, botId);
      for (const value of [PASSWORD, PASTED, "hunter2pass"]) {
        expect(after.playbook, `playbook stored ${value}`).not.toContain(value);
        expect(after.recording, `recording stored ${value}`).not.toContain(value);
        expect(after.messages, `draft card stored ${value}`).not.toContain(value);
      }
      // The card now carries the row's version for the next edit.
      expect(after.messages).toContain(`"updatedAt":"${matching.updatedAt}"`);

      // 3. The same stale version is now rejected.
      const replayed = await rawRpc(handles.app, cookie, "skills/updateDraft", {
        skillId: legacy.id,
        playbook: staleRead.playbook,
        expectedUpdatedAt: staleRead.updatedAt,
      });
      expect(replayed.status).toBe(409);
      expect(await storedSkillJson(handles, legacy.id, botId)).toEqual(after);
    } finally {
      try {
        await handles?.stop();
      } finally {
        await model.close();
        await rm(dataDir, { recursive: true, force: true });
      }
    }
  }, 60_000);
});

async function rawRpc(
  app: App,
  cookie: string,
  procedure: string,
  input: unknown,
): Promise<{ status: number }> {
  const response = await app.request(`/rpc/${procedure}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, origin: fixtureOrigin },
    body: JSON.stringify({ json: input }),
  });
  await response.body?.cancel();
  return { status: response.status };
}

async function rpc<T>(
  app: App,
  cookie: string,
  procedure: string,
  input: unknown = {},
): Promise<T> {
  const response = await app.request(`/rpc/${procedure}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, origin: fixtureOrigin },
    body: JSON.stringify({ json: input }),
  });
  const body = (await response.json()) as { json?: T; error?: { message?: string } };
  if (response.status >= 400 || body.error)
    throw new Error(`${procedure}: ${body.error?.message ?? response.status}`);
  return body.json as T;
}
