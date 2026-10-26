import { expect, type Page, type TestInfo, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

const STEER = "Use the newer report and keep it short.";

async function captureBothThemes(page: Page, testInfo: TestInfo, name: string) {
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await expect(page.locator("html")).toHaveAttribute("data-theme", colorScheme);
    await captureScreenshot(page, testInfo, `${name}-${colorScheme}`);
  }
}

test("a message sent into a running turn waits as queued until the run takes it", async ({
  page,
}, testInfo) => {
  await signup(page, `composer-steering-${Date.now()}@example.test`, "password12", "Demo");
  await completeOnboarding(page);
  const composer = page.getByRole("combobox", { name: "Message Chief" });
  const transcript = page.getByTestId("transcript");
  const send = page.getByRole("button", { name: "Send", exact: true });
  const stop = page.getByRole("button", { name: "Stop", exact: true });
  const queued = page.getByTestId("composer-queued");
  // Any first-run intro holds sends for later instead of taking steering; start from idle.
  await expect(stop).toHaveCount(0, { timeout: 30_000 });
  await captureBothThemes(page, testInfo, "composer-steering-idle");

  // The scripted runtime holds this turn open, then a continuation takes the steering message.
  await composer.fill("work for 10 seconds");
  await composer.press("Enter");
  await expect(stop).toBeVisible({ timeout: 30_000 });
  await expect(composer).toHaveAttribute(
    "placeholder",
    "Chief is working — Enter sends this into the running turn",
  );
  await expect(send).toHaveCount(0);
  await captureBothThemes(page, testInfo, "composer-steering-running");

  const steerRequest = page.waitForRequest(
    (request) =>
      request.url().includes("/rpc/threads/send") && (request.postData() ?? "").includes(STEER),
  );
  await composer.fill(STEER);
  await expect(send).toBeVisible();
  await composer.press("Enter");
  await steerRequest;
  await expect(queued).toContainText("Queued");
  await expect(queued).toContainText(STEER);
  await expect(transcript.getByText(STEER)).toHaveCount(0);
  await captureBothThemes(page, testInfo, "composer-steering-queued");

  await expect(queued).toHaveCount(0, { timeout: 60_000 });
  // The scripted reply echoes the prompt, so look for the steering text in the user bubble.
  await expect(
    transcript.getByTestId("message-user-bubble").filter({ hasText: STEER }),
  ).toBeVisible();
});

test("Stop cancels the running turn and returns the composer to idle", async ({
  page,
}, testInfo) => {
  await signup(page, `composer-stop-${Date.now()}@example.test`, "password12", "Demo");
  await completeOnboarding(page);
  const composer = page.getByRole("combobox", { name: "Message Chief" });
  const stop = page.getByRole("button", { name: "Stop", exact: true });
  await expect(stop).toHaveCount(0, { timeout: 30_000 });

  await composer.fill("keep working until I stop you");
  await composer.press("Enter");
  await expect(stop).toBeVisible({ timeout: 30_000 });
  await composer.fill("Also check the appendix.");
  await composer.press("Enter");
  await expect(page.getByTestId("composer-queued")).toContainText("Also check the appendix.");

  const stopRequest = page.waitForRequest((request) => request.url().includes("/rpc/threads/stop"));
  await stop.click();
  await stopRequest;
  await expect(stop).toHaveCount(0, { timeout: 30_000 });
  await expect(composer).toHaveAttribute("placeholder", "Message Chief");
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
  await expect(page.getByTestId("composer-queued")).toHaveCount(0);
  // Stop drops pending steering, so the queued text stays as a plain message.
  await expect(
    page
      .getByTestId("transcript")
      .getByTestId("message-user-bubble")
      .filter({ hasText: "Also check the appendix." }),
  ).toBeVisible();
  await captureScreenshot(page, testInfo, "composer-steering-stopped");
});
