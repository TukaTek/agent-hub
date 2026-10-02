import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BotSecretDestination } from "@cortexai-agent-hub/contracts";
import { encodeLoginSecret } from "@cortexai-agent-hub/contracts";
import type { PrismaClient } from "@cortexai-agent-hub/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getFileDownloadCap,
  normalizeSecretDestination,
  requestWithBotSecret,
  resolveLoginFill,
  type SecretDownloadTarget,
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
    expect(await requestWithBotSecret(input)).toEqual({
      error:
        "Redirect not followed (HTTP 302 to api.example.test). Request the final URL directly.",
    });
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

  it("cancels a stalled response body", async () => {
    const { input, fetch } = await fixture();
    const controller = new AbortController();
    const cancel = vi.fn();
    fetch.mockResolvedValueOnce(new Response(new ReadableStream({ cancel })));
    const pending = requestWithBotSecret({ ...input, signal: controller.signal });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    controller.abort();
    expect(await pending).toEqual({ error: "Request was cancelled before it finished." });
    expect(cancel).toHaveBeenCalled();
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

  describe("file downloads", () => {
    const directories: string[] = [];
    afterEach(async () => {
      await Promise.all(
        directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
      );
    });
    async function downloadTarget(maxBytes = getFileDownloadCap()) {
      const directory = await mkdtemp(join(tmpdir(), "secret-downloads-"));
      directories.push(directory);
      const target: SecretDownloadTarget = {
        maxBytes,
        directory: async () => directory,
        publish: async (_hostPath, filename) => `downloads/${filename}`,
      };
      return { directory, target };
    }
    function fileResponse(body: BodyInit, headers: Record<string, string> = {}) {
      return new Response(body, {
        status: 200,
        headers: { "content-type": "application/pdf", ...headers },
      });
    }
    function streamOf(...chunks: Uint8Array[]) {
      return new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk);
          controller.close();
        },
      });
    }

    it("streams a binary response into the downloads folder and reports its metadata", async () => {
      const { input, fetch } = await fixture();
      const { directory, target } = await downloadTarget();
      const pdf = Buffer.from(`%PDF-1.4 fake PDF content ${"x".repeat(1_100_000)}`);
      fetch.mockResolvedValueOnce(
        fileResponse(pdf, { "content-disposition": 'attachment; filename="form.pdf"' }),
      );
      expect(await requestWithBotSecret({ ...input, downloads: target })).toEqual({
        file: {
          path: "downloads/form.pdf",
          filename: "form.pdf",
          size: pdf.length,
          contentType: "application/pdf",
          sha256: createHash("sha256").update(pdf).digest("hex"),
        },
      });
      expect(await readFile(join(directory, "form.pdf"))).toEqual(pdf);
      expect(await readdir(directory)).toEqual(["form.pdf"]);
    });

    it("saves non-text responses over 1 MB as files instead of inlining them", async () => {
      const { input, fetch } = await fixture();
      const { target } = await downloadTarget();
      const body = "x".repeat(1_100_000);
      fetch.mockResolvedValueOnce(
        fileResponse(body, { "content-type": "application/octet-stream" }),
      );
      expect(await requestWithBotSecret({ ...input, downloads: target })).toMatchObject({
        file: { size: body.length, contentType: "application/octet-stream" },
      });
    });

    it("rejects a declared size over the cap before streaming", async () => {
      vi.stubEnv("CORTEXAI_AGENT_HUB_SECRET_REQUEST_FILE_CAP_BYTES", String(10 * 1024 * 1024));
      const { input, fetch } = await fixture();
      const { directory, target } = await downloadTarget();
      const cancel = vi.fn();
      fetch.mockResolvedValueOnce(
        fileResponse(new ReadableStream({ cancel }), {
          "content-length": String(30 * 1024 * 1024),
        }),
      );
      expect(await requestWithBotSecret({ ...input, downloads: target })).toEqual({
        error:
          "Response size 31457280 bytes exceeds the 10485760 byte file download limit for this computer.",
      });
      expect(cancel).toHaveBeenCalled();
      expect(await readdir(directory)).toEqual([]);
    });

    it("stops a stream that grows past the cap and leaves no partial file", async () => {
      vi.stubEnv("CORTEXAI_AGENT_HUB_SECRET_REQUEST_FILE_CAP_BYTES", "1024");
      const { input, fetch } = await fixture();
      const { directory, target } = await downloadTarget();
      fetch.mockResolvedValueOnce(fileResponse(streamOf(new Uint8Array(800), new Uint8Array(800))));
      expect(await requestWithBotSecret({ ...input, downloads: target })).toEqual({
        error: "Response exceeds the 1024 byte file download limit for this computer.",
      });
      expect(await readdir(directory)).toEqual([]);
    });

    it("defaults to a 100 MB file cap", async () => {
      const { input, fetch } = await fixture();
      const { target } = await downloadTarget();
      fetch.mockResolvedValueOnce(
        fileResponse(new ReadableStream(), { "content-length": String(100 * 1024 * 1024 + 1) }),
      );
      expect(await requestWithBotSecret({ ...input, downloads: target })).toEqual({
        error:
          "Response size 104857601 bytes exceeds the 104857600 byte file download limit for this computer.",
      });
    });

    it("reports a connection that drops mid-download", async () => {
      const { input, fetch } = await fixture();
      const { directory, target } = await downloadTarget();
      fetch.mockResolvedValueOnce(
        fileResponse(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(10));
              controller.error(new Error(`socket closed ${secret}`));
            },
          }),
        ),
      );
      expect(await requestWithBotSecret({ ...input, downloads: target })).toEqual({
        error: "Network error: the connection closed mid-download.",
      });
      expect(await readdir(directory)).toEqual([]);
    });

    it("refuses file downloads without a bot workspace", async () => {
      const { input, fetch } = await fixture();
      const cancel = vi.fn();
      fetch.mockResolvedValueOnce(fileResponse(new ReadableStream({ cancel })));
      expect(await requestWithBotSecret(input)).toEqual({
        error:
          "File downloads require a bot workspace. Use text/JSON endpoints or request support.",
      });
      expect(cancel).toHaveBeenCalled();
    });

    it("reports a downloads folder that cannot be prepared", async () => {
      const { input, fetch } = await fixture();
      fetch.mockResolvedValueOnce(fileResponse("data"));
      const target: SecretDownloadTarget = {
        maxBytes: getFileDownloadCap(),
        directory: async () => {
          throw new Error(`EACCES ${secret}`);
        },
        publish: async () => "unused",
      };
      expect(await requestWithBotSecret({ ...input, downloads: target })).toEqual({
        error: "Could not prepare the downloads folder in the bot workspace.",
      });
    });

    it("reports a file the workspace refuses to accept", async () => {
      const { input, fetch } = await fixture();
      const { directory } = await downloadTarget();
      fetch.mockResolvedValueOnce(fileResponse("data"));
      const target: SecretDownloadTarget = {
        maxBytes: getFileDownloadCap(),
        directory: async () => directory,
        publish: async () => {
          throw new Error(`upload rejected ${secret}`);
        },
      };
      expect(await requestWithBotSecret({ ...input, downloads: target })).toEqual({
        error: "Could not save the downloaded file to the bot workspace.",
      });
    });

    it.each([
      ['filename="../../../etc/passwd"', "etcpasswd"],
      ['filename="/absolute/path.txt"', "absolutepath.txt"],
      ['filename=".hidden"', "hidden"],
      ['filename="pipe|.txt"', "pipe.txt"],
      ['filename="colon:slash/back\\\\danger.txt"', "colonslashbackdanger.txt"],
      ["filename*=UTF-8''..%2F..%2Fencoded.pdf", "encoded.pdf"],
    ])("keeps %s inside the downloads folder as %s", async (disposition, expected) => {
      const { input, fetch } = await fixture();
      const { directory, target } = await downloadTarget();
      fetch.mockResolvedValueOnce(
        fileResponse("safe", {
          "content-type": "application/octet-stream",
          "content-disposition": disposition,
        }),
      );
      expect(await requestWithBotSecret({ ...input, downloads: target })).toMatchObject({
        file: { path: `downloads/${expected}`, filename: expected },
      });
      expect(await readdir(directory)).toEqual([expected]);
    });

    it("honors the computer's own cap below the configured one", async () => {
      const { input, fetch } = await fixture();
      const { directory, target } = await downloadTarget(8);
      fetch.mockResolvedValueOnce(fileResponse("0123456789"));
      expect(await requestWithBotSecret({ ...input, downloads: target })).toEqual({
        error: "Response exceeds the 8 byte file download limit for this computer.",
      });
      expect(await readdir(directory)).toEqual([]);
    });

    it.each([
      ["/v1/forms/abc/pdf", "application/pdf", "pdf.pdf"],
      ["/v1/export", "image/png; charset=binary", "export.png"],
      ["/v1/report.PDF", "application/pdf", "report.PDF"],
      ["/v1/photo.jpeg", "image/jpeg", "photo.jpeg"],
      ["/v1/archive", "application/zip", "archive.zip"],
      ["/v1/blob", "application/octet-stream", "blob"],
    ])("names %s (%s) as %s", async (path, contentType, expected) => {
      const { input, fetch } = await fixture();
      const { directory, target } = await downloadTarget();
      fetch.mockResolvedValueOnce(fileResponse("bytes", { "content-type": contentType }));
      expect(
        await requestWithBotSecret({
          ...input,
          request: { ...input.request, url: `${destination.origin}${path}` },
          downloads: target,
        }),
      ).toMatchObject({ file: { path: `downloads/${expected}`, filename: expected } });
      expect(await readdir(directory)).toEqual([expected]);
    });

    it("never overwrites an existing download", async () => {
      const { input, fetch } = await fixture();
      const { directory, target } = await downloadTarget();
      const disposition = { "content-disposition": 'filename="report.pdf"' };
      fetch.mockResolvedValueOnce(fileResponse("first", disposition));
      fetch.mockResolvedValueOnce(fileResponse("second", disposition));
      const first = await requestWithBotSecret({ ...input, downloads: target });
      const second = await requestWithBotSecret({ ...input, downloads: target });
      expect(first).toMatchObject({ file: { filename: "report.pdf" } });
      expect(second).toMatchObject({
        file: { filename: expect.stringMatching(/^report-\d+\.pdf$/) },
      });
      const secondName = (second as { file: { filename: string } }).file.filename;
      expect(await readFile(join(directory, "report.pdf"), "utf8")).toBe("first");
      expect(await readFile(join(directory, secondName), "utf8")).toBe("second");
    });

    it("keeps the credential out of the saved filename and metadata", async () => {
      const { input, fetch } = await fixture();
      const { directory, target } = await downloadTarget();
      fetch.mockResolvedValueOnce(
        fileResponse("content", {
          "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(secret)}.pdf`,
        }),
      );
      const result = await requestWithBotSecret({ ...input, downloads: target });
      expect(result).toMatchObject({ file: { filename: "[REDACTED].pdf" } });
      expect(JSON.stringify(result)).not.toContain(secret);
      expect((await readdir(directory)).join()).not.toContain("fake-key");
    });
  });

  describe("failure messages", () => {
    it("reports a timeout with the configured duration", async () => {
      vi.stubEnv("CORTEXAI_AGENT_HUB_SECRET_REQUEST_TIMEOUT_MS", "50");
      const { input, fetch } = await fixture();
      fetch.mockImplementation(
        (_url, init) =>
          new Promise((_resolve, reject) =>
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
          ),
      );
      expect(await requestWithBotSecret(input)).toEqual({
        error: "Request timed out after 1 second.",
      });
    });

    it("defaults to a 120 second timeout", async () => {
      const timeout = vi.spyOn(AbortSignal, "timeout");
      try {
        const { input } = await fixture();
        await requestWithBotSecret(input);
        expect(timeout).toHaveBeenCalledWith(120_000);
      } finally {
        timeout.mockRestore();
      }
    });

    it("reports a cancelled run separately from a timeout", async () => {
      const { input, fetch } = await fixture();
      const controller = new AbortController();
      fetch.mockImplementation(
        (_url, init) =>
          new Promise((_resolve, reject) =>
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
          ),
      );
      const pending = requestWithBotSecret({ ...input, signal: controller.signal });
      await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
      controller.abort();
      expect(await pending).toEqual({ error: "Request was cancelled before it finished." });
    });

    it("reports redirects with the status and target host, redacted", async () => {
      const { input, fetch } = await fixture();
      fetch.mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: "https://redirect.example.test/target" },
        }),
      );
      expect(await requestWithBotSecret(input)).toEqual({
        error:
          "Redirect not followed (HTTP 302 to redirect.example.test). Request the final URL directly.",
      });
      fetch.mockResolvedValueOnce(
        new Response(null, {
          status: 301,
          headers: { location: `https://evil.example.test/${encodeURIComponent(secret)}` },
        }),
      );
      expect(await requestWithBotSecret(input)).toEqual({
        error:
          "Redirect not followed (HTTP 301 to evil.example.test). Request the final URL directly.",
      });
    });

    it("reports a destination blocked by network policy", async () => {
      const { input, fetch } = await fixture();
      input.remote.resolveHostname = async () => [{ address: "10.0.0.8", family: 4 }];
      expect(await requestWithBotSecret(input)).toEqual({
        error: "Destination is blocked by network policy.",
      });
      expect(fetch).not.toHaveBeenCalled();
    });

    it("reports DNS failures by hostname", async () => {
      const { input, fetch } = await fixture();
      input.remote.resolveHostname = async () => {
        throw Object.assign(new Error("getaddrinfo ENOTFOUND api.example.test"), {
          code: "ENOTFOUND",
        });
      };
      expect(await requestWithBotSecret(input)).toEqual({
        error: "DNS lookup failed for api.example.test. Check the destination hostname.",
      });
      expect(fetch).not.toHaveBeenCalled();
    });

    it.each(["connect ECONNREFUSED 203.0.113.10:443", "read ECONNRESET", "connect ETIMEDOUT"])(
      "reports the transport failure %s",
      async (detail) => {
        const { input, fetch } = await fixture();
        fetch.mockRejectedValueOnce(new TypeError("fetch failed", { cause: new Error(detail) }));
        expect(await requestWithBotSecret(input)).toEqual({
          error: `Network error: Could not reach api.example.test: ${detail}.`,
        });
      },
    );

    it("redacts the credential from transport failures", async () => {
      const { input, fetch } = await fixture();
      fetch.mockRejectedValueOnce(new TypeError("fetch failed", { cause: new Error(secret) }));
      const result = await requestWithBotSecret(input);
      expect(result).toEqual({
        error: "Network error: Could not reach api.example.test: [REDACTED].",
      });
    });

    it("reports non-2xx responses with a redacted snippet", async () => {
      const { input, fetch } = await fixture();
      fetch.mockResolvedValueOnce(new Response(`invalid token ${secret}`, { status: 401 }));
      expect(await requestWithBotSecret(input)).toEqual({
        error: "Request failed with HTTP 401: invalid token [REDACTED].",
      });
    });

    it.each([
      ["text/plain", "x".repeat(1_100_000)],
      ["application/json", JSON.stringify({ data: "x".repeat(1_100_000) })],
    ])("rejects %s bodies over the 1 MB inline limit", async (contentType, body) => {
      const { input, fetch } = await fixture();
      fetch.mockResolvedValueOnce(new Response(body, { headers: { "content-type": contentType } }));
      expect(await requestWithBotSecret(input)).toEqual({
        error: "Response body exceeds the 1000000 byte text limit.",
      });
    });

    it("names the invalid request field", async () => {
      const { input, fetch } = await fixture();
      expect(
        await requestWithBotSecret({ ...input, request: { name: destination.name, url: "nope" } }),
      ).toEqual({ error: expect.stringMatching(/^Invalid authenticated request — url: /) });
      expect(fetch).not.toHaveBeenCalled();
    });
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
      error: "Destination is blocked by network policy.",
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
