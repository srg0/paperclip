import { describe, expect, it } from "vitest";
import {
  appendStderrExcerpt,
  buildWorkerEnvironment,
  formatWorkerFailureMessage,
} from "../services/plugin-worker-manager.js";

describe("plugin-worker-manager stderr failure context", () => {
  it("appends worker stderr context to failure messages", () => {
    expect(
      formatWorkerFailureMessage(
        "Worker process exited (code=1, signal=null)",
        "TypeError: Unknown file extension \".ts\"",
      ),
    ).toBe(
      "Worker process exited (code=1, signal=null)\n\nWorker stderr:\nTypeError: Unknown file extension \".ts\"",
    );
  });

  it("does not duplicate stderr that is already present", () => {
    const message = [
      "Worker process exited (code=1, signal=null)",
      "",
      "Worker stderr:",
      "TypeError: Unknown file extension \".ts\"",
    ].join("\n");

    expect(
      formatWorkerFailureMessage(message, "TypeError: Unknown file extension \".ts\""),
    ).toBe(message);
  });

  it("keeps only the latest stderr excerpt", () => {
    let excerpt = "";
    excerpt = appendStderrExcerpt(excerpt, "first line");
    excerpt = appendStderrExcerpt(excerpt, "second line");

    expect(excerpt).toContain("first line");
    expect(excerpt).toContain("second line");

    excerpt = appendStderrExcerpt(excerpt, "x".repeat(9_000));

    expect(excerpt).not.toContain("first line");
    expect(excerpt).not.toContain("second line");
    expect(excerpt.length).toBeLessThanOrEqual(8_000);
  });

  it("passes through only the allowlisted GitLab env required by bridge workers", () => {
    const workerEnv = buildWorkerEnvironment(
      "homio.atlas-bridge",
      { CUSTOM_KEY: "custom-value" },
      {
        PATH: "/usr/bin",
        NODE_PATH: "/app/node_modules",
        NODE_ENV: "production",
        TZ: "Asia/Bangkok",
        GITLAB_BASE_URL: "https://gitlab.example.com",
        GITLAB_TOKEN: "secret-token",
        GITLAB_PROJECT_PATH: "homio/core",
        MR_TARGET_BRANCH: "main",
        DATABASE_URL: "postgres://should-not-leak",
      },
    );

    expect(workerEnv).toMatchObject({
      CUSTOM_KEY: "custom-value",
      PAPERCLIP_PLUGIN_ID: "homio.atlas-bridge",
      PATH: "/usr/bin",
      NODE_PATH: "/app/node_modules",
      NODE_ENV: "production",
      TZ: "Asia/Bangkok",
      GITLAB_BASE_URL: "https://gitlab.example.com",
      GITLAB_TOKEN: "secret-token",
      GITLAB_PROJECT_PATH: "homio/core",
      MR_TARGET_BRANCH: "main",
    });
    expect(workerEnv).not.toHaveProperty("DATABASE_URL");
  });
});
