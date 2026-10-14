import { expect, test } from "@playwright/test";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

// The tint2 dock in 1280x800 framebuffer pixels; desktop_smoke.py asserts the real window.
const DOCK = { x: 10, y: 340, width: 64, height: 120 };
const VIEWPORTS = [
  [1920, 1080],
  [1440, 900],
  [1366, 768],
  [1280, 800],
  [1024, 768],
  [768, 1024],
  [390, 844],
  [844, 390],
] as const;

test("the computer overlay toolbar never covers the desktop dock", async ({ page }, testInfo) => {
  await signup(page, `dock-${Date.now()}@cortexai-agent-hub.test`, "password12", "Dock");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  await rpc(page, "computer/boot", { botId });
  await expect(rpc<{ state: string }>(page, "computer/status", { botId })).resolves.toMatchObject({
    state: "running",
  });

  // A real desktop capture, scaled and centered the way noVNC's scaleViewport draws it.
  await page.route("https://screen.example/desktop.png", (route) =>
    route.fulfill({
      path: new URL("./fixtures/computer-desktop-idle.png", import.meta.url).pathname,
    }),
  );
  await page.route("https://screen.example/vnc.html", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Test desktop</title><body style='margin:0;height:100vh;background:#000'><img alt='' src='https://screen.example/desktop.png' style='display:block;width:100%;height:100%;object-fit:contain'>",
    }),
  );
  await page.route("**/rpc/computer/screenUrl", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ json: { url: "https://screen.example/vnc.html" } }),
    }),
  );
  await page.getByTitle("Agent computer").click();
  const preview = page.getByTestId("computer-preview");
  await preview.hover();
  await preview.getByTestId("computer-preview-open").click();
  await expect(page.getByRole("button", { name: "Close computer" })).toBeVisible();

  const screen = page.getByTitle("Assistant screen");
  await expect
    .poll(() =>
      page
        .frameLocator('iframe[title="Assistant screen"]')
        .locator("img")
        .evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth),
    )
    .toBe(1280);
  const toolbar = page
    .locator("nav")
    .filter({ has: page.getByRole("button", { name: "Files", exact: true }) });

  for (const [width, height] of VIEWPORTS) {
    await page.setViewportSize({ width, height });
    await expect(toolbar).toBeVisible();
    const frame = (await screen.boundingBox())!;
    const bar = (await toolbar.boundingBox())!;
    const scale = Math.min(frame.width / 1280, frame.height / 800);
    const dock = {
      x: frame.x + (frame.width - 1280 * scale) / 2 + DOCK.x * scale,
      y: frame.y + (frame.height - 800 * scale) / 2 + DOCK.y * scale,
      width: DOCK.width * scale,
      height: DOCK.height * scale,
    };
    await captureScreenshot(page, testInfo, `computer-dock-${width}x${height}`);
    const overlaps =
      bar.x < dock.x + dock.width &&
      dock.x < bar.x + bar.width &&
      bar.y < dock.y + dock.height &&
      dock.y < bar.y + bar.height;
    expect.soft(overlaps, `toolbar covers the dock at ${width}x${height}`).toBe(false);
  }
});
