import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";
import { loadLocalLiveEnv } from "./env";

loadLocalLiveEnv();

const BASE_URL = process.env.PAPERCLIP_LIVE_BASE_URL ?? "https://org.homio.pro";
const TESTS_LIVE_DIR = path.dirname(fileURLToPath(import.meta.url));
const STORAGE_STATE = process.env.PAPERCLIP_LIVE_STORAGE_STATE
  ?? path.resolve(process.cwd(), "output/playwright-live/live-session-state.json");

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.ts",
  timeout: 120_000,
  globalSetup: path.resolve(TESTS_LIVE_DIR, "./global-setup.ts"),
  expect: {
    timeout: 15_000,
  },
  retries: 0,
  use: {
    baseURL: BASE_URL,
    storageState: STORAGE_STATE,
    headless: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
    },
  ],
  outputDir: "./test-results",
  reporter: [["list"], ["html", { open: "never", outputFolder: "./playwright-report" }]],
});
