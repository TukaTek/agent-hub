import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ComputerRef } from "@cortexai-agent-hub/adapter-kit";
import { ATTACHMENT_MAX_BYTES } from "@cortexai-agent-hub/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkpointComputerWorkspace,
  createSecretDownloadTarget,
  ensureComputerWorkspaceLayout,
  restoreComputerWorkspace,
} from "./computer-workspace.js";
import { FakeSandboxProvider } from "./fake-sandbox.js";
import { LocalAgentHomeStore } from "./home.js";

const context = {
  operationId: "workspace-test",
  traceId: "workspace-test",
  spaceId: "workspace",
  userId: "user",
  signal: new AbortController().signal,
};
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("provider-neutral computer workspace", () => {
  it("prepares shared and bot folders for a Team Computer", async () => {
    const provider = new FakeSandboxProvider();
    const computer = await provider.provision(
      { botId: "team-workspace", homePath: "/ignored" },
      context,
    );
    const execute = vi.spyOn(provider, "execute");

    await ensureComputerWorkspaceLayout(provider, computer, "team", "bot-1", context);

    expect(execute).toHaveBeenCalledWith(
      computer,
      { argv: ["mkdir", "-p", "shared", "bots/bot-1"] },
      context,
    );
  });

  it("restores a checkpoint into a replacement provider machine", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cortexai-agent-hub-workspace-store-"));
    roots.push(root);
    const home = new LocalAgentHomeStore(root);
    const firstProvider = new FakeSandboxProvider();
    const first = await firstProvider.provision({ botId: "bot-1", homePath: "/ignored" }, context);

    await firstProvider.writeFile(
      first,
      { path: "notes/result.txt", content: new TextEncoder().encode("portable") },
      context,
    );
    const revision = await checkpointComputerWorkspace(
      home,
      firstProvider,
      "bot-1",
      first,
      context,
    );

    const replacementProvider = new FakeSandboxProvider();
    const replacement = await replacementProvider.provision(
      { botId: "bot-1", homePath: "/different-provider" },
      context,
    );
    await restoreComputerWorkspace(home, replacementProvider, "bot-1", replacement, context);

    expect(revision).toMatch(/^rev-/);
    expect(
      new TextDecoder().decode(
        await replacementProvider.readFile(replacement, "notes/result.txt", context),
      ),
    ).toBe("portable");
  });
});

