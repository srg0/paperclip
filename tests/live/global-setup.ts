import fs from "node:fs/promises";
import path from "node:path";
import { chromium, type FullConfig } from "@playwright/test";
import { loadLocalLiveEnv } from "./env";

loadLocalLiveEnv();

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required env ${name} for browser-first live auth.`);
  }
  return value;
}

async function ensureSignedIn(baseURL: string, statePath: string) {
  const email = requireEnv("PAPERCLIP_LIVE_EMAIL");
  const password = requireEnv("PAPERCLIP_LIVE_PASSWORD");
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    await page.goto(baseURL, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle").catch(() => {});

    if (/\/auth(?:\/|$)/.test(new URL(page.url()).pathname)) {
      await page.locator('input[type="email"]').fill(email);
      await page.locator('input[type="password"]').fill(password);
      await page.getByRole("button", { name: "Sign In" }).click();
    }

    await page.waitForURL((url) => !/\/auth(?:\/|$)/.test(url.pathname), { timeout: 30_000 });

    const session = await page.evaluate(async () => {
      const res = await fetch("/api/auth/get-session", { credentials: "include" });
      const body = await res.json().catch(() => null);
      return {
        status: res.status,
        sessionId: typeof body?.session?.id === "string" ? body.session.id : null,
        body,
      };
    });

    if (session.status !== 200 || !session.sessionId?.startsWith("paperclip:session:")) {
      throw new Error(`Live auth setup failed: ${JSON.stringify(session)}`);
    }

    await fs.mkdir(path.dirname(statePath), { recursive: true });
    await page.context().storageState({ path: statePath });
  } finally {
    await browser.close();
  }
}

export default async function globalSetup(config: FullConfig) {
  const baseURL = config.projects[0]?.use?.baseURL;
  const statePath = process.env.PAPERCLIP_LIVE_STORAGE_STATE
    ?? path.resolve(process.cwd(), "output/playwright-live/live-session-state.json");

  if (process.env.PAPERCLIP_LIVE_STORAGE_STATE) {
    return;
  }

  if (typeof baseURL !== "string" || !baseURL) {
    throw new Error("Missing baseURL for live Playwright global setup.");
  }

  await ensureSignedIn(baseURL, statePath);
}
