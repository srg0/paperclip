import { describe, expect, it, vi } from "vitest";
import { execute } from "../adapters/process/execute.js";
import { processAdapter } from "../adapters/process/index.js";

describe("process adapter", () => {
  it("supports local agent jwt injection", () => {
    expect(processAdapter.supportsLocalAgentJwt).toBe(true);
  });

  it("injects PAPERCLIP_API_KEY and redacts it in adapter metadata", async () => {
    const onMeta = vi.fn();
    const result = await execute({
      runId: "run-1",
      agent: {
        id: "agent-1",
        companyId: "company-1",
      } as any,
      config: {
        command: "/bin/sh",
        args: ["-lc", "printf '%s|%s|%s' \"$PAPERCLIP_API_KEY\" \"$PAPERCLIP_RUN_ID\" \"$PAPERCLIP_TASK_ID\""],
      },
      context: {
        issueId: "issue-1",
        wakeReason: "issue_assigned",
      },
      onLog: async () => {},
      onMeta,
      authToken: "jwt-token-value",
      runtime: {} as any,
    });

    expect(result.exitCode ?? 0).toBe(0);
    expect(result.resultJson?.stdout).toContain("jwt-token-value|run-1|issue-1");
    expect(onMeta).toHaveBeenCalledTimes(1);
    expect(onMeta.mock.calls[0]?.[0]?.env).toMatchObject({
      PAPERCLIP_API_KEY: "***REDACTED***",
      PAPERCLIP_RUN_ID: "run-1",
      PAPERCLIP_TASK_ID: "issue-1",
      PAPERCLIP_WAKE_REASON: "issue_assigned",
    });
  });
});
