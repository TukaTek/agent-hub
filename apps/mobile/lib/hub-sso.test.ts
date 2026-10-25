import { createHash, randomBytes } from "node:crypto";
import { openAuthSessionAsync } from "expo-web-browser";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearSpace, currentApiBase, fetchMobileJson } from "./api";
import { continueWithHubSso } from "./hub-sso";
import { currentSessionGeneration, replaceSessionTokenIfCurrent } from "./session";

vi.mock("expo-web-browser", () => ({ openAuthSessionAsync: vi.fn() }));
vi.mock("expo-crypto", () => ({
  CryptoDigestAlgorithm: { SHA256: "SHA-256" },
  CryptoEncoding: { BASE64: "base64" },
  getRandomBytesAsync: vi.fn(async (count: number) => new Uint8Array(randomBytes(count))),
  digestStringAsync: vi.fn(async (_algorithm: string, data: string) =>
    createHash("sha256").update(data).digest("base64"),
  ),
}));
vi.mock("./api", () => ({
  clearSpace: vi.fn(async () => true),
  currentApiBase: vi.fn(() => API),
  fetchMobileJson: vi.fn(),
}));
vi.mock("./session", () => ({
  currentSessionGeneration: vi.fn(() => 1),
  replaceSessionTokenIfCurrent: vi.fn(async () => true),
  tokenFromAuthResponse: (_response: Response, body: { token?: string }) => body?.token ?? "",
}));

const API = "https://cortexai-agent-hub.example.test";
const STATE = "s".repeat(43);
const CODE = "c".repeat(43);
const TOKEN = "signed-session-token";
const AUTHORIZE = "https://hub.example.test/authorize?client_id=x&response_type=code";
const callback = (query: string) => `cortexai-agent-hub://hub-sso?${query}`;
const ACCESS = "You don't have access to Agent Hub. Ask your admin.";
const FAILED = "Sign-in failed. Try again.";

function startAnswers(body: unknown, status = 200) {
  return { response: Response.json(body, { status }), body };
}

function body(call: number): Record<string, string> {
  return JSON.parse(String(vi.mocked(fetchMobileJson).mock.calls[call]?.[1]?.body));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(currentApiBase).mockReturnValue(API);
  vi.mocked(currentSessionGeneration).mockReturnValue(1);
  vi.mocked(clearSpace).mockResolvedValue(true);
  vi.mocked(replaceSessionTokenIfCurrent).mockReset().mockResolvedValue(true);
  vi.mocked(fetchMobileJson)
    .mockReset()
    .mockResolvedValueOnce(
      startAnswers({ next: "redirect", authorizeUrl: AUTHORIZE, state: STATE }),
    )
    .mockResolvedValueOnce(startAnswers({ token: TOKEN, user: { id: "user-1" } }));
  vi.mocked(openAuthSessionAsync).mockResolvedValue({
    type: "success",
    url: callback(`code=${CODE}&state=${STATE}`),
  });
});
afterEach(() => vi.restoreAllMocks());

it("starts, opens Microsoft in an ephemeral session, completes and stores the session", async () => {
  await expect(continueWithHubSso(" user@example.test ")).resolves.toBe("signed_in");
  const [startUrl, startInit] = vi.mocked(fetchMobileJson).mock.calls[0]!;
  expect(startUrl).toBe(`${API}/api/auth/hub/sso/native/start`);
  expect(startInit.method).toBe("POST");
  expect(startInit.headers).toMatchObject({ origin: "cortexai-agent-hub://" });
  const start = body(0);
  expect(start).toEqual({
    email: "user@example.test",
    client: "mobile",
    returnTo: "cortexai-agent-hub://hub-sso",
    appChallenge: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
  });
  expect(openAuthSessionAsync).toHaveBeenCalledWith(AUTHORIZE, "cortexai-agent-hub://hub-sso", {
    preferEphemeralSession: true,
  });
  expect(vi.mocked(fetchMobileJson).mock.calls[1]![0]).toBe(
    `${API}/api/auth/hub/sso/native/complete`,
  );
  const complete = body(1);
  expect(complete).toEqual({
    code: CODE,
    state: STATE,
    appVerifier: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
  });
  // The challenge is the S256 of the verifier, and only complete carries the verifier.
  expect(createHash("sha256").update(complete.appVerifier!).digest("base64url")).toBe(
    start.appChallenge,
  );
  expect(JSON.stringify(start)).not.toContain(complete.appVerifier);
  expect(clearSpace).toHaveBeenCalledOnce();
  expect(replaceSessionTokenIfCurrent).toHaveBeenCalledWith(1, TOKEN);
});

