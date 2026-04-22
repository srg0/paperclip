import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { StorageState } from "@playwright/test";

const DEFAULT_AUTH_STORE = path.join(os.homedir(), ".paperclip", "auth.json");
// Keep these in sync with ui/src/api/client.ts.
const BROWSER_BOARD_API_TOKEN_STORAGE_KEY = "paperclip.live.boardApiToken";
const BROWSER_BOARD_API_TOKEN_MODE_STORAGE_KEY = "paperclip.live.useBoardToken";

type PaperclipAuthStore = {
  credentials?: Record<string, { token?: string; apiBase?: string }>;
};

function normalizeBaseUrl(baseUrl: string) {
  return baseUrl.trim().replace(/\/+$/, "");
}

export function loadLiveBoardToken(baseUrl: string): string {
  const explicitToken = process.env.PAPERCLIP_LIVE_BOARD_TOKEN?.trim();
  if (explicitToken) return explicitToken;

  const authStorePath = process.env.PAPERCLIP_AUTH_STORE?.trim() || DEFAULT_AUTH_STORE;
  const raw = fs.readFileSync(authStorePath, "utf8");
  const authStore = JSON.parse(raw) as PaperclipAuthStore;
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  const credential = authStore.credentials?.[normalizedBaseUrl];
  const token = credential?.token?.trim();
  if (!token) {
    throw new Error(`No board token for ${normalizedBaseUrl} in ${authStorePath}`);
  }
  return token;
}

export function buildLiveBoardTokenStorageState(baseUrl: string, token: string): StorageState {
  return {
    cookies: [],
    origins: [
      {
        origin: new URL(baseUrl).origin,
        localStorage: [
          { name: BROWSER_BOARD_API_TOKEN_MODE_STORAGE_KEY, value: "1" },
          { name: BROWSER_BOARD_API_TOKEN_STORAGE_KEY, value: token },
        ],
      },
    ],
  };
}