describe("secret download target", () => {
  async function localHome() {
    const root = await mkdtemp(path.join(tmpdir(), "cortexai-agent-hub-download-home-"));
    roots.push(root);
    return new LocalAgentHomeStore(root);
  }
  const dockerComputer = (botId: string): ComputerRef => ({
    id: `docker-${botId}`,
    botId,
    kind: "docker",
    providerRef: `docker-${botId}`,
    fresh: false,
  });

  it.each([
    ["dedicated", "downloads"],
    ["team", "bots/bot-1/downloads"],
  ] as const)(
    "streams a local Docker %s download straight into the mounted home at %s",
    async (scope, workspaceDirectory) => {
      const home = await localHome();
      const target = createSecretDownloadTarget(
        { home, sandbox: new FakeSandboxProvider() },
        { homeKey: "home-key-1" },
        dockerComputer("bot-1"),
        scope,
        "bot-1",
        context,
      );
      const directory = await target.directory();
      expect(directory).toBe(
        await realpath(path.join(home.pathFor("home-key-1"), workspaceDirectory)),
      );
      await writeFile(path.join(directory, "report.pdf"), "pdf");
      expect(await target.publish(path.join(directory, "report.pdf"), "report.pdf")).toBe(
        "downloads/report.pdf",
      );
      await target.dispose();
      expect(
        await readFile(
          path.join(home.pathFor("home-key-1"), workspaceDirectory, "report.pdf"),
          "utf8",
        ),
      ).toBe("pdf");
    },
  );

  it("caps local Docker downloads at the configured cap and other computers at 10 MiB", async () => {
    const provider = new FakeSandboxProvider();
    const remote = await provider.provision({ botId: "bot-1", homePath: "/ignored" }, context);
    const target = (computer: ComputerRef) =>
      createSecretDownloadTarget(
        { home: new LocalAgentHomeStore("/unused"), sandbox: provider },
        { homeKey: "home-key-1" },
        computer,
        "dedicated",
        "bot-1",
        context,
      ).maxBytes;
    expect(target(dockerComputer("bot-1"))).toBe(100 * 1024 * 1024);
    expect(target(remote)).toBe(ATTACHMENT_MAX_BYTES);
    vi.stubEnv("CORTEXAI_AGENT_HUB_SECRET_REQUEST_FILE_CAP_BYTES", "4096");
    try {
      expect(target(dockerComputer("bot-1"))).toBe(4096);
      expect(target(remote)).toBe(4096);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("uses only timestamped names when the downloads folder cannot be listed", async () => {
    const provider = new FakeSandboxProvider();
    const computer = await provider.provision({ botId: "bot-1", homePath: "/ignored" }, context);
    await provider.writeFile(
      computer,
      { path: "downloads/report.pdf", content: new TextEncoder().encode("old") },
      context,
    );
    vi.spyOn(provider, "listFiles").mockRejectedValueOnce(new Error("listing unavailable"));
    const target = createSecretDownloadTarget(
      { home: await localHome(), sandbox: provider },
      { homeKey: "home-key-1" },
      computer,
      "dedicated",
      "bot-1",
      context,
    );
    const staging = await target.directory();
    await writeFile(path.join(staging, "report.pdf"), "new");
    const published = await target.publish(path.join(staging, "report.pdf"), "report.pdf");
    await target.dispose();
    expect(published).toMatch(/^downloads\/report-\d+\.pdf$/);
    const read = (file: string) =>
      provider.readFile(computer, file, context).then((bytes) => new TextDecoder().decode(bytes));
    expect(await read("downloads/report.pdf")).toBe("old");
    expect(await read(published)).toBe("new");
  });

  it("refuses a downloads symlink that leaves the home", async () => {
    const home = await localHome();
    const outside = await mkdtemp(path.join(tmpdir(), "cortexai-agent-hub-outside-"));
    roots.push(outside);
    await mkdir(home.pathFor("home-key-1"), { recursive: true });
    await symlink(outside, path.join(home.pathFor("home-key-1"), "downloads"));
    const target = createSecretDownloadTarget(
      { home, sandbox: new FakeSandboxProvider() },
      { homeKey: "home-key-1" },
      dockerComputer("bot-1"),
      "dedicated",
      "bot-1",
      context,
    );
    await expect(target.directory()).rejects.toThrow();
  });

  it.each([
    ["dedicated", "downloads"],
    ["team", "bots/bot-1/downloads"],
  ] as const)(
    "publishes a remote %s download into the computer at %s without replacing files",
    async (scope, workspaceDirectory) => {
      const provider = new FakeSandboxProvider();
      const computer = await provider.provision({ botId: "bot-1", homePath: "/ignored" }, context);
      await provider.writeFile(
        computer,
        { path: `${workspaceDirectory}/report.pdf`, content: new TextEncoder().encode("old") },
        context,
      );
      const target = createSecretDownloadTarget(
        { home: await localHome(), sandbox: provider },
        { homeKey: "home-key-1" },
        computer,
        scope,
        "bot-1",
        context,
      );
      const staging = await target.directory();
      await writeFile(path.join(staging, "report.pdf"), "new");
      const published = await target.publish(path.join(staging, "report.pdf"), "report.pdf");
      expect(published).toMatch(/^downloads\/report-\d+\.pdf$/);
      const read = (file: string) =>
        provider
          .readFile(computer, `${workspaceDirectory}/${file}`, context)
          .then((bytes) => new TextDecoder().decode(bytes));
      expect(await read("report.pdf")).toBe("old");
      expect(await read(published.slice("downloads/".length))).toBe("new");
      await target.dispose();
      await expect(stat(staging)).rejects.toThrow();
    },
  );
});

describe("Team run checkpoints", () => {
  it("defers a remote export when another run prevents an exclusive checkpoint", async () => {
    const { checkpointRunComputerWorkspace } = await import("./computer-workspace.js");
    const exportWorkspace = vi.fn();
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    const deps = { sandbox: { exportWorkspace }, home: {}, prisma: { computer: { updateMany } } };
    const result = await checkpointRunComputerWorkspace(
      deps as never,
      { id: "team", homeKey: "team", scope: "team" },
      { id: "remote", providerRef: "remote", kind: "e2b", botId: "team" },
      { ...context, botId: "writer", screenLeaseId: "run-a:2" },
    );
    expect(result).toBeUndefined();
    expect(exportWorkspace).not.toHaveBeenCalled();
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          state: "running",
          executionLeases: {
            none: { expiresAt: { gt: expect.any(Date) }, NOT: { runId: "run-a", fence: 2 } },
          },
        }),
        data: expect.objectContaining({ state: "suspending" }),
      }),
    );
  });

  it("restores the running state when an exclusive remote export fails", async () => {
    const { checkpointRunComputerWorkspace } = await import("./computer-workspace.js");
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const exportWorkspace = vi.fn(async function* () {
      await Promise.reject(new Error("export failed"));
      yield { path: "unreachable", content: new Uint8Array() };
    });
    const deps = { sandbox: { exportWorkspace }, home: {}, prisma: { computer: { updateMany } } };
    await expect(
      checkpointRunComputerWorkspace(
        deps as never,
        { id: "team", homeKey: "team", scope: "team" },
        { id: "remote", providerRef: "remote", kind: "box", botId: "team" },
        { ...context, botId: "writer", screenLeaseId: "run-a:2" },
      ),
    ).rejects.toThrow("export failed");
    expect(updateMany.mock.invocationCallOrder[0]).toBeLessThan(
      exportWorkspace.mock.invocationCallOrder[0]!,
    );
    expect(updateMany).toHaveBeenLastCalledWith({
      where: { id: "team", providerRef: "remote", state: "suspending" },
      data: { state: "running" },
    });
  });
});