it("uses a fresh verifier for every attempt", async () => {
  await continueWithHubSso("user@example.test");
  vi.mocked(fetchMobileJson)
    .mockResolvedValueOnce(startAnswers({ next: "redirect", authorizeUrl: AUTHORIZE, state: STATE }))
    .mockResolvedValueOnce(startAnswers({ token: TOKEN, user: { id: "user-1" } }));
  await continueWithHubSso("user@example.test");
  expect(body(0).appChallenge).not.toBe(body(2).appChallenge);
});

it.each(["password", "other_sso_unavailable"] as const)(
  "returns %s without opening a browser",
  async (next) => {
    vi.mocked(fetchMobileJson).mockReset().mockResolvedValueOnce(startAnswers({ next }));
    await expect(continueWithHubSso("user@example.test")).resolves.toBe(next);
    expect(openAuthSessionAsync).not.toHaveBeenCalled();
    expect(replaceSessionTokenIfCurrent).not.toHaveBeenCalled();
  },
);

it.each([
  { next: "redirect", authorizeUrl: "http://hub.example.test/authorize", state: STATE },
  { next: "redirect", authorizeUrl: "not a url", state: STATE },
  { next: "redirect", authorizeUrl: AUTHORIZE },
  { next: "redirect", authorizeUrl: AUTHORIZE, state: "" },
  { next: "sso_unavailable" },
  {},
])("rejects an unusable start answer %j", async (answer) => {
  vi.mocked(fetchMobileJson).mockReset().mockResolvedValueOnce(startAnswers(answer));
  await expect(continueWithHubSso("user@example.test")).rejects.toThrow("Could not continue");
  expect(openAuthSessionAsync).not.toHaveBeenCalled();
});

it.each(["HUB_SSO_ACCESS_DENIED", "HUB_ACCESS_DENIED"])(
  "explains a %s refusal at start",
  async (code) => {
    vi.mocked(fetchMobileJson)
      .mockReset()
      .mockResolvedValueOnce(startAnswers({ code, message: "Ask your admin for access" }, 403));
    await expect(continueWithHubSso("user@example.test")).rejects.toThrow(ACCESS);
    expect(openAuthSessionAsync).not.toHaveBeenCalled();
  },
);

it("keeps the server's own refusal message at start", async () => {
  vi.mocked(fetchMobileJson)
    .mockReset()
    .mockResolvedValueOnce(
      startAnswers(
        {
          code: "HUB_UNAVAILABLE",
          message: "Sign-in is temporarily unavailable, CortexAI Hub can't be reached",
        },
        503,
      ),
    );
  await expect(continueWithHubSso("user@example.test")).rejects.toThrow(
    "Sign-in is temporarily unavailable, CortexAI Hub can't be reached",
  );
});

it.each(["cancel", "dismiss", "locked", "opened"] as const)(
  "stores nothing when the browser result is %s",
  async (type) => {
    vi.mocked(openAuthSessionAsync).mockResolvedValue({ type });
    await expect(continueWithHubSso("user@example.test")).resolves.toBe("cancelled");
    expect(fetchMobileJson).toHaveBeenCalledOnce();
    expect(replaceSessionTokenIfCurrent).not.toHaveBeenCalled();
  },
);

it.each([
  ["wrong scheme", `https://hub-sso/?code=${CODE}&state=${STATE}`],
  ["other app scheme", `cortexai-agent-hub-evil://hub-sso?code=${CODE}&state=${STATE}`],
  ["wrong host", `cortexai-agent-hub://sign-in?code=${CODE}&state=${STATE}`],
  ["host with port", `cortexai-agent-hub://hub-sso:1234?code=${CODE}&state=${STATE}`],
  ["extra path", `cortexai-agent-hub://hub-sso/extra?code=${CODE}&state=${STATE}`],
  ["userinfo", `cortexai-agent-hub://user@hub-sso?code=${CODE}&state=${STATE}`],
  ["fragment", callback(`code=${CODE}&state=${STATE}#x`)],
  ["missing state", callback(`code=${CODE}`)],
  ["wrong state", callback(`code=${CODE}&state=${"t".repeat(43)}`)],
  ["duplicate state", callback(`code=${CODE}&state=${STATE}&state=${STATE}`)],
  ["missing code", callback(`state=${STATE}`)],
  ["empty code", callback(`code=&state=${STATE}`)],
  ["duplicate code", callback(`code=${CODE}&code=${CODE}&state=${STATE}`)],
  ["unparseable", "::not a url::"],
  ["error with wrong state", callback(`error=sso_cancelled&state=${"t".repeat(43)}`)],
])("rejects a callback with %s and stores nothing", async (_case, url) => {
  vi.mocked(openAuthSessionAsync).mockResolvedValue({ type: "success", url });
  await expect(continueWithHubSso("user@example.test")).rejects.toThrow(FAILED);
  expect(fetchMobileJson).toHaveBeenCalledOnce();
  expect(replaceSessionTokenIfCurrent).not.toHaveBeenCalled();
});

