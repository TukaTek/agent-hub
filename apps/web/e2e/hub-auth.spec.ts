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
      await expect(page.getByLabel("Password", { exact: true })).toBeVisible();
      await expect(page.getByRole("link", { name: "Sign up", exact: true })).toHaveCount(0);
    }
    if (desktop)
      await page.evaluate(() => {
        window.cortexAiAgentHubDesktop = { platform: "darwin" } as never;
        window.open = () => {
          throw new Error("Hub login must not open a popup");
        };
      });
    await page.route("**/api/auth/hub/sign-in", (route) => {
      expect(route.request().method()).toBe("POST");
      expect(route.request().postDataJSON()).toEqual({
        email: "user@example.test",
        password: "test-password",
      });
      return route.fulfill({ status: 401, json: { message: "Access denied" } });
    });
    await page.getByLabel("Email", { exact: true }).fill("user@example.test");
    await page.getByLabel("Password", { exact: true }).fill("test-password");
    await page.getByRole("button", { name: "Continue with email" }).click();
    await expect(page.getByRole("alert")).toHaveText("Could not sign in through CortexAI Hub");
    await page.route("**/api/auth/hub/sign-in", (route) =>
      route.fulfill({ status: 400, json: { code: "HUB_IDP_UNSUPPORTED" } }),
    );
    await page.getByRole("button", { name: "Continue with email" }).click();
    await expect(page.getByRole("alert")).toHaveText(
      "This organization’s sign-in method is not supported yet",
    );
    await captureScreenshot(page, testInfo, "hub-native-sign-in");
  });
}

test("capability network failure blocks authentication", async ({ page }) => {
  await page.route("**/api/auth/get-session*", (route) => route.fulfill({ json: null }));
  await page.route("**/api/auth/capabilities", (route) => route.abort("failed"));
  await page.goto("/sign-in");
  await expect(page.getByRole("alert")).toHaveText("Could not reach the server");
  await expect(page.getByRole("button", { name: "Continue with email" })).toHaveCount(0);
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
