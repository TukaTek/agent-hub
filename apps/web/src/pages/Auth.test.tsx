// @vitest-environment jsdom

import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authClient = vi.hoisted(() => ({
  signIn: { email: vi.fn(), emailOtp: vi.fn() },
  emailOtp: { sendVerificationOtp: vi.fn() },
}));
vi.mock("../lib/auth", () => ({ authClient }));
vi.mock("../lib/rpc", () => ({ clearSpaceSelection: vi.fn() }));
vi.mock("../lib/auth-capabilities", async () => {
  const { authCapabilitiesSchema, legacyAuthCapabilitiesSchema } = await import(
    "@cortexai-agent-hub/contracts"
  );
  return {
    fetchAuthCapabilities: async () =>
      authCapabilitiesSchema
        .or(legacyAuthCapabilitiesSchema)
        .parse(await (await fetch("/api/auth/capabilities")).json()),
  };
});
vi.mock("./Welcome", () => ({ WelcomePage: () => null }));
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray | { message: string }) =>
    "message" in parts ? parts.message : parts.join("");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});
vi.mock("@cortexai-agent-hub/ui-web", () => ({
  Button: ({
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => <button {...props} />,
  Input: (props: ComponentProps<"input">) => <input {...props} />,
  InputOTP: ({
    maxLength,
    onChange,
    onComplete,
    children: _children,
    ...props
  }: Omit<ComponentProps<"input">, "onChange"> & {
    onChange: (value: string) => void;
    onComplete?: (value: string) => void;
  }) => (
    <input
      {...props}
      data-otp=""
      onChange={(event) => {
        onChange(event.target.value);
        if (event.target.value.length === maxLength) onComplete?.(event.target.value);
      }}
    />
  ),
  InputOTPGroup: () => null,
  InputOTPSlot: () => null,
  Label: ({ htmlFor, children }: ComponentProps<"label">) => (
    <label htmlFor={htmlFor}>{children}</label>
  ),
}));

import { AuthPage } from "./Auth";

const email = "user@example.test";
let container: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;
let extraRoutes: Record<string, () => Response> = {};

function stubServer(
  mode: "hub" | "local",
  next: unknown = { next: "password" },
  continueStatus = 200,
  signIn: { body: unknown; status: number } = { body: { message: "Access denied" }, status: 401 },
  capabilities: Record<string, unknown> = {},
) {
  fetchMock = vi.fn(async (url: string) => {
    if (url === "/api/auth/capabilities")
      return Response.json({ mode, passwordReset: false, resetUrl: null, ...capabilities });
    if (url === "/api/auth/hub/sign-in/continue")
      return Response.json(next, { status: continueStatus });
    if (url === "/api/auth/hub/sign-in")
      return Response.json(signIn.body, { status: signIn.status });
    const route = extraRoutes[url];
    if (route) return route();
    throw new Error(`Unexpected request ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
}

async function render(path = "/sign-in") {
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/sign-in" element={<AuthPage mode="in" />} />
          <Route path="/app" element={<p>app home</p>} />
          <Route path="/integrations/setup" element={<p>integration setup</p>} />
        </Routes>
      </MemoryRouter>,
    ),
  );
  await until(() => container.querySelector("#email"));
}

async function until<T>(read: () => T | null | undefined | false): Promise<T> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const value = read();
    if (value) return value;
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  }
  throw new Error("Condition not met");
}

const emailInput = () => container.querySelector<HTMLInputElement>("#email")!;
const passwordInput = () => container.querySelector<HTMLInputElement>('input[name="password"]');
const button = (text: string) =>
  [...container.querySelectorAll("button")].find((entry) => entry.textContent === text);

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function click(target: HTMLElement | undefined) {
  if (!target) throw new Error("Missing element");
  await act(async () => target.click());
}

function requestsTo(url: string) {
  return fetchMock.mock.calls
    .filter(([called]) => called === url)
    .map(([, init]) => JSON.parse(init.body));
}

async function continueWithEmail() {
  await type(emailInput(), email);
  await click(button("Continue"));
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  extraRoutes = {};
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it("asks for the email first, then shows it read-only beside a focused password field", async () => {
  stubServer("hub");
  await render();
  expect(passwordInput()).toBeNull();
  expect(button("Sign in")).toBeUndefined();

  await continueWithEmail();
  await until(passwordInput);
  expect(requestsTo("/api/auth/hub/sign-in/continue")).toEqual([{ email }]);
  expect(emailInput().value).toBe(email);
  expect(emailInput().readOnly).toBe(true);
  expect(document.activeElement).toBe(passwordInput());
  expect(container.querySelector('label[for="current-password"]')?.textContent).toBe("Password");

  await type(passwordInput()!, "test-password");
  await click(button("Sign in"));
  await until(() => container.querySelector('[role="alert"]'));
  expect(requestsTo("/api/auth/hub/sign-in")).toEqual([{ email, password: "test-password" }]);
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    "Could not sign in through CortexAI Hub",
  );
});

it("returns to an editable email step and clears the password", async () => {
  stubServer("hub");
  await render();
  await continueWithEmail();
  await type(await until(passwordInput), "test-password");

  await click(button("Use a different email"));
  expect(passwordInput()).toBeNull();
  expect(emailInput().readOnly).toBe(false);
  expect(document.activeElement).toBe(emailInput());
  expect(button("Continue")).toBeDefined();

  await click(button("Continue"));
  expect((await until(passwordInput)).value).toBe("");
});

it("explains unavailable Microsoft sign-in without offering a password field", async () => {
  stubServer("hub", { next: "sso_unavailable" });
  await render();
  await continueWithEmail();
  const message = await until(() => container.querySelector('[role="status"]'));
  expect(message.textContent).toBe(
    "Microsoft sign-in for your organization isn't available in Agent Hub yet. Ask your admin to enable password sign-in for your account.",
  );
  expect(passwordInput()).toBeNull();
  expect(container.querySelector('button[type="submit"]')).toBeNull();
  expect(button("Use a different email")).toBeDefined();
});

it("explains unavailable non-Microsoft sign-in without naming the wrong provider", async () => {
  stubServer("hub", { next: "other_sso_unavailable" });
  await render();
  await continueWithEmail();
  const message = await until(() => container.querySelector('[role="status"]'));
  expect(message.textContent).toBe(
    "Single sign-on for your organization isn't available in Agent Hub yet. Ask your admin to enable password sign-in for your account.",
  );
  expect(passwordInput()).toBeNull();
  expect(container.querySelector('button[type="submit"]')).toBeNull();
});

it("sends a Hub SSO user to the authorize URL without a password step", async () => {
  const authorizeUrl = "https://hub.example.test/authorize?request=fixture";
  const assign = vi.fn();
  vi.stubGlobal("location", { ...window.location, origin: window.location.origin, assign });
  stubServer("hub", { next: "redirect", url: authorizeUrl });
  await render();
  await continueWithEmail();
  await until(() => assign.mock.calls.length > 0);
  expect(assign).toHaveBeenCalledExactlyOnceWith(authorizeUrl);
  expect(passwordInput()).toBeNull();
});

it("refuses a non-HTTPS authorize URL", async () => {
  const assign = vi.fn();
  vi.stubGlobal("location", { ...window.location, assign });
  stubServer("hub", { next: "redirect", url: "http://hub.example.test/authorize" });
  await render();
  await continueWithEmail();
  await until(() => container.querySelector('[role="alert"]'));
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("Could not continue");
  expect(assign).not.toHaveBeenCalled();
});

it.each([
  [
    { code: "HUB_SSO_ACCESS_DENIED", message: "Ask your admin for access" },
    "Microsoft sign-in didn't finish. Try again, or ask your admin for access.",
  ],
  [{ message: "Invalid sign-in origin" }, "Could not continue"],
])("explains a refused Continue (%j)", async (reply, shown) => {
  stubServer("hub", reply, 403);
  await render();
  await continueWithEmail();
  await until(() => container.querySelector('[role="alert"]'));
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(shown);
  expect(passwordInput()).toBeNull();
});

it("points desktop Microsoft users to the browser instead of redirecting", async () => {
  const assign = vi.fn();
  vi.stubGlobal("location", {
    ...window.location,
    origin: "https://agent-hub.example.test",
    assign,
  });
  vi.stubGlobal("cortexAiAgentHubDesktop", {});
  stubServer("hub", { next: "redirect", url: "https://hub.example.test/authorize" });
  await render();
  await continueWithEmail();
  const message = await until(() => container.querySelector('[role="status"]'));
  expect(message.textContent).toBe(
    "Microsoft sign-in isn't available in the desktop app yet. Open Agent Hub in your browser. https://agent-hub.example.test",
  );
  expect(assign).not.toHaveBeenCalled();
  expect(passwordInput()).toBeNull();
  expect(container.querySelector('button[type="submit"]')).toBeNull();
  await click(button("Use a different email"));
  expect(emailInput().readOnly).toBe(false);
});

describe("desktop Microsoft sign-in", () => {
  const nativeSso = { hubSso: true, hubSsoNative: true, sso: true, passwordAuth: false };
  const entra = { next: "redirect", url: "https://hub.example.test/authorize" };
  const returnTo = "http://127.0.0.1:53682/hub-sso";
  const appChallenge = "c".repeat(43);
  const authorizeUrl = "https://hub.example.test/authorize?state=s";
  const handoff = { code: "h".repeat(43), state: "native-state", appVerifier: "v".repeat(43) };

  function desktop(outcome: Promise<unknown> | unknown = handoff) {
    const hubSso = {
      start: vi.fn(async () => ({ returnTo, appChallenge })),
      open: vi.fn(async () => outcome),
      cancel: vi.fn(async () => undefined),
    };
    vi.stubGlobal("cortexAiAgentHubDesktop", { hubSso });
    const assign = vi.fn();
    vi.stubGlobal("location", {
      ...window.location,
      origin: "https://agent-hub.example.test",
      assign,
    });
    extraRoutes = {
      "/api/auth/hub/sso/native/start": () =>
        Response.json({ next: "redirect", authorizeUrl, state: "native-state" }),
      "/api/auth/hub/sso/native/complete": () => Response.json({ user: { id: "u" } }),
    };
    return { hubSso, assign };
  }

  it("offers Microsoft instead of the unavailable message and finishes in the app", async () => {
    const { hubSso, assign } = desktop();
    stubServer("hub", entra, 200, undefined, nativeSso);
    await render();
    await continueWithEmail();
    const microsoft = await until(() => button("Continue with Microsoft"));
    expect(container.textContent).not.toContain("isn't available in the desktop app");
    expect(container.querySelector('button[type="submit"]')).toBeNull();
    expect(emailInput().readOnly).toBe(true);
    expect(hubSso.start).not.toHaveBeenCalled();

    await click(microsoft);
    await until(() => assign.mock.calls.length > 0);
    expect(requestsTo("/api/auth/hub/sso/native/start")).toEqual([
      { email, client: "desktop", returnTo, appChallenge },
    ]);
    expect(hubSso.open).toHaveBeenCalledExactlyOnceWith(authorizeUrl, "native-state");
    expect(requestsTo("/api/auth/hub/sso/native/complete")).toEqual([handoff]);
    expect(assign).toHaveBeenCalledWith("/app");
  });

  it("keeps the unavailable message when the server has no native SSO", async () => {
    const { hubSso } = desktop();
    stubServer("hub", entra, 200, undefined, { ...nativeSso, hubSsoNative: false });
    await render();
    await continueWithEmail();
    const message = await until(() => container.querySelector('[role="status"]'));
    expect(message.textContent).toContain("isn't available in the desktop app yet");
    expect(button("Continue with Microsoft")).toBeUndefined();
    expect(hubSso.start).not.toHaveBeenCalled();
  });

  it("keeps the unavailable message on a desktop build without the Hub SSO bridge", async () => {
    vi.stubGlobal("cortexAiAgentHubDesktop", {});
    stubServer("hub", entra, 200, undefined, nativeSso);
    await render();
    await continueWithEmail();
    const message = await until(() => container.querySelector('[role="status"]'));
    expect(message.textContent).toContain("isn't available in the desktop app yet");
  });

  it("keeps redirecting in the browser", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    stubServer("hub", entra, 200, undefined, nativeSso);
    await render();
    await continueWithEmail();
    await until(() => assign.mock.calls.length > 0);
    expect(assign).toHaveBeenCalledWith("https://hub.example.test/authorize");
    expect(button("Continue with Microsoft")).toBeUndefined();
  });

  it.each([
    ["hub_access_denied", "You don't have access to Agent Hub — ask your admin"],
    ["sso_cancelled", "Microsoft sign-in was cancelled."],
    ["sso_failed", "Microsoft sign-in didn't finish. Try again, or ask your admin for access."],
    ["something_new", "Microsoft sign-in didn't finish. Try again, or ask your admin for access."],
    ["sso_expired", "Your sign-in expired. Try again."],
  ])("explains the %s callback error and offers Retry and Back", async (code, shown) => {
    const { hubSso, assign } = desktop({ error: code });
    stubServer("hub", entra, 200, undefined, nativeSso);
    await render();
    await continueWithEmail();
    await click(await until(() => button("Continue with Microsoft")));
    const alert = await until(() => container.querySelector('[role="alert"]'));
    expect(alert.textContent).toBe(shown);
    expect(requestsTo("/api/auth/hub/sso/native/complete")).toEqual([]);
    expect(assign).not.toHaveBeenCalled();

    await click(button("Retry"));
    await until(() => hubSso.open.mock.calls.length === 2);
    expect(hubSso.start).toHaveBeenCalledTimes(2);
    await click(await until(() => button("Use a different email")));
    expect(emailInput().readOnly).toBe(false);
  });

  it("cancels a pending sign-in without an error", async () => {
    let finish: (value: unknown) => void = () => undefined;
    const { hubSso } = desktop(new Promise((resolve) => (finish = resolve)));
    hubSso.cancel.mockImplementation(async () => {
      finish({ error: "cancelled" });
      return undefined;
    });
    stubServer("hub", entra, 200, undefined, nativeSso);
    await render();
    await continueWithEmail();
    await click(await until(() => button("Continue with Microsoft")));
    await click(await until(() => button("Cancel")));
    expect(hubSso.cancel).toHaveBeenCalledOnce();
    await until(() => button("Continue with Microsoft"));
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(requestsTo("/api/auth/hub/sso/native/complete")).toEqual([]);
  });

  it("shows the expired message when the handoff is refused", async () => {
    const { assign } = desktop();
    extraRoutes["/api/auth/hub/sso/native/complete"] = () =>
      Response.json({ message: "Your sign-in expired" }, { status: 400 });
    stubServer("hub", entra, 200, undefined, nativeSso);
    await render();
    await continueWithEmail();
    await click(await until(() => button("Continue with Microsoft")));
    const alert = await until(() => container.querySelector('[role="alert"]'));
    expect(alert.textContent).toBe("Your sign-in expired. Try again.");
    expect(assign).not.toHaveBeenCalled();
  });

  it("releases the attempt and follows a password answer from native start", async () => {
    const { hubSso } = desktop();
    extraRoutes["/api/auth/hub/sso/native/start"] = () => Response.json({ next: "password" });
    stubServer("hub", entra, 200, undefined, nativeSso);
    await render();
    await continueWithEmail();
    await click(await until(() => button("Continue with Microsoft")));
    await until(passwordInput);
    expect(hubSso.cancel).toHaveBeenCalledOnce();
    expect(hubSso.open).not.toHaveBeenCalled();
  });
});

it("keeps desktop password users on the password step", async () => {
  vi.stubGlobal("cortexAiAgentHubDesktop", {});
  stubServer("hub");
  await render();
  await continueWithEmail();
  await until(passwordInput);
});

it.each([
  ["sso_expired", "Your sign-in expired. Try again."],
  ["sso_failed", "Microsoft sign-in didn't finish. Try again, or ask your admin for access."],
])("shows a fixed message for the %s callback error", async (code, message) => {
  stubServer("hub");
  await render(`/sign-in?error=${code}`);
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(message);
  await continueWithEmail();
  await until(passwordInput);
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

const hubUnavailable = "Sign-in is temporarily unavailable, CortexAI Hub can't be reached";
const hubRefusals: Array<[string, number, string]> = [
  ["HUB_UNAVAILABLE", 503, hubUnavailable],
  ["HUB_CONFIG_INVALID", 503, hubUnavailable],
  ["HUB_CONFIG_RESTART_REQUIRED", 503, hubUnavailable],
  ["TENANT_DISABLED", 403, hubUnavailable],
  ["HUB_CREDENTIAL_INVALID", 503, hubUnavailable],
  ["HUB_NOT_CONFIGURED", 503, hubUnavailable],
  ["HUB_ACCESS_DENIED", 403, "Ask your admin for access"],
];

it.each(hubRefusals)("explains a Continue refused with %s", async (code, status, shown) => {
  stubServer("hub", { code, message: "server copy" }, status);
  await render();
  await continueWithEmail();
  await until(() => container.querySelector('[role="alert"]'));
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(shown);
  expect(passwordInput()).toBeNull();
});

it.each(hubRefusals)("explains a password sign-in refused with %s", async (code, status, shown) => {
  stubServer("hub", { next: "password" }, 200, { body: { code, message: "server copy" }, status });
  await render();
  await continueWithEmail();
  await type(await until(passwordInput), "test-password");
  await click(button("Sign in"));
  await until(() => container.querySelector('[role="alert"]'));
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(shown);
});

it.each(hubRefusals)(
  "shows a fixed message for the %s SSO callback error",
  async (code, _s, shown) => {
    stubServer("hub");
    await render(`/sign-in?error=${code.toLowerCase()}`);
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(shown);
  },
);

it("ignores unknown callback errors", async () => {
  stubServer("hub");
  await render("/sign-in?error=<script>alert(1)</script>");
  expect(container.querySelector('[role="alert"]')).toBeNull();
  await render("/sign-in?error=constructor");
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

it("keeps the email read-only while Continue is pending", async () => {
  stubServer("hub");
  await render();
  let resolveContinue!: (response: Response) => void;
  const response = new Promise<Response>((resolve) => {
    resolveContinue = resolve;
  });
  fetchMock.mockImplementation((url: string) => {
    if (url === "/api/auth/hub/sign-in/continue") return response;
    throw new Error(`Unexpected request ${url}`);
  });
  await type(emailInput(), email);
  await click(button("Continue"));
  expect(emailInput().readOnly).toBe(true);
  expect(emailInput().value).toBe(email);
  await act(async () => resolveContinue(Response.json({ next: "password" })));
  await until(passwordInput);
  expect(emailInput().value).toBe(email);
});

it("keeps the email step when Continue fails", async () => {
  stubServer("hub", { message: "Too many requests" }, 429);
  await render();
  await continueWithEmail();
  await until(() => container.querySelector('[role="alert"]'));
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("Could not continue");
  expect(passwordInput()).toBeNull();
  expect(emailInput().readOnly).toBe(false);
});

it("signs in local accounts through the same two steps and keeps the next allowlist", async () => {
  stubServer("local");
  authClient.signIn.email.mockResolvedValue({ data: {}, error: null });
  await render("/sign-in?next=/integrations/setup");
  expect(container.textContent).toContain("Sign up");
  expect(passwordInput()).toBeNull();

  await continueWithEmail();
  await type(await until(passwordInput), "password12");
  await click(button("Sign in"));
  await until(() => container.textContent?.includes("integration setup"));
  expect(authClient.signIn.email).toHaveBeenCalledExactlyOnceWith({
    email,
    password: "password12",
  });
  expect(requestsTo("/api/auth/hub/sign-in")).toEqual([]);
});

const emailCodeServer = { passwordAuth: true, sso: null, emailCode: true };
const codeInput = () => container.querySelector<HTMLInputElement>("[data-otp]");

it("sends a local account an email code after the email step and signs in with it", async () => {
  stubServer("local", { next: "password" }, 200, undefined, emailCodeServer);
  authClient.emailOtp.sendVerificationOtp.mockResolvedValue({ data: {}, error: null });
  authClient.signIn.emailOtp.mockResolvedValue({ data: {}, error: null });
  await render();
  await continueWithEmail();
  await type(await until(codeInput), "123456");
  await until(() => container.textContent?.includes("app home"));
  expect(authClient.emailOtp.sendVerificationOtp).toHaveBeenCalledExactlyOnceWith({
    email,
    type: "sign-in",
  });
  expect(authClient.signIn.emailOtp).toHaveBeenCalledExactlyOnceWith({
    email,
    otp: "123456",
    name: undefined,
  });
  expect(authClient.signIn.email).not.toHaveBeenCalled();
});

it("keeps password sign-in one step away from the code", async () => {
  stubServer("local", { next: "password" }, 200, undefined, emailCodeServer);
  authClient.emailOtp.sendVerificationOtp.mockResolvedValue({ data: {}, error: null });
  authClient.signIn.email.mockResolvedValue({ data: {}, error: null });
  await render();
  await continueWithEmail();
  await until(codeInput);
  await click(button("Use password"));
  await type(await until(passwordInput), "password12");
  await click(button("Sign in"));
  await until(() => container.textContent?.includes("app home"));
  expect(authClient.signIn.email).toHaveBeenCalledExactlyOnceWith({
    email,
    password: "password12",
  });
});

it("never sends an email code in Hub mode", async () => {
  stubServer("hub", { next: "password" }, 200, undefined, {
    passwordAuth: false,
    sso: null,
    emailCode: true,
  });
  await render();
  await continueWithEmail();
  await until(passwordInput);
  expect(codeInput()).toBeNull();
  expect(button("Use email code")).toBeUndefined();
  expect(authClient.emailOtp.sendVerificationOtp).not.toHaveBeenCalled();
});