it.each([
  ["hub_access_denied", ACCESS],
  ["sso_failed", FAILED],
  ["sso_expired", FAILED],
  ["hub_unavailable", FAILED],
  ["tenant_disabled", FAILED],
  ["something_new", FAILED],
  ["", FAILED],
])("maps callback error=%s", async (error, message) => {
  vi.mocked(openAuthSessionAsync).mockResolvedValue({
    type: "success",
    url: callback(`error=${error}&state=${STATE}`),
  });
  await expect(continueWithHubSso("user@example.test")).rejects.toThrow(message);
  expect(fetchMobileJson).toHaveBeenCalledOnce();
  expect(replaceSessionTokenIfCurrent).not.toHaveBeenCalled();
});

it("treats Hub's sso_cancelled as a quiet cancel", async () => {
  vi.mocked(openAuthSessionAsync).mockResolvedValue({
    type: "success",
    url: callback(`error=sso_cancelled&state=${STATE}`),
  });
  await expect(continueWithHubSso("user@example.test")).resolves.toBe("cancelled");
  expect(fetchMobileJson).toHaveBeenCalledOnce();
  expect(replaceSessionTokenIfCurrent).not.toHaveBeenCalled();
});

it("never completes a callback that carries both an error and a code", async () => {
  vi.mocked(openAuthSessionAsync).mockResolvedValue({
    type: "success",
    url: callback(`error=sso_failed&code=${CODE}&state=${STATE}`),
  });
  await expect(continueWithHubSso("user@example.test")).rejects.toThrow(FAILED);
  expect(fetchMobileJson).toHaveBeenCalledOnce();
});

it.each([
  [400, { message: "Your sign-in expired" }, FAILED],
  [503, { code: "HUB_UNAVAILABLE", message: "Sign-in is temporarily unavailable" }, FAILED],
  [403, { code: "HUB_ACCESS_DENIED", message: "Ask your admin for access" }, ACCESS],
  [200, {}, FAILED],
])("maps a %i complete answer", async (status, answer, message) => {
  vi.mocked(fetchMobileJson).mockReset();
  vi.mocked(fetchMobileJson)
    .mockResolvedValueOnce(startAnswers({ next: "redirect", authorizeUrl: AUTHORIZE, state: STATE }))
    .mockResolvedValueOnce(startAnswers(answer, status));
  await expect(continueWithHubSso("user@example.test")).rejects.toThrow(message);
  expect(replaceSessionTokenIfCurrent).not.toHaveBeenCalled();
});

it("maps a complete request that cannot reach the server", async () => {
  vi.mocked(fetchMobileJson).mockReset();
  vi.mocked(fetchMobileJson)
    .mockResolvedValueOnce(startAnswers({ next: "redirect", authorizeUrl: AUTHORIZE, state: STATE }))
    .mockRejectedValueOnce(new TypeError("Network request failed"));
  await expect(continueWithHubSso("user@example.test")).rejects.toThrow(FAILED);
  expect(replaceSessionTokenIfCurrent).not.toHaveBeenCalled();
});

it("starts one attempt for concurrent taps", async () => {
  let finish: (value: { type: "cancel" }) => void = () => {};
  vi.mocked(openAuthSessionAsync).mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const first = continueWithHubSso("user@example.test");
  await expect(continueWithHubSso("user@example.test")).resolves.toBe("busy");
  await vi.waitFor(() => expect(openAuthSessionAsync).toHaveBeenCalledOnce());
  finish({ type: "cancel" });
  await expect(first).resolves.toBe("cancelled");
  expect(fetchMobileJson).toHaveBeenCalledOnce();
  // The next tap after the attempt ends starts again.
  vi.mocked(fetchMobileJson)
    .mockReset()
    .mockResolvedValueOnce(startAnswers({ next: "password" }));
  await expect(continueWithHubSso("user@example.test")).resolves.toBe("password");
});

