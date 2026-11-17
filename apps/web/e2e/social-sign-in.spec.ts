import { expect, test } from "@playwright/test";
import { socialPresentation } from "../../../packages/auth/src/social-presentation";
import { captureScreenshot, completeOnboarding, openUserSettings, signup } from "./helpers";

// The fork keeps its own email-first sign-in page, which has no provider chooser, so upstream's
// chooser tests are not carried. What remains covers a linked social account in settings.

const passwordOnly = {
  passwordAuth: true,
  sso: null,
  passwordReset: true,
  resetUrl: "http://127.0.0.1:5173/reset-password",
  providers: [] as { id: string; name: string }[],
};

const both = [
  { id: "google", name: "Google", presentation: socialPresentation("google") },
  { id: "apple", name: "Apple", presentation: socialPresentation("apple") },
];

test("linked social accounts use a supported deletion confirmation method", async ({
  page,
}, testInfo) => {
  await signup(
    page,
    `social-confirmation-${Date.now()}@cortexai-agent-hub.test`,
    "password12",
    "Confirmation QA",
  );
  await completeOnboarding(page);
  await page.route("**/api/auth/capabilities", (route) =>
    route.fulfill({ json: { ...passwordOnly, providers: both } }),
  );
  await page.route("**/api/auth/account-security", (route) =>
    route.fulfill({
      json: {
        hasPassword: false,
        freshOidcAuth: false,
        ssoLinked: false,
        sso: null,
        emailDeletion: true,
        linkedProviderIds: ["google", "apple"],
        // An older in-flight server must not restore unsupported confirmation choices.
        reauthenticationProviders: both,
      },
    }),
  );
  const settings = await openUserSettings(page);
  await settings.getByTestId("delete-account").click();
  await expect(
    settings.getByRole("button", { name: "Send deletion code", exact: true }),
  ).toBeVisible();
  await expect(settings.getByRole("button", { name: "Sign in again", exact: true })).toHaveCount(0);
  await expect(
    settings.getByRole("button", { name: "Continue with Google", exact: true }),
  ).toHaveCount(0);
  await expect(
    settings.getByRole("button", { name: "Continue with Apple", exact: true }),
  ).toHaveCount(0);
  await captureScreenshot(page, testInfo, "social-account-deletion-confirmation");
});
