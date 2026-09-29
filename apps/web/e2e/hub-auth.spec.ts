import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./helpers";

for (const desktop of [false, true]) {
  test(`Hub native sign-in ${desktop ? "desktop renderer" : "web"}`, async ({ page }, testInfo) => {
    await page.route("**/api/auth/get-session*", (route) => route.fulfill({ json: null }));
    await page.route("**/api/auth/capabilities", (route) =>
      route.fulfill({ json: { mode: "hub", passwordReset: false, resetUrl: null } }),
    );
    for (const path of ["/", "/sign-in", "/sign-up", "/forgot-password"]) {
      await page.goto(path);
      if (path === "/") await expect(page).toHaveURL(/\/sign-in$/);
      await expect(
        page.getByRole("heading", { name: "Sign in to CortexAI Agent Hub" }),
      ).toBeVisible();
      await expect(page.getByLabel("Email", { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeVisible();
      await expect(page.getByLabel("Password", { exact: true })).toHaveCount(0);
      await expect(page.getByRole("link", { name: "Sign up", exact: true })).toHaveCount(0);
    }
    if (desktop)
      await page.evaluate(() => {
        window.cortexAiAgentHubDesktop = { platform: "darwin" } as never;
        window.open = () => {
          throw new Error("Hub login must not open a popup");
        };
      });
    const email = page.getByLabel("Email", { exact: true });
    const password = page.getByLabel("Password", { exact: true });
    await page.route("**/api/auth/hub/sign-in/continue", (route) => {
      expect(route.request().method()).toBe("POST");
      expect(route.request().postDataJSON()).toEqual({ email: "user@example.test" });
      return route.fulfill({ json: { next: "password" } });
    });
    await page.route("**/api/auth/hub/sign-in", (route) => {
      expect(route.request().method()).toBe("POST");
      expect(route.request().postDataJSON()).toEqual({
        email: "user@example.test",
        password: "test-password",
      });
      return route.fulfill({ status: 401, json: { message: "Access denied" } });
    });
    await email.fill("user@example.test");
    await captureScreenshot(page, testInfo, "hub-sign-in-email-step");
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(password).toBeFocused();
    await expect(email).toHaveValue("user@example.test");
    await expect(email).not.toBeEditable();
    await captureScreenshot(page, testInfo, "hub-sign-in-password-step");
    await password.fill("test-password");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByRole("alert")).toHaveText("Could not sign in through CortexAI Hub");
    await page.route("**/api/auth/hub/sign-in", (route) =>
      route.fulfill({ status: 400, json: { code: "HUB_IDP_UNSUPPORTED" } }),
    );
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByRole("alert")).toHaveText(
      "This organization’s sign-in method is not supported yet",
    );
    await captureScreenshot(page, testInfo, "hub-native-sign-in");

    await page.getByRole("button", { name: "Use a different email" }).click();
    await expect(password).toHaveCount(0);
    await expect(email).toBeFocused();
    await page.route("**/api/auth/hub/sign-in/continue", (route) =>
      route.fulfill({ json: { next: "sso_unavailable" } }),
    );
    await email.fill("entra@example.test");
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText(
      "Microsoft sign-in for your organization isn't available in Agent Hub yet. Ask your admin to enable password sign-in for your account.",
    );
    await expect(password).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Sign in", exact: true })).toHaveCount(0);
    await captureScreenshot(page, testInfo, "hub-sign-in-sso-unavailable");

    await page.getByRole("button", { name: "Use a different email" }).click();
    await page.route("**/api/auth/hub/sign-in/continue", (route) =>
      route.fulfill({ json: { next: "other_sso_unavailable" } }),
    );
    await email.fill("google@example.test");
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText(
      "Single sign-on for your organization isn't available in Agent Hub yet. Ask your admin to enable password sign-in for your account.",
    );
    await expect(password).toHaveCount(0);
    await captureScreenshot(page, testInfo, "hub-sign-in-other-sso-unavailable");

    await page.getByRole("button", { name: "Use a different email" }).click();
    const authorizeUrl = "https://hub.example.test/authorize?request=fixture";
    await page.route("**/api/auth/hub/sign-in/continue", (route) =>
      route.fulfill({ json: { next: "redirect", url: authorizeUrl } }),
    );
    await page.route("https://hub.example.test/**", (route) =>
      route.fulfill({ contentType: "text/html", body: "<h1>Hub</h1>" }),
    );
    await email.fill("entra@example.test");
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    if (desktop) {
      await expect(page.getByRole("status")).toHaveText(
        `Microsoft sign-in isn't available in the desktop app yet. Open Agent Hub in your browser. ${new URL(page.url()).origin}`,
      );
      await expect(password).toHaveCount(0);
      await captureScreenshot(page, testInfo, "hub-sign-in-desktop-sso");
    } else {
      await expect(page).toHaveURL(authorizeUrl);
    }
  });
}

test("Hub SSO callback errors show a fixed message", async ({ page }, testInfo) => {
  await page.route("**/api/auth/get-session*", (route) => route.fulfill({ json: null }));
  await page.route("**/api/auth/capabilities", (route) =>
    route.fulfill({ json: { mode: "hub", passwordReset: false, resetUrl: null } }),
  );
  await page.goto("/sign-in?error=sso_expired");
  await expect(page.getByRole("alert")).toHaveText("Your sign-in expired. Try again.");
  await page.goto("/sign-in?error=sso_failed");
  await expect(page.getByRole("alert")).toHaveText(
    "Microsoft sign-in didn't finish. Try again, or ask your admin for access.",
  );
  await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "hub-sign-in-sso-failed");
  await page.goto("/sign-in?error=unexpected");
  await expect(page.getByRole("heading", { name: "Sign in to CortexAI Agent Hub" })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("capability network failure blocks authentication", async ({ page }) => {
  await page.route("**/api/auth/get-session*", (route) => route.fulfill({ json: null }));
  await page.route("**/api/auth/capabilities", (route) => route.abort("failed"));
  await page.goto("/sign-in");
  await expect(page.getByRole("alert")).toHaveText("Could not reach the server");
  await expect(page.getByRole("button", { name: "Continue", exact: true })).toHaveCount(0);
});

test("local installations retain the welcome and signup flow", async ({ page }) => {
  await page.route("**/api/auth/get-session*", (route) => route.fulfill({ json: null }));
  await page.route("**/api/auth/capabilities", (route) =>
    route.fulfill({ json: { mode: "local", passwordReset: false, resetUrl: null } }),
  );
  await page.goto("/");
  await page.getByRole("button", { name: /Sign up/ }).click();
  await expect(page).toHaveURL(/\/sign-up$/);
  await expect(page.getByRole("heading", { name: "Create your CortexAI Agent Hub" })).toBeVisible();
});

test("tenant entry does not offer signup when capabilities are unavailable", async ({ page }) => {
  await page.route("**/api/auth/get-session*", (route) => route.fulfill({ json: null }));
  await page.route("**/api/auth/capabilities", (route) => route.abort("failed"));
  await page.goto("/");
  await expect(page.getByRole("alert")).toHaveText("Could not reach the server");
  await expect(page.getByRole("button", { name: /Sign up/ })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Sign up", exact: true })).toHaveCount(0);
});
