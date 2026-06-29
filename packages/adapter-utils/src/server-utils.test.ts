import { describe, expect, it } from "vitest";
import { runChildProcess } from "./server-utils.js";

async function waitForProcessExit(pid: number, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ESRCH") return true;
      throw err;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

describe("runChildProcess", () => {
  it.skipIf(process.platform === "win32")(
    "cleans up grandchildren left behind by a completed adapter command",
    async () => {
      let grandchildPid: number | null = null;
      try {
        const script = `
          const { spawn } = require("node:child_process");
          const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
            stdio: "ignore",
          });
          console.log(child.pid);
          setTimeout(() => process.exit(0), 50);
        `;

        const result = await runChildProcess("process-group-cleanup-test", process.execPath, ["-e", script], {
          cwd: process.cwd(),
          env: {},
          timeoutSec: 0,
          graceSec: 1,
          onLog: async () => {},
        });

        expect(result.exitCode).toBe(0);
        grandchildPid = Number(result.stdout.trim());
        expect(Number.isInteger(grandchildPid)).toBe(true);
        expect(await waitForProcessExit(grandchildPid)).toBe(true);
      } finally {
        if (grandchildPid) {
          try {
            process.kill(grandchildPid, "SIGKILL");
          } catch {
            // Best-effort cleanup only; the assertion above verifies the intended path.
          }
        }
      }
    },
  );
});
