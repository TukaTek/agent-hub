import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createLoginHintStore,
  DISCOVERY_MESSAGES,
  DISCOVERY_PATH,
  discoverOrganization,
  discoveryReply,
  LOGIN_HINT_TTL_MS,
  validateDiscoveredOrigin,
} from "./org-discovery.js";

const HUB = "https://hub.cortexai.example";
const EMAIL = "synthetic.person.7f3a@acme.example";

interface Fixture {
  status: number;
  headers?: Record<string, string>;
  body: unknown;
}
const contract = JSON.parse(
  readFileSync(path.join(import.meta.dirname, "fixtures/agent-hub-discovery.v1.json"), "utf8"),
) as { contractVersion: number; endpoint: { path: string }; fixtures: Record<string, Fixture> };
const fixtures = contract.fixtures;

function reply(fixture: Fixture) {
  return new Response(JSON.stringify(fixture.body), {
    status: fixture.status,
    headers: { "content-type": "application/json", ...fixture.headers },
  });
}

function found(origin: string) {
  const base = fixtures.found_entra!.body as Record<string, unknown>;
  return reply({
    status: 200,
    body: { ...base, agentHub: { ...(base.agentHub as object), origin } },
  });
}

function discover(response: Response | (() => Promise<Response>), hubUrl: string | null = HUB) {
  const fetcher = vi.fn(typeof response === "function" ? response : async () => response);
  return {
    fetcher,
    outcome: discoverOrganization(EMAIL, { hubUrl, fetch: fetcher as unknown as typeof fetch }),
  };
}

describe("org discovery contract", () => {
  it("targets the vendored contract's endpoint", () => {
    expect(contract.contractVersion).toBe(1);
    expect(DISCOVERY_PATH).toBe(contract.endpoint.path);
  });

  it("posts the email as a desktop client, unauthenticated, without following redirects", async () => {
    const { fetcher, outcome } = discover(reply(fixtures.not_found!));
    await outcome;
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as unknown as [URL | string, RequestInit];
    expect(String(url)).toBe(`${HUB}${DISCOVERY_PATH}`);
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    expect(init.cache).toBe("no-store");
    expect(init.credentials).toBe("omit");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(init.body))).toEqual({ email: EMAIL, client: "desktop" });
    const headers = new Headers(init.headers);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.has("authorization")).toBe(false);
  });

  it("parses every vendored fixture", async () => {
    const expected: Record<string, unknown> = {
      found_entra: {
        kind: "found",
        origin: "https://hub.acme.example",
        method: "entra",
        loginHint: "alice@acme.example",
      },
      found_native: {
        kind: "found",
        origin: "https://hub.beta.example",
        method: "native",
        loginHint: "bob@beta.example",
      },
      not_found: { kind: "not_found" },
      unsupported_email: { kind: "unsupported_email" },
      invalid_request: { kind: "invalid_email" },
      rate_limited: { kind: "rate_limited", retryAfterSeconds: 60 },
      server_error: { kind: "unavailable" },
    };
    expect(Object.keys(fixtures).sort()).toEqual(Object.keys(expected).sort());
    for (const [name, fixture] of Object.entries(fixtures)) {
      expect(await discover(reply(fixture)).outcome, name).toEqual(expected[name]);
    }
  });
});

