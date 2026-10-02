// @vitest-environment jsdom

import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const authClient = vi.hoisted(() => ({ signIn: { email: vi.fn() } }));
vi.mock("../lib/auth", () => ({ authClient }));
vi.mock("../lib/rpc", () => ({ clearSpaceSelection: vi.fn() }));
vi.mock("./Welcome", () => ({ WelcomePage: () => null }));
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray) => parts.join("");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});
vi.mock("@cortexai-agent-hub/ui-web", () => ({
  Button: ({
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => <button {...props} />,
  Input: (props: ComponentProps<"input">) => <input {...props} />,
  Label: ({ htmlFor, children }: ComponentProps<"label">) => (
    <label htmlFor={htmlFor}>{children}</label>
  ),
}));

import { AuthPage } from "./Auth";

const email = "user@example.test";
let container: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;

function stubServer(
  mode: "hub" | "local",
  next: unknown = { next: "password" },
  continueStatus = 200,
  signIn: { body: unknown; status: number } = { body: { message: "Access denied" }, status: 401 },
) {
  fetchMock = vi.fn(async (url: string) => {
    if (url === "/api/auth/capabilities")
      return Response.json({ mode, passwordReset: false, resetUrl: null });
    if (url === "/api/auth/hub/sign-in/continue")
      return Response.json(next, { status: continueStatus });
    if (url === "/api/auth/hub/sign-in")
      return Response.json(signIn.body, { status: signIn.status });
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
