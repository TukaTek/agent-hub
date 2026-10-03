import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ThreadSnapshot } from "@cortexai-agent-hub/contracts";
import type { PrismaClient } from "@cortexai-agent-hub/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BotIntroHarness } from "./discard-bot-intro.js";
import { discardBotIntroFromCreate } from "./discard-bot-intro.js";
import { provisionAndSignIn } from "./index.js";

type App = { request: (input: string, init?: RequestInit) => Promise<Response> };

process.env.WAKEUP_DRIVER = "memory";
process.env.SANDBOX_PROVIDER = "fake";
process.env.AGENT_RUNTIME = "scripted";

const hasDb = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const describeAttachments = hasDb ? describe : describe.skip;
let botIntroHarness: BotIntroHarness | undefined;

describeAttachments("chat attachments", () => {
  let app: App;
  let prisma: PrismaClient;
  let stop: () => Promise<void>;
  const stamp = Date.now();
  const dataDir = mkdtempSync(path.join(tmpdir(), "cortexai-agent-hub-attachments-"));
  const tinyPng = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );

  beforeAll(async () => {
    const { createApp } = await import("../../../apps/api/src/app.ts");
    const handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
    });
    app = handles.app;
    prisma = handles.prisma;
    stop = handles.stop;
    botIntroHarness = handles;
  });

  afterAll(async () => {
    await stop?.();
  });

  it("uploads, sends with image/file, and rejects invalid attachments", async () => {
    const cookie = await signInAs(
      { app, prisma },
      `attachments-${stamp}@cortexai-agent-hub.test`,
      "Attachment User",
    );
    const bot = await rpc<{ id: string }>(app, cookie, "bots/create", {
      name: "Attacher",
      title: "Attacher",
      description: "tests attachments",
      instructions: "",
      notifyOnFinish: true,
    });

    const image = await rpc<{ id: string; mimeType: string }>(app, cookie, "artifacts/create", {
      botId: bot.id,
      name: "pixel.png",
      mimeType: "image/png",
      contentBase64: tinyPng.toString("base64"),
    });
    const file = await rpc<{ id: string }>(app, cookie, "artifacts/create", {
      botId: bot.id,
      name: "notes.txt",
      mimeType: "text/plain",
      contentBase64: Buffer.from("hello attachment").toString("base64"),
    });

    await sendAndWait(app, cookie, bot.id, { text: "see this", artifactIds: [image.id] });
    let snapshot = await rpc<ThreadSnapshot>(app, cookie, "threads/get", { botId: bot.id });
    const imageMessage = snapshot.messages.find((message) =>
      message.blocks.some((block) => block.kind === "image"),
    );
    expect(imageMessage?.blocks).toEqual(
      expect.arrayContaining([
        { kind: "text", text: "see this" },
        expect.objectContaining({ kind: "image", artifactId: image.id, name: "pixel.png" }),
      ]),
    );

    await sendAndWait(app, cookie, bot.id, { artifactIds: [file.id] });
    snapshot = await rpc<ThreadSnapshot>(app, cookie, "threads/get", { botId: bot.id });
    const fileMessage = snapshot.messages.find((message) =>
      message.blocks.some((block) => block.kind === "file"),
    );
    expect(fileMessage?.blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "file", artifactId: file.id, name: "notes.txt" }),
      ]),
    );

    const fetched = await rpc<{ contentBase64: string }>(app, cookie, "artifacts/get", {
      botId: bot.id,
      artifactId: image.id,
    });
    expect(fetched.contentBase64).toBe(tinyPng.toString("base64"));

    for (const [name, mimeType] of [
      ["report.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
      ["brief.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
      ["deck.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
      ["bundle.zip", "application/zip"],
    ] as const) {
      const content = Buffer.from(`PK ${name}`).toString("base64");
      const office = await rpc<{ id: string; mimeType: string }>(app, cookie, "artifacts/create", {
        botId: bot.id,
        name,
        mimeType,
        contentBase64: content,
      });
      expect(office.mimeType).toBe(mimeType);
      const downloaded = await rpc<{ mimeType: string; contentBase64: string }>(
        app,
        cookie,
        "artifacts/get",
        { botId: bot.id, artifactId: office.id },
      );
      expect(downloaded).toMatchObject({ mimeType, contentBase64: content });
    }

    const badMime = await raw(app, cookie, "artifacts/create", {
      botId: bot.id,
      name: "macro.xlsm",
      mimeType: "application/vnd.ms-excel.sheet.macroEnabled.12",
      contentBase64: Buffer.from("PK").toString("base64"),
    });
    expect(badMime.status).toBeGreaterThanOrEqual(400);

    const oversize = await raw(app, cookie, "artifacts/create", {
      botId: bot.id,
      name: "big.bin",
      mimeType: "text/plain",
      contentBase64: Buffer.alloc(10 * 1024 * 1024 + 1, 1).toString("base64"),
    });
    expect(oversize.status).toBeGreaterThanOrEqual(400);
  });

  it("attaches a workspace file into the thread", async () => {
    const cookie = await signInAs(
      { app, prisma },
      `attach-thread-${stamp}@cortexai-agent-hub.test`,
      "Attach Thread User",
    );
    const bot = await rpc<{ id: string }>(app, cookie, "bots/create", {
      name: "Attacher",
      title: "Attacher",
      description: "tests attach_file",
      instructions: "",
      notifyOnFinish: true,
    });
    await sendAndWait(app, cookie, bot.id, {
      text: "write notes/result.txt and attach it to the thread",
    });
    const snapshot = await rpc<ThreadSnapshot>(app, cookie, "threads/get", { botId: bot.id });
    const fileMessage = snapshot.messages.find((message) =>
      message.blocks.some((block) => block.kind === "file"),
    );
    const fileBlock = fileMessage?.blocks.find((block) => block.kind === "file");
    expect(fileBlock).toMatchObject({ kind: "file", name: "result.txt" });
    if (fileBlock?.kind !== "file") throw new Error("expected file block");
    const fetched = await rpc<{ contentBase64: string }>(app, cookie, "artifacts/get", {
      botId: bot.id,
      artifactId: fileBlock.artifactId,
    });
    expect(Buffer.from(fetched.contentBase64, "base64").toString("utf8")).toContain(
      "write notes/result.txt and attach it to the thread",
    );
  });
});

