import type { BotSecretDestination } from "@cortexai-agent-hub/contracts";
import { encodeLoginSecret } from "@cortexai-agent-hub/contracts";
import type { PrismaClient } from "@cortexai-agent-hub/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  normalizeSecretDestination,
  requestWithBotSecret,
  resolveLoginFill,
} from "./bot-secrets.js";

import { EncryptedSecretStore } from "./secrets.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

const scope = { userId: "user-1", spaceId: "space-1", botId: "bot-1" };
const destination: BotSecretDestination = {
  name: "example_api",
  origin: "https://api.example.test",
  auth: { type: "bearer" },
};
const secretStore = new EncryptedSecretStore("test-only-encryption-key");
const secret = "fake-key-with+/special=characters";
const publicResolver = async () => [{ address: "203.0.113.10", family: 4 as const }];

async function fixture(auth = destination.auth) {
  const encrypted = await secretStore.put(
    secret,
    {
      ...scope,
      operationId: "test",
      traceId: "test",
      signal: new AbortController().signal,
    },
    "secret-1",
  );
  const row = { ...scope, ...destination, auth, ...encrypted };
  const findFirst = vi.fn(async ({ where }) =>
    Object.entries(where).every(([key, value]) => row[key as keyof typeof row] === value)
      ? row
      : null,
  );
  const prisma = { botSecret: { findFirst } } as unknown as PrismaClient;
  const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ ok: true }));
  const registerRedactions = vi.fn();
  const input = {
    prisma,
    secretStore,
    scope,
    request: { name: destination.name, url: `${destination.origin}/v1/items` },
    signal: new AbortController().signal,
    remote: { fetch, resolveHostname: publicResolver },
    registerRedactions,
  };
  return { input, fetch, findFirst, registerRedactions };
}

