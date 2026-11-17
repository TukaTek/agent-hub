import { expect, test } from "@playwright/test";
import {
  activeBotId,
  captureScreenshot,
  completeOnboarding,
  openBotPanel,
  rpc,
  signup,
} from "./helpers";

test("Open work in the bot panel collapses a long list and remembers the choice", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `open-work-${stamp}@example.com`, "password123", "Open Work Owner");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  for (let index = 1; index <= 12; index += 1) {
    await rpc(page, "scratchpad/create", { botId, title: `Follow up on task ${index}` });
  }

  await openBotPanel(page);
  const openWork = page.getByTestId("bot-settings").getByTestId("bot-scratchpad");
  const header = openWork.getByRole("button", { name: /Open work/ });
  await expect(header).toHaveText(/Open work\s*\(12\)/);
  await expect(header).toHaveAttribute("aria-expanded", "false");
  await expect(openWork.getByTestId("bot-scratchpad-item")).toHaveCount(0);
  await header.scrollIntoViewIfNeeded();
  await captureScreenshot(page, testInfo, "open-work-collapsed");

  await header.click();
  await expect(header).toHaveAttribute("aria-expanded", "true");
  await expect(openWork.getByTestId("bot-scratchpad-item")).toHaveCount(12);
  const list = openWork.getByTestId("bot-scratchpad-list");
  expect(await list.evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true);
  await header.scrollIntoViewIfNeeded();
  await captureScreenshot(page, testInfo, "open-work-expanded");

  // After a reload the bot panel shows Open work still expanded.
  await page.reload();
  await openBotPanel(page);
  await expect(
    page.getByTestId("bot-scratchpad").getByRole("button", { name: /Open work/ }),
  ).toHaveAttribute("aria-expanded", "true");
});
