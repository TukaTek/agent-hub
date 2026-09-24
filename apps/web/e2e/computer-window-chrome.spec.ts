import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

test("computer header clears macOS window controls", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await page.setViewportSize({ width: 824, height: 650 });
  await signup(page, `computer-chrome-${stamp}@cortexai-agent-hub.test`, "password12", "Computer");
  await completeOnboarding(page);

  // The browser fixture uses the same renderer; provide only the platform signal
  // before opening the overlay so it renders Electron's native-control spacer.
  await page.evaluate(() => {
    Object.defineProperty(window, "cortexAiAgentHubDesktop", {
      configurable: true,
      value: { platform: "darwin" },
    });
  });

  await page.getByTitle("Agent computer").click();
  await page.getByTestId("computer-preview").hover();
  await page.getByTestId("computer-preview-open").click();

  const chrome = page.getByTestId("computer-chrome");
  await expect(chrome.getByText("Team Computer", { exact: true })).toBeVisible();
  await expect
    .poll(async () => (await chrome.getByText("Team Computer", { exact: true }).boundingBox())?.x)
    .toBeGreaterThan(100);
  await captureScreenshot(page, testInfo, "computer-macos-window-chrome");
});
