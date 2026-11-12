import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentRuntimeEvent } from "@cortexai-agent-hub/adapter-kit";
import {
  attachFailure,
  EncryptedSecretStore,
  FakeSandboxProvider,
  LocalArtifactStore,
  resolveBotWorkspacePath,
  ScriptedAgentRuntime,
  unsupportedAttachmentError,
  WORKSPACE_DELIVERY_INSTRUCTION,
} from "@cortexai-agent-hub/adapters";
import type { createApp } from "@cortexai-agent-hub/api/app";
import type { MessageBlock } from "@cortexai-agent-hub/contracts";
import { ATTACHMENT_MAX_BYTES } from "@cortexai-agent-hub/contracts";
import { resolveEncryptionKey } from "@cortexai-agent-hub/core";
import {
  answerRunInput,
  contentEncryptionOf,
  parseComputerMode,
  runAsSystem,
  runAsTenant,
} from "@cortexai-agent-hub/db";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { discardBotIntroFromCreate } from "./discard-bot-intro.js";
import { asSystem } from "./system-db.js";

const hasDb = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const describeIntegration = hasDb ? describe : describe.skip;
const destination = {
  name: "example_api",
  origin: "https://api.example.test",
  auth: { type: "bearer" },
};
const key = "fake-reusable-api-key";

