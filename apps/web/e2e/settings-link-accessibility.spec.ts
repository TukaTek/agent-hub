import { expect, test } from "@playwright/test";
import { completeOnboarding, openUserSettings, signup } from "./helpers";

test("server integrations settings link preserves link semantics without console errors", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/rpc/bootstrap", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      response,
      json: { json: { ...body.json, me: { ...body.json.me, isDeploymentOwner: true } } },
    });
  });
  await page.route("**/rpc/integrationSetup/get", (route) =>
    route.fulfill({
      json: {
        json: {
          canConfigure: true,
          needsSetup: false,
          providers: [],
          webUrl: "https://example.test/integrations/setup",
        },
      },
    }),
  );
  await signup(page, `settings-link-${Date.now()}@example.test`, "password12", "Settings QA");
  await completeOnboarding(page);
  const settings = await openUserSettings(page);
  const link = settings.getByRole("link", { name: "Server integrations", exact: true });
  await expect(link).toHaveAttribute("href", "/integrations/setup");
  await link.focus();
  await expect(link).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/integrations\/setup$/);
  await expect(
    page.getByRole("heading", { name: "Server integrations", exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});