it("allows a new attempt after a failed one", async () => {
  vi.mocked(fetchMobileJson).mockReset().mockRejectedValueOnce(new Error("Could not reach"));
  await expect(continueWithHubSso("user@example.test")).rejects.toThrow();
  vi.mocked(fetchMobileJson).mockResolvedValueOnce(startAnswers({ next: "password" }));
  await expect(continueWithHubSso("user@example.test")).resolves.toBe("password");
});

it.each([
  ["start", 0],
  ["browser", 1],
  ["complete", 2],
] as const)("stores nothing when the server changes during %s", async (_phase, step) => {
  const switchServer = () => vi.mocked(currentApiBase).mockReturnValue("https://other.example.test");
  if (step === 0)
    vi.mocked(fetchMobileJson).mockReset().mockImplementationOnce(async () => {
      switchServer();
      return startAnswers({ next: "redirect", authorizeUrl: AUTHORIZE, state: STATE });
    });
  if (step === 1)
    vi.mocked(openAuthSessionAsync).mockImplementationOnce(async () => {
      switchServer();
      return { type: "success", url: callback(`code=${CODE}&state=${STATE}`) };
    });
  if (step === 2) {
    vi.mocked(fetchMobileJson)
      .mockReset()
      .mockResolvedValueOnce(
        startAnswers({ next: "redirect", authorizeUrl: AUTHORIZE, state: STATE }),
      )
      .mockImplementationOnce(async () => {
        switchServer();
        return startAnswers({ token: TOKEN, user: { id: "user-1" } });
      });
  }
  await expect(continueWithHubSso("user@example.test")).resolves.toBe("cancelled");
  expect(fetchMobileJson).toHaveBeenCalledTimes(step === 2 ? 2 : 1);
  if (step < 2) expect(openAuthSessionAsync).toHaveBeenCalledTimes(step);
  expect(clearSpace).not.toHaveBeenCalled();
  expect(replaceSessionTokenIfCurrent).not.toHaveBeenCalled();
});

it("stores nothing when the session changes during the browser", async () => {
  vi.mocked(openAuthSessionAsync).mockImplementationOnce(async () => {
    vi.mocked(currentSessionGeneration).mockReturnValue(2);
    return { type: "success", url: callback(`code=${CODE}&state=${STATE}`) };
  });
  await expect(continueWithHubSso("user@example.test")).resolves.toBe("cancelled");
  expect(fetchMobileJson).toHaveBeenCalledOnce();
  expect(replaceSessionTokenIfCurrent).not.toHaveBeenCalled();
});

it("reports a session that could not be saved", async () => {
  vi.mocked(replaceSessionTokenIfCurrent).mockRejectedValueOnce(new Error("SecureStoreException"));
  await expect(continueWithHubSso("user@example.test")).rejects.toThrow(
    "Could not save your sign-in on this device. Try again.",
  );
});

it("never logs the token, handoff code, verifier, state or callback URL", async () => {
  const logged: unknown[] = [];
  for (const level of ["log", "info", "warn", "error", "debug"] as const)
    vi.spyOn(console, level).mockImplementation((...args) => logged.push(...args));
  await continueWithHubSso("user@example.test");
  const verifier = body(1).appVerifier!;
  for (const url of [
    callback(`error=sso_failed&state=${STATE}`),
    callback(`code=${CODE}&state=${"t".repeat(43)}`),
  ]) {
    vi.mocked(fetchMobileJson).mockResolvedValueOnce(
      startAnswers({ next: "redirect", authorizeUrl: AUTHORIZE, state: STATE }),
    );
    vi.mocked(openAuthSessionAsync).mockResolvedValueOnce({ type: "success", url });
    await continueWithHubSso("user@example.test").catch(() => undefined);
  }
  vi.mocked(fetchMobileJson)
    .mockResolvedValueOnce(startAnswers({ next: "redirect", authorizeUrl: AUTHORIZE, state: STATE }))
    .mockResolvedValueOnce(startAnswers({ message: `bad ${CODE}` }, 400));
  await continueWithHubSso("user@example.test").catch(() => undefined);
  const text = JSON.stringify(logged.map(String));
  for (const secret of [TOKEN, CODE, verifier, STATE, "hub-sso?"])
    expect(text).not.toContain(secret);
});
