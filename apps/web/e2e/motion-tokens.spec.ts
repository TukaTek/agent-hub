import { expect, type Page, test } from "@playwright/test";

const fixture = "/e2e/fixtures/motion-tokens.html";

async function animationNames(page: Page) {
  return page
    .getByTestId("motion-token")
    .evaluateAll((elements) =>
      elements.map((el) => [el.getAttribute("data-animation"), getComputedStyle(el).animationName]),
    );
}

test("motion tokens animate by default and stop under reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto(fixture);
  for (const [token, name] of await animationNames(page)) expect(name).toBe(token);
  await expect(page.getByTestId("motion-token-variant")).toHaveCSS("animation-name", "pop-in");

  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const [, name] of await animationNames(page)) expect(name).toBe("none");
  await expect(page.getByTestId("motion-token-variant")).toHaveCSS("animation-name", "none");
});

test("chat copy sets 15px text on a 1.75 line box", async ({ page }) => {
  await page.goto(fixture);
  const copy = page.locator(".chat-copy");
  await expect(copy).toHaveCSS("font-size", "15px");
  await expect(copy).toHaveCSS("line-height", "26.25px");
  await expect(copy).toHaveCSS("font-family", /^"?cah-chat"?, "Geist Variable"/);
});

test("glass falls back to a solid surface under reduced transparency", async ({ page }) => {
  await page.goto(fixture);
  const glass = page.getByTestId("glass");
  const solidMenu = await page.evaluate(() => {
    const probe = document.createElement("span");
    probe.style.backgroundColor = "var(--menu)";
    document.body.append(probe);
    const color = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return color;
  });
  await expect(glass).toHaveCSS("backdrop-filter", /blur\(28px\)/);
  await expect(glass).not.toHaveCSS("background-color", solidMenu);
  await expect(glass).toHaveCSS("box-shadow", /24px 64px -12px/);

  // emulateMedia has no reduced-transparency option; Chromium takes it through CDP.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-transparency", value: "reduce" }],
  });
  await expect(glass).toHaveCSS("backdrop-filter", "none");
  await expect(glass).toHaveCSS("background-color", solidMenu);
});
