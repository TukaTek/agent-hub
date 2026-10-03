import { expect, type Page, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, provisionAndSignIn } from "./helpers";

test.describe.configure({ mode: "serial" });

const OFFICE_FILES = ["report.xlsx", "brief.docx", "deck.pptx"];

async function openChat(page: Page, label: string) {
  const stamp = Date.now();
  await provisionAndSignIn(
    page,
    `${label}-${stamp}@cortexai-agent-hub.test`,
    "password12",
    "Office Files",
  );
  await completeOnboarding(page);
  const composer = page.getByPlaceholder(/Message/);
  await expect(composer).toBeVisible();
  return composer;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("bot-attached Office files download from download-only cards", async ({ page }, testInfo) => {
  const composer = await openChat(page, "office-bot");

  for (const name of OFFICE_FILES) {
    await composer.fill(`write path notes/${name} and attach it to the thread says hi`);
    await page.keyboard.press("Enter");

    const card = page.getByRole("button", { name: new RegExp(`^${escapeRegExp(name)} \\d`) });
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("button", { name: `Preview ${name}` })).toHaveCount(0);

    const downloadPromise = page.waitForEvent("download");
    await card.click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe(name);
  }
  await captureScreenshot(page, testInfo, "office-file-cards");
});

test("users can upload Office files and zip archives", async ({ page }, testInfo) => {
  const composer = await openChat(page, "office-upload");
  const fileInput = page.locator('input[type="file"]');
  const uploads = [
    { name: "report.xlsx", mimeType: "" },
    { name: "brief.docx", mimeType: "application/octet-stream" },
    {
      name: "deck.pptx",
      mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    },
    { name: "bundle.zip", mimeType: "application/x-zip-compressed" },
  ];
  await fileInput.setInputFiles(
    uploads.map(({ name, mimeType }) => ({
      name,
      mimeType,
      buffer: Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    })),
  );
  for (const { name } of uploads) {
    await expect(page.getByRole("button", { name: `Remove ${name}` })).toBeVisible();
  }
  await captureScreenshot(page, testInfo, "office-upload-pending");

  await composer.fill("please review these");
  await page.keyboard.press("Enter");
  for (const { name } of uploads) {
    await expect(
      page.getByRole("button", { name: new RegExp(`^${escapeRegExp(name)} \\d`) }),
    ).toBeVisible({ timeout: 30_000 });
  }
  await captureScreenshot(page, testInfo, "office-upload-sent");
});

test("unsupported uploads are skipped with a clear reason and no link", async ({
  page,
}, testInfo) => {
  await openChat(page, "office-unsupported");
  await page.locator('input[type="file"]').setInputFiles({
    name: "macro.xlsm",
    mimeType: "application/vnd.ms-excel.sheet.macroEnabled.12",
    buffer: Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  });
  const notice = page.getByText("Skipped macro.xlsm (unsupported type)");
  await expect(notice).toBeVisible();
  await expect(notice.locator("a")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Remove macro.xlsm" })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "office-upload-unsupported");
});
