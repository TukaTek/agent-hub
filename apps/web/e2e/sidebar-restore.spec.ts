import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

test("collapsed sidebar has a visible restore button that survives reload", async ({
  page,
}, testInfo) => {
  await signup(page, `sidebar-restore-${Date.now()}@example.test`, "password12", "Sidebar QA");
  await completeOnboarding(page);
  const sidebar = page.getByTestId("bots-sidebar");
  const restore = page.getByTestId("restore-bots-sidebar");
  await expect(restore).toHaveCount(0);
  await page.getByTestId("minimize-bots-sidebar").click();
  await expect(sidebar).toHaveAttribute("data-collapsed", "true");
  await expect(restore).toBeVisible();
  await expect(restore).toHaveAccessibleName("Show bots");
  await captureScreenshot(page, testInfo, "sidebar-visible-restore");
  await page.reload();
  await expect(sidebar).toHaveAttribute("data-collapsed", "true");
  await expect(restore).toBeVisible();
  await restore.focus();
  await page.keyboard.press("Enter");
  await expect(sidebar).toHaveAttribute("data-collapsed", "false");
  await expect(page.getByTestId("create-menu-trigger")).toBeVisible();
  await expect(restore).toHaveCount(0);
  await page.reload();
  await expect(sidebar).toHaveAttribute("data-collapsed", "false");
  await page.getByTestId("minimize-bots-sidebar").click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(restore).toBeHidden();
  await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  await expect(page.getByTestId("create-menu-trigger")).toBeVisible();
});
