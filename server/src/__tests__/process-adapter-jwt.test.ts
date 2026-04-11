import { describe, expect, it } from "vitest";
import { processAdapter } from "../adapters/process/index.js";

describe("process adapter", () => {
  it("supports local agent jwt injection", () => {
    expect(processAdapter.supportsLocalAgentJwt).toBe(true);
  });
});