/** Operator-provisions the account (signup is closed, CAAH-43) and signs it in. */
async function signInAs(handles: { app: App; prisma: PrismaClient }, email: string, name: string) {
  return provisionAndSignIn(handles, { email, name, password: "test-password-123" });
}

async function rpc<T>(app: App, cookie: string, proc: string, body: unknown = {}): Promise<T> {
  const res = await raw(app, cookie, proc, body);
  const text = await res.text();
  const parsed = JSON.parse(text) as { json?: T; error?: { message?: string } };
  if (res.status >= 400 || parsed.error) {
    throw new Error(`${proc} ${res.status}: ${parsed.error?.message ?? text}`);
  }
  return discardBotIntroFromCreate(botIntroHarness, cookie, proc, parsed.json as T);
}

async function raw(app: App, cookie: string, proc: string, body: unknown) {
  return app.request(`/rpc/${proc}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie,
      origin: "http://127.0.0.1:5173",
    },
    body: JSON.stringify({ json: body }),
  });
}

async function sendAndWait(
  app: App,
  cookie: string,
  botId: string,
  input: { text?: string; artifactIds?: string[] },
) {
  await rpc(app, cookie, "threads/send", { botId, ...input });
  await waitFor(
    app,
    cookie,
    botId,
    (snap) => !snap.run || ["completed", "failed", "cancelled"].includes(snap.run.status),
  );
}

async function waitFor(
  app: App,
  cookie: string,
  botId: string,
  pred: (snap: ThreadSnapshot) => boolean,
) {
  const start = Date.now();
  let last: ThreadSnapshot | null = null;
  while (Date.now() - start < 20_000) {
    last = await rpc<ThreadSnapshot>(app, cookie, "threads/get", { botId });
    if (pred(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timeout waiting for thread: ${JSON.stringify(last)}`);
}