describe("org discovery outcomes", () => {
  it("returns the discovered origin and login hint", async () => {
    expect(await discover(reply(fixtures.found_entra!)).outcome).toMatchObject({
      kind: "found",
      origin: "https://hub.acme.example",
      loginHint: "alice@acme.example",
    });
  });

  it("answers not_found with the neutral message", async () => {
    const outcome = await discover(reply(fixtures.not_found!)).outcome;
    expect(outcome).toEqual({ kind: "not_found" });
    expect(discoveryReply(outcome)).toEqual({
      ok: false,
      error: "We couldn't find an Agent Hub for that email. Check with your admin.",
    });
  });

  it("treats an unknown result exactly like not_found", async () => {
    const body = { ...(fixtures.not_found!.body as object), result: "suspended" };
    expect(await discover(reply({ status: 200, body })).outcome).toEqual({ kind: "not_found" });
  });

  it("asks for a work address on unsupported_email", async () => {
    const outcome = await discover(reply(fixtures.unsupported_email!)).outcome;
    expect(discoveryReply(outcome)).toEqual({ ok: false, error: "Use your work email address." });
  });

  it("reports invalid_request as an invalid email on the field", async () => {
    const outcome = await discover(reply(fixtures.invalid_request!)).outcome;
    expect(discoveryReply(outcome)).toEqual({
      ok: false,
      field: "email",
      error: DISCOVERY_MESSAGES.invalid_email,
    });
  });

  it("rejects an obviously invalid email without a network call", async () => {
    const fetcher = vi.fn();
    for (const email of [
      "",
      "   ",
      "no-at-sign",
      "a@",
      "@b",
      "a b@c.d",
      `${"x".repeat(320)}@a.b`,
    ]) {
      expect(
        await discoverOrganization(email, { hubUrl: HUB, fetch: fetcher as typeof fetch }),
      ).toEqual({ kind: "invalid_email" });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("honors Retry-After on 429 and disables retry until then", async () => {
    const outcome = await discover(reply(fixtures.rate_limited!)).outcome;
    expect(outcome).toEqual({ kind: "rate_limited", retryAfterSeconds: 60 });
    expect(discoveryReply(outcome)).toEqual({
      ok: false,
      error: "Too many attempts. Try again in 60 seconds.",
      retryAfterSeconds: 60,
    });
  });

  it("falls back to a bounded wait when Retry-After is missing or absurd", async () => {
    const limited = (retryAfter?: string) =>
      reply({
        status: 429,
        body: {},
        ...(retryAfter === undefined ? {} : { headers: { "Retry-After": retryAfter } }),
      });
    expect(await discover(limited()).outcome).toEqual({
      kind: "rate_limited",
      retryAfterSeconds: 60,
    });
    expect(await discover(limited("soon")).outcome).toEqual({
      kind: "rate_limited",
      retryAfterSeconds: 60,
    });
    expect(await discover(limited("999999")).outcome).toEqual({
      kind: "rate_limited",
      retryAfterSeconds: 3600,
    });
    expect(await discover(limited("0")).outcome).toEqual({
      kind: "rate_limited",
      retryAfterSeconds: 1,
    });
  });

  it.each([500, 502, 503, 504, 404, 401, 302])("treats HTTP %i as retryable", async (status) => {
    const outcome = await discover(reply({ status, body: { error: "server_error" } })).outcome;
    expect(outcome).toEqual({ kind: "unavailable" });
    expect(discoveryReply(outcome)).toEqual({
      ok: false,
      error: "Can't reach the sign-in service. Try again.",
    });
  });

  it("treats a network error, timeout, or refused redirect as retryable", async () => {
    for (const error of [
      new TypeError("fetch failed"),
      new DOMException("The operation timed out.", "TimeoutError"),
      new TypeError("redirect mode is set to error"),
    ]) {
      const outcome = await discover(() => Promise.reject(error)).outcome;
      expect(outcome).toEqual({ kind: "unavailable" });
    }
  });

  it("times out a server that never answers", async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn(
        (_url: unknown, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
          }),
      );
      const pending = discoverOrganization(EMAIL, {
        hubUrl: HUB,
        fetch: fetcher as unknown as typeof fetch,
      });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await pending).toEqual({ kind: "unavailable" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats malformed or oversized JSON as retryable, never as not found", async () => {
    const raw = (body: string) =>
      new Response(body, { status: 200, headers: { "content-type": "application/json" } });
    for (const body of [
      "not json",
      "[]",
      "null",
      JSON.stringify({ result: "found" }),
      JSON.stringify({ ...(fixtures.found_entra!.body as object), contractVersion: 2 }),
      JSON.stringify({ ...(fixtures.not_found!.body as object), contractVersion: "1" }),
      JSON.stringify({ ...(fixtures.found_entra!.body as object), agentHub: null }),
      JSON.stringify({ ...(fixtures.found_entra!.body as object), signIn: { method: 1 } }),
      JSON.stringify({ ...(fixtures.found_entra!.body as object), padding: "x".repeat(70_000) }),
    ]) {
      expect(await discover(raw(body)).outcome, body.slice(0, 60)).toEqual({ kind: "unavailable" });
    }
  });

  it("is unavailable, without a request, when the build has no discovery service", async () => {
    const { fetcher, outcome } = discover(reply(fixtures.found_entra!), null);
    expect(await outcome).toEqual({ kind: "unavailable" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("never accepts a found origin that fails validation", async () => {
    const outcome = await discover(found("http://hub.acme.example")).outcome;
    expect(outcome).toEqual({ kind: "unavailable" });
  });
});

describe("validateDiscoveredOrigin", () => {
  it.each([
    "https://hub.acme.example",
    "https://hub.acme.example:8443",
    "https://xn--hb-xka.example",
  ])("accepts the canonical public origin %s", (origin) => {
    expect(validateDiscoveredOrigin(origin)).toBe(origin);
  });

  it.each([
    ["cleartext", "http://hub.acme.example"],
    ["javascript", "javascript:alert(1)"],
    ["data", "data:text/html,hi"],
    ["file", "file:///etc/passwd"],
    ["ftp", "ftp://hub.acme.example"],
    ["no scheme", "hub.acme.example"],
    ["trailing slash", "https://hub.acme.example/"],
    ["path", "https://hub.acme.example/app"],
    ["query", "https://hub.acme.example?x=1"],
    ["fragment", "https://hub.acme.example#x"],
    ["credentials", "https://user:pass@hub.acme.example"],
    ["userinfo lookalike", "https://hub.acme.com@evil.example"],
    ["uppercase", "https://HUB.acme.example"],
    ["default port", "https://hub.acme.example:443"],
    ["leading space", " https://hub.acme.example"],
    ["trailing space", "https://hub.acme.example "],
    ["newline", "https://hub.acme.example\n"],
    ["tab inside", "https://hub.\tacme.example"],
    ["backslash", "https:\\\\hub.acme.example"],
    ["backslash host", "https://evil.example\\@hub.acme.example"],
    ["unicode IDN", "https://hüb.example"],
    ["fullwidth dot", "https://hub。acme.example"],
    ["localhost", "https://localhost"],
    ["localhost subdomain", "https://hub.localhost"],
    ["loopback IPv4", "https://127.0.0.1"],
    ["decimal IPv4", "https://2130706433"],
    ["public IPv4 literal", "https://93.184.216.34"],
    ["private IPv4", "https://10.0.0.5"],
    ["private 192.168", "https://192.168.1.10"],
    ["link-local", "https://169.254.169.254"],
    ["IPv6 loopback", "https://[::1]"],
    ["IPv6 ULA", "https://[fd00::1]"],
    ["IPv6 public", "https://[2001:db8::1]"],
    ["mDNS", "https://hub.local"],
    ["single label", "https://intranet"],
    ["trailing dot", "https://hub.acme.example."],
    ["empty", ""],
    ["not a string", 42],
    ["null", null],
    ["very long", `https://${"a".repeat(2100)}.example`],
  ])("rejects %s", (_name, origin) => {
    expect(validateDiscoveredOrigin(origin)).toBeNull();
  });
});

describe("org discovery privacy", () => {
  const spies: Array<ReturnType<typeof vi.spyOn>> = [];
  afterEach(() => {
    for (const spy of spies.splice(0)) spy.mockRestore();
  });

  it("never writes the email or login hint to any console channel", async () => {
    const written: string[] = [];
    for (const level of ["log", "info", "warn", "error", "debug", "trace"] as const) {
      spies.push(
        vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
          written.push(
            args.map((arg) => (arg instanceof Error ? arg.stack : String(arg))).join(" "),
          );
        }),
      );
    }
    const responses: Array<Response | (() => Promise<Response>)> = [
      ...Object.values(fixtures).map((fixture) => reply(fixture)),
      found("http://evil.example"),
      reply({
        status: 200,
        body: { ...(fixtures.found_entra!.body as object), contractVersion: 9 },
      }),
      new Response("{", { status: 200 }),
      reply({ status: 503, body: { error: "server_error", email: EMAIL } }),
      () => Promise.reject(new TypeError(`fetch failed for ${EMAIL}`)),
    ];
    const replies: unknown[] = [];
    for (const response of responses) {
      const outcome = await discover(response).outcome;
      replies.push(discoveryReply(outcome));
    }
    expect(written.join("\n")).not.toContain(EMAIL);
    expect(written.join("\n")).not.toContain("alice@acme.example");
    // The renderer is told the outcome, never the hint or anything Hub echoed back.
    expect(JSON.stringify(replies)).not.toContain(EMAIL);
    expect(JSON.stringify(replies)).not.toContain("alice@acme.example");
  });
});

describe("login hint handoff", () => {
  it("drops a login hint that was not taken in time", () => {
    let now = 0;
    const hints = createLoginHintStore(() => now);
    hints.set("https://hub.acme.example", "alice@acme.example");
    now = LOGIN_HINT_TTL_MS;
    expect(hints.take("https://hub.acme.example")).toBeNull();
  });

  it("hands the hint once, and only to the discovered origin", () => {
    const hints = createLoginHintStore();
    hints.set("https://hub.acme.example", "alice@acme.example");
    expect(hints.take("https://evil.example")).toBeNull();
    expect(hints.take("https://hub.acme.example")).toBe("alice@acme.example");
    expect(hints.take("https://hub.acme.example")).toBeNull();
  });

  it("forgets the hint when the organization is switched", () => {
    const hints = createLoginHintStore();
    hints.set("https://hub.acme.example", "alice@acme.example");
    hints.clear();
    expect(hints.take("https://hub.acme.example")).toBeNull();
  });

  it("stores nothing for a missing hint", () => {
    const hints = createLoginHintStore();
    hints.set("https://hub.acme.example", "alice@acme.example");
    hints.set("https://hub.beta.example", null);
    expect(hints.take("https://hub.acme.example")).toBeNull();
    expect(hints.take("https://hub.beta.example")).toBeNull();
  });
});
