import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openUserSettings, signup } from "./helpers";

test("settings shell is two-pane and deep-links Models Memory Voice Usage", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  const userName = `Settings shell ${stamp}`;
  await signup(page, `settings-shell-${stamp}@cortexai-agent-hub.test`, "password12", userName);
  await completeOnboarding(page);

  await page.getByTestId("user-menu-trigger").click();
  const menu = page.locator('[data-slot="popover-content"]');
  await expect(menu.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
  await expect(menu.getByRole("button", { name: "Usage", exact: true })).toBeVisible();
  await expect(menu.getByRole("button", { name: "Log out", exact: true })).toBeVisible();
  await expect(menu.getByRole("button", { name: "Models", exact: true })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "settings-account-menu-lean");
  await page.keyboard.press("Escape");

  const settings = await openUserSettings(page);
  await expect(settings.getByTestId("settings-nav")).toBeVisible();
  await expect(settings.getByTestId("settings-nav-general")).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(settings.getByRole("heading", { name: "General", exact: true })).toBeVisible();
  await expect(settings.getByRole("heading", { name: "Account", exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "settings-shell-general");

  await settings.getByTestId("settings-nav-models").click();
  await expect(settings).toHaveAttribute("data-settings-section", "models");
  await expect(settings.getByRole("heading", { name: "Models", exact: true })).toBeVisible();
  await expect(settings.getByTestId("model-settings")).toBeVisible();
  await captureScreenshot(page, testInfo, "settings-shell-models");

  await settings.getByTestId("settings-nav-memory").click();
  await expect(settings).toHaveAttribute("data-settings-section", "memory");
  await expect(settings.getByRole("heading", { name: "Memory", exact: true })).toBeVisible();
  await expect(settings.getByTestId("memory-settings")).toBeVisible();
  await captureScreenshot(page, testInfo, "settings-shell-memory");

  await settings.getByTestId("settings-nav-voice").click();
  await expect(settings).toHaveAttribute("data-settings-section", "voice");
  await expect(settings.getByRole("heading", { name: "Voice", exact: true })).toBeVisible();
  await expect(settings.getByTestId("voice-settings")).toBeVisible();
  await captureScreenshot(page, testInfo, "settings-shell-voice");

  await page.getByRole("button", { name: "Close voice settings" }).click();
  await expect(page.getByTestId("user-settings")).toHaveCount(0);

  await openUserSettings(page, "usage");
  await expect(page.getByTestId("user-settings")).toHaveAttribute("data-settings-section", "usage");
  await expect(page.getByTestId("usage-settings")).toBeVisible();
  await captureScreenshot(page, testInfo, "settings-shell-usage");
});

test("Hub accounts retain managed identity controls in the new settings shell", async ({
  page,
}, testInfo) => {
  const email = `hub-settings-${Date.now()}@hub.invalid`;
  await signup(page, `settings-${Date.now()}@example.test`, "password12", "Hub account");
  await completeOnboarding(page);
  await page.route("**/api/auth/get-session*", async (route) => {
    const response = await route.fetch();
    const session = await response.json();
    await route.fulfill({ response, json: { ...session, user: { ...session.user, email } } });
  });
  await page.reload();

  const settings = await openUserSettings(page);
  await expect(settings.getByRole("heading", { name: "Account", exact: true })).toBeVisible();
  await expect(settings.getByText("Hub account", { exact: true })).toBeVisible();
  await expect(settings.getByText(email, { exact: true })).toHaveCount(0);
  await expect(settings.getByRole("heading", { name: "Password", exact: true })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "settings-shell-hub-account");
});
