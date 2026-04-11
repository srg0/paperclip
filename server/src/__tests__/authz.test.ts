import { describe, expect, it } from "vitest";
import { getActorInfo } from "../routes/authz.js";

describe("getActorInfo", () => {
  it("drops non-uuid run ids before route logging uses them", () => {
    const req = {
      actor: {
        type: "board",
        userId: "board-user",
        runId: "atlas-parallel-visual-proof",
      },
    } as any;

    expect(getActorInfo(req)).toEqual({
      actorType: "user",
      actorId: "board-user",
      agentId: null,
      runId: null,
    });
  });

  it("preserves uuid run ids", () => {
    const runId = "11111111-1111-4111-8111-111111111111";
    const req = {
      actor: {
        type: "board",
        userId: "board-user",
        runId,
      },
    } as any;

    expect(getActorInfo(req)).toEqual({
      actorType: "user",
      actorId: "board-user",
      agentId: null,
      runId,
    });
  });
});