describeIntegration("reusable credential lifecycle", () => {
  let handles: Awaited<ReturnType<typeof createApp>>;
  let db: Awaited<ReturnType<typeof createApp>>["prisma"];
  const dataDir = mkdtempSync(path.join(tmpdir(), "cortexai-agent-hub-secret-lifecycle-"));
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const echoAuth: typeof globalThis.fetch = async (_url, init) => {
    const auth = new Headers(init?.headers).get("Authorization");
    return Response.json({
      authenticated: auth === `Bearer ${key}` || auth === `Bearer ${key}-rotated`,
      echo: auth,
    });
  };
  const fetch = vi.fn<typeof globalThis.fetch>(echoAuth);
  const resolveHostname = vi.fn(async (_hostname: string) => [
    { address: "203.0.113.10", family: 4 as const },
  ]);

  beforeAll(async () => {
    const { createApp } = await import("@cortexai-agent-hub/api/app");
    handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      wakeupDriver: "memory",
      defaultProvider: "scripted",
      defaultModel: "scripted",
      remoteConnectors: { fetch, resolveHostname },
    });
    db = asSystem(handles.prisma);
  });
  afterAll(async () => {
    await handles?.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });
  afterEach(() => {
    fetch.mockImplementation(echoAuth);
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it.each([false, true])(
    "saves, reuses, rotates and revokes without model-visible plaintext (approval rule: %s)",
    async (requireApproval) => {
      fetch.mockClear();
      const seen: string[] = [];
      let calls: Array<{ name: string; args: Record<string, unknown> }> = [
        {
          name: "request_secret",
          args: { label: "API key", purpose: "api_key", credential: destination },
        },
      ];
      const runtime = vi
        .spyOn(ScriptedAgentRuntime.prototype, "run")
        .mockImplementation(async function* (request): AsyncIterable<AgentRuntimeEvent> {
          seen.push(
            JSON.stringify({
              prompt: request.prompt,
              history: request.history,
              tools: request.tools,
            }),
          );
          for (const [index, call] of calls.entries()) {
            yield { type: "tool", ...call, executionId: `${request.runId}:${index}` };
          }
          yield { type: "done", text: "Done" };
        });
      try {
        const seeded = await seedRun(`reusable-${requireApproval}`, "Save the API credential");
        // The owner allowed using and forgetting saved credentials, so only request_secret asks.
        await db.userActionApprovalRule.createMany({
          data: ["secret_request", "forget_secret"].map((matchValue) => ({
            userId: seeded.me.userId,
            effect: "always_allow",
            matchKind: "tool",
            matchValue,
          })),
        });
        if (requireApproval) {
          await db.userActionApprovalRule.create({
            data: {
              userId: seeded.me.userId,
              effect: "require_approval",
              matchKind: "tool",
              matchValue: "request_secret",
            },
          });
        }
        await runAsSystem("background job run.continue", () =>
          handles.executor.continueRun(seeded.run.id, "test-worker"),
        );
        const approve = async (runId: string, interruptBeforeCard = false) => {
          if (!requireApproval) return;
          // A just-continued run can still sit requeued while the previous run's
          // worker releases the computer lease, so the card may land a moment later.
          const message = await vi.waitFor(
            async () =>
              db.message.findFirstOrThrow({
                where: { runId, role: "bot" },
                orderBy: { createdAt: "desc" },
              }),
            { timeout: 15_000 },
          );
          expect(message.blocks).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ approvalEffectId: expect.any(String) }),
            ]),
          );
          if (interruptBeforeCard) {
            // Reproduce a worker stopping after releasing the approved effect to intended,
            // before the protected card transaction commits. No background job is enqueued.
            expect(
              await runAsTenant(seeded.me, () =>
                answerRunInput(handles.prisma, {
                  spaceId: seeded.me.spaceId,
                  threadId: seeded.thread.id,
                  runId,
                  messageId: message.id,
                  answeredByUserId: seeded.me.userId,
                  answer: "allow",
                }),
              ),
            ).toBe(true);
            await db.externalEffect.updateMany({
              where: { runId, kind: "request_secret", status: "approved" },
              data: { status: "intended" },
            });
            await db.run.update({
              where: { id: runId },
              data: {
                status: "running",
                leaseOwner: "interrupted-worker",
                leaseExpiresAt: new Date(Date.now() - 60_000),
              },
            });
            await runAsSystem("background job run.continue", () =>
              handles.executor.continueRun(runId, "recovery-worker"),
            );
          } else {
            await rpc(seeded.cookie, "threads/answer", {
              botId: seeded.bot.id,
              runId,
              messageId: message.id,
              answer: "allow",
            });
          }
          await vi.waitFor(
            async () => {
              const run = await db.run.findUniqueOrThrow({ where: { id: runId } });
              expect(["completed", "waiting_input"]).toContain(run.status);
            },
            { timeout: 15_000 },
          );
        };
        await approve(seeded.run.id);
        const answer = async (runId: string, value: string) => {
          const message = await db.message.findFirstOrThrow({
            where: { runId, role: "bot" },
            orderBy: { createdAt: "desc" },
          });
          expect(message.blocks).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ input: "secret", credential: destination }),
            ]),
          );
          await rpc(seeded.cookie, "threads/answer", {
            botId: seeded.bot.id,
            runId,
            messageId: message.id,
            answer: value,
          });
          await vi.waitFor(
            async () => {
              expect(await db.run.findUniqueOrThrow({ where: { id: runId } })).toMatchObject({
                status: "completed",
                error: null,
              });
            },
            { timeout: 15_000 },
          );
        };
        expect(await db.run.findUniqueOrThrow({ where: { id: seeded.run.id } })).toMatchObject({
          status: "waiting_input",
          error: null,
        });
        // An invalid value rolls back the run transition and leaves the card pending.
        const pending = await db.message.findFirstOrThrow({
          where: { runId: seeded.run.id, role: "bot" },
          orderBy: { seq: "desc" },
        });
        expect(pending.blocks).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              kind: "ask",
              input: "secret",
              status: "pending",
              credential: destination,
            }),
          ]),
        );
        for (const invalid of ["x".repeat(16_385), "key\r\nX-Evil: injected", "key "]) {
          await expect(
            rpc(seeded.cookie, "threads/answer", {
              botId: seeded.bot.id,
              runId: seeded.run.id,
              messageId: pending.id,
              answer: invalid,
            }),
          ).rejects.toThrow();
        }
        expect(await db.run.findUniqueOrThrow({ where: { id: seeded.run.id } })).toMatchObject({
          status: "waiting_input",
        });
        expect(await db.vaultCredential.count({ where: { userId: seeded.me.userId } })).toBe(0);
        await answer(seeded.run.id, key);
        const stored = await db.vaultCredential.findFirstOrThrow({
          where: { userId: seeded.me.userId },
        });
        // Saved in the account vault, which the Space uses until it has its own.
        expect(stored).toMatchObject({
          ...destination,
          userId: seeded.me.userId,
          spaceId: null,
        });
        expect(stored.ciphertext).toMatch(/^v2:/);
        expect(stored.ciphertext).not.toContain(key);
        expect(await db.secret.count({ where: { kind: `run-secret:${seeded.run.id}` } })).toBe(0);

        const nextRun = async (nextCalls: typeof calls) => {
          calls = nextCalls;
          const task = await db.task.create({
            data: {
              userId: seeded.me.userId,
              spaceId: seeded.me.spaceId,
              botId: seeded.bot.id,
              threadId: seeded.thread.id,
              prompt: "Use the saved credential",
              status: "queued",
            },
          });
          const run = await db.run.create({
            data: {
              userId: seeded.me.userId,
              spaceId: seeded.me.spaceId,
              botId: seeded.bot.id,
              threadId: seeded.thread.id,
              taskId: task.id,
              trigger: "user",
              status: "queued",
            },
          });
          await runAsSystem("background job run.continue", () =>
            handles.executor.continueRun(run.id, "test-worker"),
          );
          return run.id;
        };
        const request = {
          name: "secret_request",
          args: { name: destination.name, url: `${destination.origin}/v1/items` },
        };
        const useRun = await nextRun([
          { name: "list_secrets", args: {} },
          {
            name: "request_secret",
            args: { label: "API key", purpose: "api_key", credential: destination },
          },
          request,
        ]);
        await approve(useRun);
        await vi.waitFor(
          async () => {
            expect(await db.run.findUniqueOrThrow({ where: { id: useRun } })).toMatchObject({
              status: "completed",
              error: null,
            });
          },
          { timeout: 15_000 },
        );
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(
          await db.externalEffect.findFirstOrThrow({
            where: { runId: useRun, kind: "secret_request" },
          }),
        ).toMatchObject({
          status: "completed",
          result: {
            status: 200,
            body: { authenticated: true, echo: expect.stringContaining("[redacted]") },
          },
        });

        const rotateRun = await nextRun([
          {
            name: "request_secret",
            args: { label: "API key", purpose: "api_key", credential: destination, replace: true },
          },
        ]);
        await vi.waitFor(
          async () => {
            expect(await db.run.findUniqueOrThrow({ where: { id: rotateRun } })).toMatchObject({
              status: "waiting_input",
            });
          },
          { timeout: 15_000 },
        );
        await approve(rotateRun, true);
        expect(await db.run.findUniqueOrThrow({ where: { id: rotateRun } })).toMatchObject({
          status: "waiting_input",
        });
        expect(
          await db.vaultCredential.findUniqueOrThrow({ where: { id: stored.id } }),
        ).toMatchObject({
          ciphertext: stored.ciphertext,
        });
        await answer(rotateRun, `${key}-rotated`);
        expect(
          await db.vaultCredential.findUniqueOrThrow({ where: { id: stored.id } }),
        ).not.toMatchObject({ ciphertext: stored.ciphertext });
        const rotatedUse = await nextRun([request]);
        await vi.waitFor(
          async () => {
            expect(await db.run.findUniqueOrThrow({ where: { id: rotatedUse } })).toMatchObject({
              status: "completed",
              error: null,
            });
          },
          { timeout: 15_000 },
        );
        expect(new Headers(fetch.mock.calls.at(-1)?.[1]?.headers).get("Authorization")).toBe(
          `Bearer ${key}-rotated`,
        );
        const count = fetch.mock.calls.length;
        const forgotten = await nextRun([
          { name: "forget_secret", args: { name: destination.name } },
          request,
        ]);
        // The deletion alone does not prove the run finished: the trailing use request and
        // its writes can still be pending. Wait for the run itself, then assert the effects.
        await vi.waitFor(
          async () => {
            expect(await db.run.findUniqueOrThrow({ where: { id: forgotten } })).toMatchObject({
              status: "completed",
              error: null,
            });
          },
          { timeout: 15_000 },
        );
        expect(await db.vaultCredential.count({ where: { userId: seeded.me.userId } })).toBe(0);
        expect(fetch).toHaveBeenCalledTimes(count);
        const [messages, events, effects, tasks] = await Promise.all([
          db.message.findMany({ where: { threadId: seeded.thread.id } }),
          db.event.findMany({ where: { threadId: seeded.thread.id } }),
          db.externalEffect.findMany({ where: { spaceId: seeded.me.spaceId } }),
          db.task.findMany({ where: { botId: seeded.bot.id } }),
        ]);
        expect(JSON.stringify({ seen, messages, events, effects, tasks })).not.toContain(key);
      } finally {
        runtime.mockRestore();
      }
    },
  );

  describe("secret_request through the executor", () => {
    const request = (path: string) => ({
      name: "secret_request",
      args: { name: destination.name, url: `${destination.origin}${path}` },
    });
    const pdf = "%PDF-1.4 fake quarterly report";
    const pdfResponse = (body: BodyInit = pdf, headers: Record<string, string> = {}) =>
      new Response(body, {
        headers: {
          "content-type": "application/pdf",
          "content-disposition": 'attachment; filename="report.pdf"',
          ...headers,
        },
      });
    const pendingUntilAborted: typeof globalThis.fetch = (_url, init) =>
      new Promise((_resolve, reject) =>
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
      );

    async function seedWithCredential(label: string) {
      const seeded = await seedRun(label, "Save the API credential");
      // Ask mode would pause secret_request on a card; these tests cover the request itself.
      await db.userActionApprovalRule.create({
        data: {
          userId: seeded.me.userId,
          effect: "always_allow",
          matchKind: "tool",
          matchValue: "secret_request",
        },
      });
      // A non-scripted run needs a connected model; the mocked runtime never calls it.
      await rpc(seeded.cookie, "models/connect", {
        provider: "fixture-provider",
        apiKey: "fake-model-key",
        modelId: "fixture/model",
      });
      const runtime = vi
        .spyOn(ScriptedAgentRuntime.prototype, "run")
        .mockImplementation(async function* (runRequest): AsyncIterable<AgentRuntimeEvent> {
          yield {
            type: "tool",
            name: "request_secret",
            args: { label: "API key", purpose: "api_key", credential: destination },
            executionId: `${runRequest.runId}:0`,
          };
          yield { type: "done", text: "Done" };
        });
      try {
        await runAsSystem("background job run.continue", () =>
          handles.executor.continueRun(seeded.run.id, "test-worker"),
        );
        const message = await db.message.findFirstOrThrow({
          where: { runId: seeded.run.id, role: "bot" },
          orderBy: { seq: "desc" },
        });
        await rpc(seeded.cookie, "threads/answer", {
          botId: seeded.bot.id,
          runId: seeded.run.id,
          messageId: message.id,
          answer: key,
        });
        await vi.waitFor(
          async () =>
            expect(await db.run.findUniqueOrThrow({ where: { id: seeded.run.id } })).toMatchObject({
              status: "completed",
              error: null,
            }),
          { timeout: 15_000 },
        );
      } finally {
        runtime.mockRestore();
      }
      return seeded;
    }

    /** Runs the tools through the model-facing executeTool callback and returns what the model saw. */
    async function runTools(
      seeded: Awaited<ReturnType<typeof seedRun>>,
      steps: Array<{
        name: string;
        args: Record<string, unknown>;
        before?: (runId: string) => void | Promise<void>;
      }>,
    ) {
      const results: unknown[] = [];
      let finished = false;
      let instructions = "";
      const describeRuntime = ScriptedAgentRuntime.prototype.describe;
      const modelFacing = vi
        .spyOn(ScriptedAgentRuntime.prototype, "describe")
        .mockImplementation(function (this: ScriptedAgentRuntime) {
          const described = describeRuntime.call(this);
          return { ...described, capabilities: { ...described.capabilities, scripted: false } };
        });
      const runtime = vi
        .spyOn(ScriptedAgentRuntime.prototype, "run")
        .mockImplementation(async function* (runRequest): AsyncIterable<AgentRuntimeEvent> {
          instructions = runRequest.instructions;
          try {
            for (const [index, step] of steps.entries()) {
              await step.before?.(runRequest.runId);
              results.push(
                await runRequest.executeTool!(step.name, step.args, `${runRequest.runId}:${index}`),
              );
            }
          } finally {
            finished = true;
          }
          yield { type: "done", text: "Done" };
        });
      try {
        const task = await db.task.create({
          data: {
            userId: seeded.me.userId,
            spaceId: seeded.me.spaceId,
            botId: seeded.bot.id,
            threadId: seeded.thread.id,
            prompt: "Use the saved credential",
            status: "queued",
          },
        });
        const run = await db.run.create({
          data: {
            userId: seeded.me.userId,
            spaceId: seeded.me.spaceId,
            botId: seeded.bot.id,
            threadId: seeded.thread.id,
            taskId: task.id,
            trigger: "user",
            status: "queued",
          },
        });
        await runAsSystem("background job run.continue", () =>
          handles.executor.continueRun(run.id, "test-worker"),
        );
        // A run waiting on the previous run's computer lease is retried by the background worker.
        await vi.waitFor(() => expect(finished).toBe(true), { timeout: 15_000 });
        await vi.waitFor(
          async () =>
            expect((await db.run.findUniqueOrThrow({ where: { id: run.id } })).status).not.toBe(
              "queued",
            ),
          { timeout: 15_000 },
        );
        expect(runtime).toHaveBeenCalledOnce();
        return { runId: run.id, results, instructions };
      } finally {
        runtime.mockRestore();
        modelFacing.mockRestore();
      }
    }

    it("saves a download the same run can list, read and attach, and keeps it after commit", async () => {
      const seeded = await seedWithCredential("download-visible");
      fetch.mockImplementation(async () => pdfResponse());
      const { runId, results } = await runTools(seeded, [
        request("/v1/reports/latest"),
        { name: "list_files", args: { path: "downloads" } },
        { name: "read_file", args: { path: "downloads/report.pdf" } },
        { name: "attach_file", args: { path: "downloads/report.pdf" } },
      ]);
      expect(results).toEqual([
        {
          file: {
            path: "downloads/report.pdf",
            filename: "report.pdf",
            size: pdf.length,
            contentType: "application/pdf",
            sha256: createHash("sha256").update(pdf).digest("hex"),
          },
        },
        {
          path: "downloads",
          entries: [{ path: "downloads/report.pdf", kind: "file", size: pdf.length }],
        },
        { path: "downloads/report.pdf", content: pdf },
        { ok: true, artifactId: expect.any(String), path: "downloads/report.pdf" },
      ]);
      await vi.waitFor(
        async () =>
          expect(await db.run.findUniqueOrThrow({ where: { id: runId } })).toMatchObject({
            status: "completed",
            error: null,
          }),
        { timeout: 15_000 },
      );
      const { artifactId } = results[3] as { artifactId: string };
      const attached = await db.message.findMany({ where: { runId, role: "bot" } });
      expect(JSON.stringify(attached.map((message) => message.blocks))).toContain(artifactId);

      const next = await runTools(seeded, [
        { name: "read_file", args: { path: "downloads/report.pdf" } },
      ]);
      expect(next.results).toEqual([{ path: "downloads/report.pdf", content: pdf }]);
    });

    /** The bot's files as the fake computer stores them, keyed by the path the bot uses. */
    async function computerFiles(botId: string) {
      const { computer } = await db.bot.findUniqueOrThrow({
        where: { id: botId },
        include: { computer: true },
      });
      const box = (handles.sandbox as FakeSandboxProvider).boxes.get(`fake-${computer!.homeKey}`);
      expect(box).toBeDefined();
      const stored = (botPath: string) =>
        resolveBotWorkspacePath(parseComputerMode(computer!.scope), botId, botPath);
      return {
        get: (botPath: string) => box!.files.get(stored(botPath)),
        set: (botPath: string, content: Uint8Array) =>
          box!.files.set(stored(botPath), { content, executable: false }),
        has: (botPath: string) => box!.files.has(stored(botPath)),
        storedPath: stored,
        paths: () => [...box!.files.keys()],
      };
    }
    const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

    it("keeps every byte value intact from the download through the computer to the attachment", async () => {
      const seeded = await seedWithCredential("download-binary");
      const body = Uint8Array.from({ length: 4096 }, (_, index) => index % 256);
      fetch.mockImplementation(
        async () =>
          new Response(body, {
            headers: {
              "content-type": "application/pdf",
              "content-disposition": 'attachment; filename="binary.pdf"',
            },
          }),
      );
      const { results } = await runTools(seeded, [
        request("/v1/binary"),
        { name: "list_files", args: { path: "downloads" } },
        { name: "attach_file", args: { path: "downloads/binary.pdf" } },
      ]);
      expect(results).toEqual([
        {
          file: {
            path: "downloads/binary.pdf",
            filename: "binary.pdf",
            size: body.byteLength,
            contentType: "application/pdf",
            sha256: sha256(body),
          },
        },
        {
          path: "downloads",
          entries: [{ path: "downloads/binary.pdf", kind: "file", size: body.byteLength }],
        },
        { ok: true, artifactId: expect.any(String), path: "downloads/binary.pdf" },
      ]);
      const stored = (await computerFiles(seeded.bot.id)).get("downloads/binary.pdf");
      expect(stored && sha256(stored.content)).toBe(sha256(body));
      const artifact = await db.artifact.findUniqueOrThrow({
        where: { id: (results[2] as { artifactId: string }).artifactId },
      });
      const attached = await new LocalArtifactStore(
        dataDir,
        contentEncryptionOf(handles.prisma)?.ring,
      ).get(artifact.storageKey, {
        operationId: "test",
        traceId: "test",
        spaceId: artifact.spaceId,
        userId: artifact.userId,
        signal: new AbortController().signal,
      });
      expect(sha256(attached)).toBe(sha256(body));
      expect(artifact.hash).toBe(sha256(body));

      (await computerFiles(seeded.bot.id)).set(
        "downloads/large.pdf",
        new Uint8Array(ATTACHMENT_MAX_BYTES + 1),
      );
      const oversized = await runTools(seeded, [
        { name: "attach_file", args: { path: "downloads/large.pdf" } },
      ]);
      expect(oversized.results).toEqual([
        {
          error: attachFailure("file exceeds the 10 MiB attachment limit"),
          path: "downloads/large.pdf",
        },
      ]);
    });

    it("attaches Office files and explains refused types without linking the path", async () => {
      const seeded = await seedWithCredential("attach-office");
      const files = await computerFiles(seeded.bot.id);
      const workbook = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]);
      files.set("out/report.xlsx", workbook);
      files.set("out/macro.xlsm", workbook);
      const { runId, results, instructions } = await runTools(seeded, [
        { name: "attach_file", args: { path: "out/report.xlsx" } },
        { name: "attach_file", args: { path: "out/macro.xlsm" } },
        { name: "attach_file", args: { path: "out/missing.docx" } },
      ]);
      expect(results).toEqual([
        { ok: true, artifactId: expect.any(String), path: "out/report.xlsx" },
        { error: unsupportedAttachmentError("out/macro.xlsm"), path: "out/macro.xlsm" },
        { error: attachFailure("file not found or unreadable"), path: "out/missing.docx" },
      ]);
      expect(instructions).toContain(WORKSPACE_DELIVERY_INSTRUCTION);
      const artifact = await db.artifact.findUniqueOrThrow({
        where: { id: (results[0] as { artifactId: string }).artifactId },
      });
      expect(artifact).toMatchObject({
        name: "report.xlsx",
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        size: workbook.byteLength,
      });
      const attached = await db.message.findMany({ where: { runId, role: "bot" } });
      expect(attached.flatMap((message) => message.blocks as MessageBlock[])).toContainEqual(
        expect.objectContaining({ kind: "file", artifactId: artifact.id, name: "report.xlsx" }),
      );
    });

    it("names an extensionless PDF endpoint so it can be attached", async () => {
      const seeded = await seedWithCredential("download-extensionless");
      fetch.mockImplementation(
        async () => new Response(pdf, { headers: { "content-type": "application/pdf" } }),
      );
      const { results } = await runTools(seeded, [
        request("/api/forms/abc/pdf"),
        { name: "attach_file", args: { path: "downloads/pdf.pdf" } },
      ]);
      expect(results).toEqual([
        {
          file: expect.objectContaining({ path: "downloads/pdf.pdf", filename: "pdf.pdf" }),
        },
        { ok: true, artifactId: expect.any(String), path: "downloads/pdf.pdf" },
      ]);
    });

    it("rejects over-cap downloads and leaves nothing in downloads/", async () => {
      const seeded = await seedWithCredential("download-over-cap");
      const overAttachmentCap = new Uint8Array(ATTACHMENT_MAX_BYTES + 1);
      const { results } = await runTools(seeded, [
        {
          ...request("/v1/declared"),
          before: () => {
            fetch.mockImplementation(async () =>
              pdfResponse(new ReadableStream(), {
                "content-length": String(200 * 1024 * 1024),
              }),
            );
          },
        },
        {
          ...request("/v1/streamed"),
          before: () => {
            fetch.mockImplementation(async () =>
              pdfResponse(
                new ReadableStream({
                  start(controller) {
                    controller.enqueue(overAttachmentCap);
                    controller.close();
                  },
                }),
              ),
            );
          },
        },
        {
          ...request("/v1/configured"),
          before: () => {
            vi.stubEnv("CORTEXAI_AGENT_HUB_SECRET_REQUEST_FILE_CAP_BYTES", "1024");
            fetch.mockImplementation(async () => pdfResponse(new Uint8Array(2048)));
          },
        },
        { name: "list_files", args: { path: "downloads" } },
      ]);
      expect(results).toEqual([
        {
          error:
            "Response size 209715200 bytes exceeds the 10485760 byte file download limit for this computer.",
        },
        { error: "Response exceeds the 10485760 byte file download limit for this computer." },
        { error: "Response exceeds the 1024 byte file download limit for this computer." },
        { path: "downloads", entries: [] },
      ]);
      const files = await computerFiles(seeded.bot.id);
      const downloads = files.storedPath("downloads/");
      expect(files.paths().filter((file) => file.startsWith(downloads))).toEqual([]);
    });

    it("returns each failure class to the model as its specific, redacted message", async () => {
      const seeded = await seedWithCredential("download-failures");
      const { runId, results } = await runTools(seeded, [
        {
          ...request("/v1/too-large"),
          before: () => {
            vi.stubEnv("CORTEXAI_AGENT_HUB_SECRET_REQUEST_FILE_CAP_BYTES", "16");
            fetch.mockImplementation(async () =>
              pdfResponse(
                new ReadableStream({
                  start(controller) {
                    controller.enqueue(new Uint8Array(64));
                    controller.close();
                  },
                }),
              ),
            );
          },
        },
        {
          ...request("/v1/slow"),
          before: () => {
            vi.stubEnv("CORTEXAI_AGENT_HUB_SECRET_REQUEST_TIMEOUT_MS", "100");
            fetch.mockImplementation(pendingUntilAborted);
          },
        },
        {
          ...request("/v1/moved"),
          before: () => {
            vi.unstubAllEnvs();
            fetch.mockImplementation(
              async () =>
                new Response(null, {
                  status: 302,
                  headers: { location: `https://elsewhere.example.test/${key}` },
                }),
            );
          },
        },
        {
          ...request("/v1/blocked"),
          before: () => {
            resolveHostname.mockImplementationOnce(async () => [
              { address: "10.0.0.8", family: 4 },
            ]);
          },
        },
        {
          ...request("/v1/dns"),
          before: () => {
            resolveHostname.mockImplementationOnce(async () => {
              throw Object.assign(new Error("getaddrinfo ENOTFOUND api.example.test"), {
                code: "ENOTFOUND",
              });
            });
          },
        },
        {
          ...request("/v1/refused"),
          before: () => {
            fetch.mockImplementation(async () => {
              throw new TypeError("fetch failed", {
                cause: new Error(`connect ECONNREFUSED 203.0.113.10:443 ${key}`),
              });
            });
          },
        },
        {
          ...request("/v1/unsaved"),
          before: () => {
            fetch.mockImplementation(async () => pdfResponse());
            vi.spyOn(FakeSandboxProvider.prototype, "writeFile").mockRejectedValueOnce(
              new Error(`disk full ${key}`),
            );
          },
        },
      ]);
      expect(results).toEqual([
        { error: "Response exceeds the 16 byte file download limit for this computer." },
        { error: "Request timed out after 1 second." },
        {
          error:
            "Redirect not followed (HTTP 302 to elsewhere.example.test). Request the final URL directly.",
        },
        { error: "Destination is blocked by network policy." },
        { error: "DNS lookup failed for api.example.test. Check the destination hostname." },
        {
          error:
            "Network error: Could not reach api.example.test: connect ECONNREFUSED 203.0.113.10:443 [REDACTED].",
        },
        { error: "Could not save the downloaded file to the bot workspace." },
      ]);
      const effects = await db.externalEffect.findMany({
        where: { runId, kind: "secret_request" },
      });
      expect(effects).toHaveLength(results.length);
      expect(JSON.stringify({ results, effects })).not.toContain(key);
    });

    it("reports a run cancelled mid-request as cancelled", async () => {
      const seeded = await seedWithCredential("download-cancelled");
      const heartbeats: Array<() => void> = [];
      const realSetInterval = globalThis.setInterval;
      vi.spyOn(globalThis, "setInterval").mockImplementation(((
        callback: () => void,
        ms?: number,
      ) => {
        if (ms === 60_000) heartbeats.push(callback);
        return realSetInterval(callback, ms);
      }) as typeof setInterval);
      let cancelledRunId = "";
      fetch.mockImplementation((url, init) => {
        const pending = pendingUntilAborted(url, init);
        // Another worker taking the lease is how a stopped run loses its tools.
        void db.run
          .update({ where: { id: cancelledRunId }, data: { leaseOwner: "another-worker" } })
          .then(() => heartbeats.at(-1)?.());
        return pending;
      });
      const { results } = await runTools(seeded, [
        {
          ...request("/v1/export"),
          before: (runId) => {
            cancelledRunId = runId;
          },
        },
      ]);
      expect(results).toEqual([{ error: "Request was cancelled before it finished." }]);
    });
  });

  it("reuses a website login saved for the same site under another name", async () => {
    const site = "https://www.login.example.test";
    const password = "fake-site-password-3b9e";
    const seen: string[] = [];
    let calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const requestLogin = (name: string, origin = site) => ({
      name: "request_secret",
      args: {
        label: "Sign in",
        purpose: "password",
        credential: { name, origin, auth: { type: "login" } },
        fields: ["Username", "Password"],
      },
    });
    const runtime = vi
      .spyOn(ScriptedAgentRuntime.prototype, "run")
      .mockImplementation(async function* (request): AsyncIterable<AgentRuntimeEvent> {
        seen.push(JSON.stringify({ prompt: request.prompt, history: request.history }));
        for (const [index, call] of calls.entries()) {
          yield { type: "tool", ...call, executionId: `${request.runId}:${index}` };
        }
        yield { type: "done", text: "Done" };
      });
    try {
      calls = [requestLogin("site_login")];
      const seeded = await seedRun("site-login", "Sign in to the site");
      await runAsSystem("background job run.continue", () =>
        handles.executor.continueRun(seeded.run.id, "test-worker"),
      );
      const card = await db.message.findFirstOrThrow({
        where: { runId: seeded.run.id, role: "bot" },
        orderBy: { seq: "desc" },
      });
      await rpc(seeded.cookie, "threads/answer", {
        botId: seeded.bot.id,
        runId: seeded.run.id,
        messageId: card.id,
        answer: "",
        fields: [
          { label: "Username", value: "fake-user", hidden: false },
          { label: "Password", value: password, hidden: true },
        ],
      });
      await vi.waitFor(
        async () => {
          expect(await db.run.findUniqueOrThrow({ where: { id: seeded.run.id } })).toMatchObject({
            status: "completed",
            error: null,
          });
        },
        { timeout: 15_000 },
      );

      const nextRun = async (owner: typeof seeded, nextCalls: typeof calls) => {
        calls = nextCalls;
        const task = await db.task.create({
          data: {
            userId: owner.me.userId,
            spaceId: owner.me.spaceId,
            botId: owner.bot.id,
            threadId: owner.thread.id,
            prompt: "Sign in again",
            status: "queued",
          },
        });
        const run = await db.run.create({
          data: {
            userId: owner.me.userId,
            spaceId: owner.me.spaceId,
            botId: owner.bot.id,
            threadId: owner.thread.id,
            taskId: task.id,
            trigger: "user",
            status: "queued",
          },
        });
        await runAsSystem("background job run.continue", () =>
          handles.executor.continueRun(run.id, "test-worker"),
        );
        return db.run.findUniqueOrThrow({ where: { id: run.id } });
      };

      // Another name for the same site gets the saved login's name, without a card.
      const reused = await nextRun(seeded, [requestLogin("my_site_account")]);
      await vi.waitFor(
        async () => {
          expect(await db.run.findUniqueOrThrow({ where: { id: reused.id } })).toMatchObject({
            status: "completed",
            error: null,
          });
        },
        { timeout: 15_000 },
      );
      expect(
        await db.externalEffect.findFirstOrThrow({
          where: { runId: reused.id, kind: "request_secret" },
        }),
      ).toMatchObject({
        status: "completed",
        result: { saved: true, name: "site_login", origin: site, auth: { type: "login" } },
      });
      // The host without www. is another site.
      const bare = await nextRun(seeded, [
        requestLogin("bare_login", "https://login.example.test"),
      ]);
      await vi.waitFor(
        async () => {
          expect(await db.run.findUniqueOrThrow({ where: { id: bare.id } })).toMatchObject({
            status: "waiting_input",
          });
        },
        { timeout: 15_000 },
      );
      // Another member's vault is not searched.
      const other = await seedRun("site-login-other", "Sign in to the site");
      const otherRun = await nextRun(other, [requestLogin("my_site_account")]);
      await vi.waitFor(
        async () => {
          expect(await db.run.findUniqueOrThrow({ where: { id: otherRun.id } })).toMatchObject({
            status: "waiting_input",
          });
        },
        { timeout: 15_000 },
      );
      expect(await db.vaultCredential.count({ where: { origin: site } })).toBe(1);

      const [messages, events, effects] = await Promise.all([
        db.message.findMany({ where: { threadId: seeded.thread.id } }),
        db.event.findMany({ where: { threadId: seeded.thread.id } }),
        db.externalEffect.findMany({ where: { spaceId: seeded.me.spaceId } }),
      ]);
      expect(JSON.stringify({ seen, messages, events, effects })).not.toContain(password);
    } finally {
      runtime.mockRestore();
    }
  });

  it("moves a saved login to the site of the card answered last, with that card's value", async () => {
    const www = { name: "acme", origin: "https://www.acme.example.test", auth: { type: "login" } };
    const sites = {
      login: { ...www, origin: "https://login.acme.example.test" },
      other: { ...www, origin: "https://acme-insure.example.test" },
    };
    const runtime = vi
      .spyOn(ScriptedAgentRuntime.prototype, "run")
      .mockImplementation(async function* (request): AsyncIterable<AgentRuntimeEvent> {
        const credential = request.runId === runs.login.runId ? sites.login : sites.other;
        yield {
          type: "tool",
          name: "request_secret",
          args: { label: "Sign in", purpose: "password", credential, replace: true },
          executionId: `${request.runId}:0`,
        };
        yield { type: "done", text: "Done" };
      });
    const runs = {} as Record<keyof typeof sites, { runId: string; botId: string; card: string }>;
    try {
      const seeded = await seedRun("login-replace", "Sign in");
      const { userId, spaceId } = seeded.me;
      await rpc(seeded.cookie, "vault/put", {
        destination: www,
        value: JSON.stringify({ username: "fake-user", password: "fake-password-www" }),
      });
      const saved = await db.vaultCredential.findFirstOrThrow({ where: { userId } });
      // A second bot of the same member asks to replace the same login for another site.
      const bot = await rpc<{ id: string }>(seeded.cookie, "bots/create", {
        name: "Executor login-replace 2",
        title: "",
        description: "",
        instructions: "",
        notifyOnFinish: false,
      });
      const thread = await db.thread.findUniqueOrThrow({ where: { botId: bot.id } });
      const task = await db.task.create({
        data: {
          userId,
          spaceId,
          botId: bot.id,
          threadId: thread.id,
          prompt: "Sign in",
          status: "queued",
        },
      });
      const run = await db.run.create({
        data: {
          userId,
          spaceId,
          botId: bot.id,
          threadId: thread.id,
          taskId: task.id,
          trigger: "user",
          status: "queued",
        },
      });
      runs.login = { runId: seeded.run.id, botId: seeded.bot.id, card: "" };
      runs.other = { runId: run.id, botId: bot.id, card: "" };
      for (const site of ["login", "other"] as const) {
        await runAsSystem("background job run.continue", () =>
          handles.executor.continueRun(runs[site].runId, "test-worker"),
        );
        const message = await db.message.findFirstOrThrow({
          where: { runId: runs[site].runId, role: "bot" },
          orderBy: { seq: "desc" },
        });
        expect(message.blocks).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              credential: sites[site],
              replaces: { id: saved.id, origin: www.origin },
            }),
          ]),
        );
        runs[site].card = message.id;
      }
      expect(await db.vaultCredential.findMany({ where: { userId } })).toEqual([saved]);

      // Both answered at once, as the apps send them.
      const results = await Promise.all(
        (["login", "other"] as const).map(async (site) => {
          const response = await handles.app.request("/rpc/threads/answer", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              origin: "http://127.0.0.1:5173",
              cookie: seeded.cookie,
            },
            body: JSON.stringify({
              json: {
                botId: runs[site].botId,
                runId: runs[site].runId,
                messageId: runs[site].card,
                answer: "",
                fields: [
                  { label: "Username", value: "fake-user", hidden: false },
                  { label: "Password", value: `fake-password-${site}`, hidden: true },
                ],
              },
            }),
          });
          return response.status;
        }),
      );
      expect(results).toEqual([200, 200]);
      // One row, the same one, with the site and value of whichever card was saved last.
      const rows = await db.vaultCredential.findMany({ where: { userId } });
      expect(rows).toEqual([expect.objectContaining({ id: saved.id, name: www.name })]);
      const last = rows[0]!.origin === sites.login.origin ? "login" : "other";
      expect(rows[0]!.origin).toBe(sites[last].origin);
      const value = await new EncryptedSecretStore(resolveEncryptionKey()).load(
        rows[0]!.ciphertext,
        rows[0]!.id,
      );
      expect(value).toContain(`fake-password-${last}`);
      for (const other of ["www", last === "login" ? "other" : "login"]) {
        expect(value).not.toContain(`fake-password-${other}`);
      }
    } finally {
      runtime.mockRestore();
    }
  });

  async function seedRun(
    label: string,
    prompt: string,
    runState: {
      status?: string;
      leaseOwner?: string;
      leaseFence?: number;
      leaseExpiresAt?: Date;
      startedAt?: Date;
      completedAt?: Date;
    } = {},
  ) {
    const cookie = await signup(
      `executor-${label}-${stamp}@cortexai-agent-hub.test`,
      `Executor ${label}`,
    );
    const me = await rpc<{ userId: string; spaceId: string }>(cookie, "me");
    const bot = await rpc<{ id: string }>(cookie, "bots/create", {
      name: `Executor ${label}`,
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: false,
    });
    const thread = await db.thread.findUniqueOrThrow({ where: { botId: bot.id } });
    const task = await db.task.create({
      data: {
        spaceId: me.spaceId,
        botId: bot.id,
        threadId: thread.id,
        userId: me.userId,
        prompt,
        status: "queued",
      },
    });
    const run = await db.run.create({
      data: {
        spaceId: me.spaceId,
        botId: bot.id,
        threadId: thread.id,
        taskId: task.id,
        userId: me.userId,
        status: runState.status ?? "queued",
        trigger: "user",
        leaseOwner: runState.leaseOwner,
        leaseFence: runState.leaseFence,
        leaseExpiresAt: runState.leaseExpiresAt,
        startedAt: runState.startedAt,
        completedAt: runState.completedAt,
      },
    });
    return { cookie, me, bot, thread, task, run };
  }

  async function signup(email: string, name: string) {
    const response = await handles.app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://127.0.0.1:5173" },
      body: JSON.stringify({ email, password: "password12", name }),
    });
    expect(response.status).toBeLessThan(400);
    const raw = response.headers.get("set-cookie") ?? "";
    const match = raw.match(/better-auth\.session_token=([^;]+)/);
    expect(match?.[1]).toBeTruthy();
    return `better-auth.session_token=${match![1]}`;
  }

  async function rpc<T>(cookie: string, procedure: string, body: unknown = {}): Promise<T> {
    const response = await handles.app.request(`/rpc/${procedure}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://127.0.0.1:5173",
        cookie,
      },
      body: JSON.stringify({ json: body }),
    });
    const payload = (await response.json()) as { json?: T; error?: { message?: string } };
    if (!response.ok || payload.error) {
      throw new Error(payload.error?.message ?? `${procedure} failed (${response.status})`);
    }
    return discardBotIntroFromCreate(handles, cookie, procedure, payload.json as T);
  }
});
