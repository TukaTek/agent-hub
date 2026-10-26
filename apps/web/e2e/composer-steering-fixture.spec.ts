import { expect, test } from "@playwright/test";

const fixture = "/e2e/fixtures/composer-steering.html";

for (const theme of ["light", "dark"] as const) {
  for (const state of ["idle", "running", "queued"] as const) {
    test(`composer ${state} in ${theme}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width: 760, height: 260 });
      await page.goto(`${fixture}?${new URLSearchParams({ state, theme })}`);
      await expect(page.getByRole("combobox", { name: "Message Chief" })).toBeVisible();
      const path = testInfo.outputPath(`composer-${state}-${theme}.png`);
      await page.screenshot({ path, animations: "disabled", caret: "hide" });
      await testInfo.attach(`composer-${state}-${theme}`, { path, contentType: "image/png" });
    });
  }
}