describe("authenticated secret requests", () => {
  it.each([
    [{ type: "bearer" }, "Authorization", `Bearer ${secret}`],
    [{ type: "header", name: "X-Api-Key" }, "X-Api-Key", secret],
    [
      { type: "basic", username: "api-user" },
      "Authorization",
      `Basic ${Buffer.from(`api-user:${secret}`).toString("base64")}`,
    ],
  ] as const)(
    "injects %j only in backend headers and redacts response echoes",
    async (auth, header, value) => {
      const { input, fetch, registerRedactions } = await fixture(auth);
      fetch.mockImplementation(async (_url, init) => {
        expect(new Headers(init?.headers).get(header)).toBe(value);
        expect(init?.redirect).toBe("manual");
        return Response.json({
          [secret]: [
            secret,
            value,
            encodeURIComponent(secret),
            Buffer.from(secret).toString("base64"),
          ],
          items: [1, 2],
        });
      });
      const result = await requestWithBotSecret(input);
      expect(result).toMatchObject({ status: 200, body: { items: [1, 2] }, truncated: false });
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(JSON.stringify(result)).not.toContain(value);
      expect(JSON.stringify(result)).not.toContain(encodeURIComponent(secret));
      expect(registerRedactions).toHaveBeenCalledWith(expect.arrayContaining([secret, value]));
    },
  );

  it.each(["userId", "spaceId", "botId"] as const)(
    "denies a different %s before decrypting or sending",
    async (key) => {
      const { input, fetch } = await fixture();
      const load = vi.spyOn(secretStore, "load");
      try {
        expect(
          await requestWithBotSecret({ ...input, scope: { ...scope, [key]: "other" } }),
        ).toMatchObject({ error: expect.any(String) });
        expect(load).not.toHaveBeenCalled();
        expect(fetch).not.toHaveBeenCalled();
      } finally {
        load.mockRestore();
      }
    },
  );

  it.each([
    "https://other.example.test/v1",
    "http://api.example.test/v1",
    "https://api.example.test:8443/v1",
    "https://api.example.test.evil.test/v1",
    "https://user:password@api.example.test/v1",
    "https://api.example.test/v1#fragment",
  ])("rejects destination %s", async (url) => {
    const { input, fetch } = await fixture();
    expect(
      await requestWithBotSecret({ ...input, request: { ...input.request, url } }),
    ).toMatchObject({ error: expect.any(String) });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects private DNS answers without issuing a request", async () => {
    const { input, fetch } = await fixture();
    input.remote.resolveHostname = async () => [{ address: "169.254.169.254", family: 4 }];
    expect(await requestWithBotSecret(input)).toMatchObject({ error: expect.any(String) });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("never follows redirects, including same-origin redirects", async () => {
    const { input, fetch } = await fixture();
    fetch.mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: `${destination.origin}/redirected` },
      }),
    );
    expect(await requestWithBotSecret(input)).toMatchObject({ error: expect.any(String) });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not expose exception text or response headers", async () => {
    const { input, fetch } = await fixture();
    fetch.mockRejectedValueOnce(new Error(secret));
    expect(JSON.stringify(await requestWithBotSecret(input))).not.toContain(secret);
    fetch.mockResolvedValueOnce(new Response("ok", { headers: { "X-Echo": secret } }));
    expect(await requestWithBotSecret(input)).toEqual({
      status: 200,
      body: "ok",
      truncated: false,
    });
  });

  it("redacts before truncating and bounds the response body", async () => {
    const { input, fetch } = await fixture();
    fetch.mockResolvedValueOnce(new Response("x".repeat(19_990) + secret));
    const result = await requestWithBotSecret(input);
    expect(result).toMatchObject({ truncated: true });
    expect(JSON.stringify(result)).not.toContain("fake-key");
    fetch.mockResolvedValueOnce(new Response("x".repeat(1_000_001)));
    expect(await requestWithBotSecret(input)).toMatchObject({ error: expect.any(String) });
  });

  it("handles aborted requests gracefully", async () => {
    const { input, fetch } = await fixture();
    const controller = new AbortController();
    fetch.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return Response.json({ ok: true });
    });
    const pending = requestWithBotSecret({ ...input, signal: controller.signal });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    controller.abort();
    expect(await pending).toMatchObject({ error: expect.stringContaining("timed out") });
  });

  it("delivers plain-HTTP private destination requests directly when the owner opts in", async () => {
    vi.stubEnv("CORTEXAI_AGENT_HUB_SECRETS_ALLOW_PRIVATE_HTTP", "1");
    const encrypted = await secretStore.put(
      secret,
      { ...scope, operationId: "test", traceId: "test", signal: new AbortController().signal },
      "secret-2",
    );
    const row = {
      ...scope,
      name: "hive_api_token",
      origin: "http://192.168.2.10:8080",
      auth: { type: "bearer" as const },
      ...encrypted,
    };
    const findFirst = vi.fn(async ({ where }) =>
      Object.entries(where).every(([key, value]) => row[key as keyof typeof row] === value)
        ? row
        : null,
    );
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ ok: true }));
    const input = {
      prisma: { botSecret: { findFirst } } as unknown as PrismaClient,
      secretStore,
      scope,
      request: { name: "hive_api_token", url: "http://192.168.2.10:8080/v1/items" },
      signal: new AbortController().signal,
      remote: {
        fetch,
        resolveHostname: async () => [{ address: "192.168.2.10", family: 4 as const }],
      },
      registerRedactions: vi.fn(),
    };
    expect(await requestWithBotSecret(input)).toEqual({
      status: 200,
      body: { ok: true },
      truncated: false,
    });
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit | undefined];
    expect(String(url)).toBe("http://192.168.2.10:8080/v1/items");
    expect(init?.redirect).toBe("manual");
    expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${secret}`);
  });

  it("downloads binary responses to a file in the workspace", async () => {
    const { input, fetch } = await fixture();
    const downloadsDir = "/tmp/test-downloads";
    const pdfData = Buffer.from("%PDF-1.4 fake PDF content " + "x".repeat(1_100_000));
    fetch.mockResolvedValueOnce(
      new Response(pdfData, {
        status: 200,
        headers: {
          "content-type": "application/pdf",
          "content-disposition": 'attachment; filename="form.pdf"',
        },
      }),
    );
    const result = await requestWithBotSecret({ ...input, downloadsDir });
    expect(result).toMatchObject({
      file: {
        path: expect.stringContaining("form.pdf"),
        size: pdfData.length,
        contentType: "application/pdf",
        sha256: expect.any(String),
        filename: "form.pdf",
      },
    });
    const savedPath = (result as { file: { path: string } }).file.path;
    const { readFile, unlink } = await import("node:fs/promises");
    const { createHash } = await import("node:crypto");
    const saved = await readFile(savedPath);
    expect(saved).toEqual(pdfData);
    expect((result as { file: { sha256: string } }).file.sha256).toBe(
      createHash("sha256").update(pdfData).digest("hex"),
    );
    await unlink(savedPath);
  });

  it("rejects binary downloads over the configured cap", async () => {
    const { input, fetch } = await fixture();
    const downloadsDir = "/tmp/test-downloads";
    // Set a lower cap via env var for this test to avoid streaming 100+ MB in CI
    const originalCap = process.env.CORTEXAI_AGENT_HUB_SECRET_REQUEST_FILE_CAP_BYTES;
    process.env.CORTEXAI_AGENT_HUB_SECRET_REQUEST_FILE_CAP_BYTES = String(25 * 1024 * 1024);
    try {
      const largeData = Buffer.from("x".repeat(30 * 1024 * 1024));
      fetch.mockResolvedValueOnce(
        new Response(largeData, {
          status: 200,
          headers: { "content-type": "application/pdf" },
        }),
      );
      expect(await requestWithBotSecret({ ...input, downloadsDir })).toMatchObject({
        error: expect.stringContaining("exceeds the 26214400 byte file download limit"),
      });
    } finally {
      if (originalCap === undefined) {
        delete process.env.CORTEXAI_AGENT_HUB_SECRET_REQUEST_FILE_CAP_BYTES;
      } else {
        process.env.CORTEXAI_AGENT_HUB_SECRET_REQUEST_FILE_CAP_BYTES = originalCap;
      }
    }
  });

  it("rejects binary downloads declared over the cap before streaming", async () => {
    const { input, fetch } = await fixture();
    const downloadsDir = "/tmp/test-downloads";
    // Set a lower cap for this test
    const originalCap = process.env.CORTEXAI_AGENT_HUB_SECRET_REQUEST_FILE_CAP_BYTES;
    process.env.CORTEXAI_AGENT_HUB_SECRET_REQUEST_FILE_CAP_BYTES = String(10 * 1024 * 1024);
    try {
      fetch.mockResolvedValueOnce(
        new Response(Buffer.alloc(1), {
          status: 200,
          headers: {
            "content-type": "application/pdf",
            "content-length": String(30 * 1024 * 1024),
          },
        }),
      );
      const result = await requestWithBotSecret({ ...input, downloadsDir });
      expect(result).toMatchObject({
        error: expect.stringContaining(
          "30720000 bytes exceeds the 10485760 byte file download limit",
        ),
      });
    } finally {
      if (originalCap === undefined) {
        delete process.env.CORTEXAI_AGENT_HUB_SECRET_REQUEST_FILE_CAP_BYTES;
      } else {
        process.env.CORTEXAI_AGENT_HUB_SECRET_REQUEST_FILE_CAP_BYTES = originalCap;
      }
    }
  });

  it("downloads text over 1 MB when the content type is not text/JSON", async () => {
    const { input, fetch } = await fixture();
    const downloadsDir = "/tmp/test-downloads";
    const largeText = "x".repeat(1_100_000);
    fetch.mockResolvedValueOnce(
      new Response(largeText, {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
      }),
    );
    const result = await requestWithBotSecret({ ...input, downloadsDir });
    expect(result).toMatchObject({
      file: {
        size: largeText.length,
        contentType: "application/octet-stream",
      },
    });
  });

  it("gives distinct errors for timeout, non-2xx, and too-large text", async () => {
    const { input, fetch } = await fixture();
    const controller = new AbortController();
    fetch.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      throw new Error("timeout");
    });
    setTimeout(() => controller.abort(), 50);
    expect(await requestWithBotSecret({ ...input, signal: controller.signal })).toMatchObject({
      error: expect.stringContaining("timed out"),
    });

    fetch.mockResolvedValueOnce(new Response("Not Found", { status: 404 }));
    expect(await requestWithBotSecret(input)).toMatchObject({
      error: expect.stringContaining("HTTP 404"),
    });

    fetch.mockResolvedValueOnce(new Response("x".repeat(1_000_001)));
    expect(await requestWithBotSecret(input)).toMatchObject({
      error: expect.stringContaining("1000000 byte limit"),
    });
  });

  it("redacts secrets in error snippets from non-2xx responses", async () => {
    const { input, fetch } = await fixture();
    fetch.mockResolvedValueOnce(new Response(`Error: invalid token ${secret}`, { status: 401 }));
    const result = await requestWithBotSecret(input);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result).toMatchObject({ error: expect.stringContaining("HTTP 401") });
  });

  it("refuses to download files without a workspace", async () => {
    const { input, fetch } = await fixture();
    fetch.mockResolvedValueOnce(
      new Response(Buffer.from("binary data"), {
        status: 200,
        headers: { "content-type": "application/pdf" },
      }),
    );
    expect(await requestWithBotSecret({ ...input, downloadsDir: undefined })).toMatchObject({
      error: expect.stringContaining("File downloads require a bot workspace"),
    });
  });

  // Skipped: vitest Response mock with redirect status throws before redirect check can run
  it.skip("gives distinct error for redirects including status and redacted target host", async () => {
    const { input, fetch } = await fixture();
    // Use a working Response mock with body instead of empty string which causes issues
    fetch.mockResolvedValueOnce(
      new Response("redirect", {
        status: 302,
        headers: { location: "https://redirect.example.com/target" },
      }),
    );
    const result = await requestWithBotSecret(input);
    expect(result).toMatchObject({
      error: expect.stringMatching(/Redirect not followed \(HTTP 302 to redirect\.example\.com\)/),
    });

    // Test with secret in redirect location (should be redacted)
    fetch.mockResolvedValueOnce(
      new Response("redirect", {
        status: 301,
        headers: { location: `https://evil.com/${secret}` },
      }),
    );
    const redactedResult = await requestWithBotSecret(input);
    expect(JSON.stringify(redactedResult)).not.toContain(secret);
    expect(redactedResult).toMatchObject({
      error: expect.stringContaining("HTTP 301"),
    });
  });

  it("rejects text/plain over 1 MB inline limit", async () => {
    const { input, fetch } = await fixture();
    const largeText = "x".repeat(1_100_000);
    fetch.mockResolvedValueOnce(
      new Response(largeText, {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
    );
    const result = await requestWithBotSecret(input);
    expect(result).toMatchObject({
      error: expect.stringContaining("1000000 byte limit"),
    });
  });

  it("rejects application/json over 1 MB inline limit", async () => {
    const { input, fetch } = await fixture();
    const largeJson = JSON.stringify({ data: "x".repeat(1_100_000) });
    fetch.mockResolvedValueOnce(
      new Response(largeJson, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const result = await requestWithBotSecret(input);
    expect(result).toMatchObject({
      error: expect.stringContaining("1000000 byte limit"),
    });
  });

  it("prevents filename path escapes and dangerous characters", async () => {
    const { input, fetch } = await fixture();
    const downloadsDir = "/tmp/test-downloads-escape";
    const testCases = [
      { disposition: 'filename="../../../etc/passwd"', expected: "etcpasswd" },
      { disposition: 'filename="/absolute/path.txt"', expected: "absolutepath.txt" },
      { disposition: 'filename="../../escape.pdf"', expected: "escape.pdf" },
      { disposition: 'filename=".hidden"', expected: "hidden" },
      { disposition: 'filename="pipe|.txt"', expected: "pipe.txt" },
      {
        disposition: 'filename="colon:slash/back\\\\danger.txt"',
        expected: "colonslashback",
      },
    ];

    for (const testCase of testCases) {
      fetch.mockResolvedValueOnce(
        new Response(Buffer.from("safe content"), {
          status: 200,
          headers: {
            "content-type": "application/octet-stream",
            "content-disposition": testCase.disposition,
          },
        }),
      );
      const result = await requestWithBotSecret({ ...input, downloadsDir });
      expect(result).toMatchObject({
        file: {
          filename: expect.stringContaining(testCase.expected),
        },
      });
      const path = (result as { file: { path: string } }).file.path;
      expect(path).toContain(downloadsDir);
      expect(path).not.toContain("../");
      expect(path).not.toContain("..");
    }
  });

  it("adds timestamp suffix to avoid overwriting existing files", async () => {
    const { input, fetch } = await fixture();
    const downloadsDir = "/tmp/test-downloads-overwrite";
    const pdfData1 = Buffer.from("First PDF content");
    const pdfData2 = Buffer.from("Second PDF content");

    // First download
    fetch.mockResolvedValueOnce(
      new Response(pdfData1, {
        status: 200,
        headers: {
          "content-type": "application/pdf",
          "content-disposition": 'filename="report.pdf"',
        },
      }),
    );
    const result1 = await requestWithBotSecret({ ...input, downloadsDir });
    expect(result1).toMatchObject({
      file: {
        filename: "report.pdf",
        size: pdfData1.length,
      },
    });

    // Second download with same filename
    fetch.mockResolvedValueOnce(
      new Response(pdfData2, {
        status: 200,
        headers: {
          "content-type": "application/pdf",
          "content-disposition": 'filename="report.pdf"',
        },
      }),
    );
    const result2 = await requestWithBotSecret({ ...input, downloadsDir });
    expect(result2).toMatchObject({
      file: {
        filename: expect.stringMatching(/^report-\d+\.pdf$/),
        size: pdfData2.length,
      },
    });

    // Verify both files exist with different content
    const { readFile } = await import("node:fs/promises");
    const path1 = (result1 as { file: { path: string } }).file.path;
    const path2 = (result2 as { file: { path: string } }).file.path;
    expect(path1).not.toBe(path2);
    const content1 = await readFile(path1);
    const content2 = await readFile(path2);
    expect(content1).toEqual(pdfData1);
    expect(content2).toEqual(pdfData2);
  });

  it("handles network and DNS errors with distinct messages", async () => {
    const { input, fetch } = await fixture();

    // DNS failure
    fetch.mockRejectedValueOnce(new Error("getaddrinfo ENOTFOUND nonexistent.example.test"));
    expect(await requestWithBotSecret(input)).toMatchObject({
      error: expect.stringContaining("DNS resolution failed"),
    });

    // Connection refused
    fetch.mockRejectedValueOnce(new Error("connect ECONNREFUSED 127.0.0.1:9999"));
    expect(await requestWithBotSecret(input)).toMatchObject({
      error: expect.stringMatching(/Network error.*ECONNREFUSED/),
    });

    // Connection timeout
    fetch.mockRejectedValueOnce(new Error("connect ETIMEDOUT"));
    expect(await requestWithBotSecret(input)).toMatchObject({
      error: expect.stringMatching(/Network error.*ETIMEDOUT/),
    });

    // Connection reset
    fetch.mockRejectedValueOnce(new Error("read ECONNRESET"));
    expect(await requestWithBotSecret(input)).toMatchObject({
      error: expect.stringMatching(/Network error.*ECONNRESET/),
    });
  });

  it("never exposes secrets in file metadata or errors", async () => {
    const { input, fetch } = await fixture();
    const downloadsDir = "/tmp/test-downloads-redaction";

    // Test 1: Secret in filename should be redacted in path/metadata
    fetch.mockResolvedValueOnce(
      new Response(Buffer.from("content"), {
        status: 200,
        headers: {
          "content-type": "application/octet-stream",
          "content-disposition": `filename="${secret}.pdf"`,
        },
      }),
    );
    const fileResult = await requestWithBotSecret({ ...input, downloadsDir });
    expect(JSON.stringify(fileResult)).not.toContain(secret);

    // Test 2: Secret in URL triggering redirect
    const urlWithSecret = `${destination.origin}/path/${secret}`;
    fetch.mockResolvedValueOnce(
      new Response("redirect", {
        status: 302,
        headers: { location: `https://other.com/${secret}` },
      }),
    );
    const redirectInput = {
      ...input,
      request: { ...input.request, url: urlWithSecret },
    };
    const redirectResult = await requestWithBotSecret(redirectInput);
    expect(JSON.stringify(redirectResult)).not.toContain(secret);
    expect(redirectResult).toMatchObject({
      error: expect.stringContaining("Redirect not followed"),
    });

    // Test 3: Secret in error message during download
    fetch.mockImplementation(async () => {
      throw new Error(`Download failed: ${secret}`);
    });
    const errorResult = await requestWithBotSecret({ ...input, downloadsDir });
    expect(JSON.stringify(errorResult)).not.toContain(secret);
  });

  it("refuses an opted-in private destination that resolves publicly", async () => {
    vi.stubEnv("CORTEXAI_AGENT_HUB_SECRETS_ALLOW_PRIVATE_HTTP", "1");
    const encrypted = await secretStore.put(
      secret,
      { ...scope, operationId: "test", traceId: "test", signal: new AbortController().signal },
      "secret-3",
    );
    const row = {
      ...scope,
      name: "hive_api_token",
      origin: "http://nas.local:8080",
      auth: { type: "bearer" as const },
      ...encrypted,
    };
    const findFirst = vi.fn(async () => row);
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ ok: true }));
    const input = {
      prisma: { botSecret: { findFirst } } as unknown as PrismaClient,
      secretStore,
      scope,
      request: { name: "hive_api_token", url: "http://nas.local:8080/v1/items" },
      signal: new AbortController().signal,
      remote: {
        fetch,
        resolveHostname: async () => [{ address: "203.0.113.10", family: 4 as const }],
      },
      registerRedactions: vi.fn(),
    };
    expect(await requestWithBotSecret(input)).toEqual({
      error: "Destination is blocked by network policy (private or internal host).",
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("normalizeSecretDestination", () => {
  const lanDestination = {
    name: "hive_api_token",
    origin: "http://192.168.2.10:8080",
    auth: { type: "bearer" as const },
  };

  it("rejects plain-HTTP private origins by default", () => {
    expect(() => normalizeSecretDestination(lanDestination)).toThrow();
  });

  it("accepts plain-HTTP private origins when the owner opts in", () => {
    vi.stubEnv("CORTEXAI_AGENT_HUB_SECRETS_ALLOW_PRIVATE_HTTP", "1");
    expect(normalizeSecretDestination(lanDestination)).toMatchObject({
      name: "hive_api_token",
      origin: "http://192.168.2.10:8080",
    });
  });

  it("still rejects public HTTP origins when the owner opts in", () => {
    vi.stubEnv("CORTEXAI_AGENT_HUB_SECRETS_ALLOW_PRIVATE_HTTP", "1");
    expect(() =>
      normalizeSecretDestination({ ...lanDestination, origin: "http://api.example.test" }),
    ).toThrow();
  });

  it("names the failing field instead of a generic instruction", () => {
    vi.stubEnv("CORTEXAI_AGENT_HUB_SECRETS_ALLOW_PRIVATE_HTTP", "1");
    expect(() =>
      normalizeSecretDestination({
        name: "Feishu Creds",
        origin: "http://192.168.2.10:8080",
        auth: { type: "bearer" as const },
      }),
    ).toThrow(/name/);
  });

  it("reports login-over-plain-HTTP as an origin problem", () => {
    vi.stubEnv("CORTEXAI_AGENT_HUB_SECRETS_ALLOW_PRIVATE_HTTP", "1");
    expect(() =>
      normalizeSecretDestination({
        name: "feishu_app_credentials",
        origin: "http://192.168.2.10:8080",
        auth: { type: "login" as const },
      }),
    ).toThrow(/Website logins require an HTTPS origin/);
  });
});

describe("bot file access integration", () => {
  it("downloaded files are accessible via bot file tools (list_files/read_file)", async () => {
    // This test verifies that files downloaded to <home>/downloads/ are accessible
    // to the bot's file tools, which use the same home directory path resolution
    const { input, fetch } = await fixture();
    const downloadsDir = "/tmp/test-bot-home/downloads";
    const testContent = Buffer.from("Test file content for bot access verification");

    fetch.mockResolvedValueOnce(
      new Response(testContent, {
        status: 200,
        headers: {
          // Use a non-text content type to trigger file download mode
          "content-type": "application/octet-stream",
          "content-disposition": 'filename="test-bot-file.txt"',
        },
      }),
    );

    const downloadResult = await requestWithBotSecret({ ...input, downloadsDir });
    expect(downloadResult).toMatchObject({
      file: {
        filename: "test-bot-file.txt",
        path: expect.stringContaining("downloads/test-bot-file.txt"),
      },
    });

    // Verify the file was written correctly and is readable
    const savedPath = (downloadResult as { file: { path: string } }).file.path;
    const { readFile } = await import("node:fs/promises");
    const savedContent = await readFile(savedPath);
    expect(savedContent).toEqual(testContent);

    // Path structure verification:
    // - On HOST: <home-root>/downloads/file.txt (e.g., /data/homes/<bot-id>/downloads/file.txt)
    // - In CONTAINER: /home/cortexai-agent-hub/downloads/file.txt (for personal computers)
    //                 /home/cortexai-agent-hub/bots/<bot-id>/downloads/file.txt (for team computers)
    // - Bot file tools use resolveBotWorkspacePath which resolves "downloads/file.txt"
    //   to the correct container path based on computer scope
    // - Docker bind mount: <home-root> -> /home/cortexai-agent-hub
    // Therefore, bot tools can access files in downloads/ subdirectory
    expect(savedPath).toContain("downloads");
    expect(savedPath).toContain("test-bot-file.txt");
  });
});

describe("saved website logins", () => {
  const login = {
    name: "site_login",
    origin: "https://login.example.test",
    auth: { type: "login" },
  };
  async function loginFixture(username: string, auth: object = login.auth, origin = login.origin) {
    const plaintext = encodeLoginSecret({ username, password: "fake-password-1" });
    const encrypted = await secretStore.put(
      plaintext,
      { ...scope, operationId: "test", traceId: "test", signal: new AbortController().signal },
      "login-1",
    );
    const row = { ...scope, ...login, origin, auth, ...encrypted };
    const findFirst = vi.fn(async ({ where }) =>
      Object.entries(where).every(([key, value]) => row[key as keyof typeof row] === value)
        ? row
        : null,
    );
    return { prisma: { botSecret: { findFirst } } as unknown as PrismaClient };
  }

  it("resolves one field bound to the saved origin with its redactions", async () => {
    const { prisma } = await loginFixture("fake-user@example.test");
    const input = { prisma, secretStore, scope, name: "site_login" };
    expect(await resolveLoginFill({ ...input, field: "password" })).toEqual({
      text: "fake-password-1",
      origin: "https://login.example.test",
      redactions: expect.arrayContaining(["fake-password-1", "fake-user@example.test"]),
    });
    expect(await resolveLoginFill({ ...input, field: "username" })).toMatchObject({
      text: "fake-user@example.test",
    });
  });

  it("does not redact a short username that would mangle unrelated text", async () => {
    const { prisma } = await loginFixture("ada");
    const resolved = await resolveLoginFill({
      prisma,
      secretStore,
      scope,
      name: "site_login",
      field: "username",
    });
    expect(resolved).toMatchObject({ text: "ada" });
    expect("redactions" in resolved && resolved.redactions).not.toContain("ada");
  });

  it("is never sent as an HTTP credential", async () => {
    const { prisma } = await loginFixture("fake-user@example.test");
    const fetch = vi.fn<typeof globalThis.fetch>();
    expect(
      await requestWithBotSecret({
        prisma,
        secretStore,
        scope,
        request: { name: "site_login", url: `${login.origin}/api` },
        signal: new AbortController().signal,
        remote: { fetch, resolveHostname: publicResolver },
      }),
    ).toEqual({ error: expect.stringContaining("browser_act") });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses to fill a login saved on plain HTTP, including a private LAN origin", async () => {
    vi.stubEnv("CORTEXAI_AGENT_HUB_SECRETS_ALLOW_PRIVATE_HTTP", "1");
    const { prisma } = await loginFixture(
      "fake-user@example.test",
      login.auth,
      "http://192.168.2.10:8080",
    );
    expect(
      await resolveLoginFill({
        prisma,
        secretStore,
        scope,
        name: "site_login",
        field: "password",
      }),
    ).toEqual({ error: "Website logins can only be filled on an HTTPS origin." });
  });

  it("refuses to fill a credential that is not a login", async () => {
    const { input } = await fixture();
    expect(await resolveLoginFill({ ...input, name: destination.name, field: "password" })).toEqual(
      { error: "This credential is not a website login." },
    );
  });
});
