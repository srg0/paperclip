import fs from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

const SCREENSHOT_DIR = path.resolve(process.cwd(), "output/playwright");

async function saveScreenshot(page: Page, filename: string) {
  await fs.mkdir(SCREENSHOT_DIR, { recursive: true });
  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, filename),
    fullPage: true,
  });
}

test.describe("Issue conversation UX lab", () => {
  test("renders the Codex-style issue surface and slash palette", async ({ page }) => {
    await page.goto("/tests/ux/issues");

    await expect(page.getByRole("heading", { name: "Issue Conversation Surface" })).toBeVisible();
    await expect(page.getByText("Current Panels").nth(0)).toBeVisible();
    await saveScreenshot(page, "issue-conversation-overview.png");

    const composer = page.locator('.paperclip-mdxeditor [contenteditable="true"]').first();
    await composer.click();
    await composer.pressSequentially("/m");

    await expect(page.getByText("/mr Create Merge Request")).toBeVisible();
    await expect(page.getByText("/mention Mention Agent Or Project")).toBeVisible();
    await saveScreenshot(page, "issue-conversation-slash-palette.png");

    await page.getByRole("button", { name: "brief" }).first().click();
    await expect(page.getByText("Healthy tasks stay short.").nth(0)).toBeVisible();
    await page.getByRole("heading", { name: "Running / Projection Stale" }).scrollIntoViewIfNeeded();
    await saveScreenshot(page, "issue-conversation-brief-running.png");

    await page.getByRole("button", { name: "debug" }).first().click();
    await expect(page.getByText("Noisy tasks expose more internal bundles.").nth(0)).toBeVisible();
    await page.getByRole("heading", { name: "Failed / Follow-up Needed" }).scrollIntoViewIfNeeded();
    await saveScreenshot(page, "issue-conversation-debug-failed.png");
  });
});
