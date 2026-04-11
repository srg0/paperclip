import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { actorMiddleware } from "../middleware/auth.js";

function createApp() {
  const app = express();
  app.use(actorMiddleware({} as any, { deploymentMode: "local_trusted" }));
  app.get("/actor", (req, res) => {
    res.json({ runId: req.actor.runId ?? null });
  });
  return app;
}

describe("actorMiddleware run id header handling", () => {
  it("ignores non-uuid x-paperclip-run-id headers", async () => {
    const res = await request(createApp())
      .get("/actor")
      .set("X-Paperclip-Run-Id", "atlas-parallel-visual-proof");

    expect(res.status).toBe(200);
    expect(res.body.runId).toBeNull();
  });

  it("preserves uuid x-paperclip-run-id headers", async () => {
    const runId = "11111111-1111-4111-8111-111111111111";
    const res = await request(createApp()).get("/actor").set("X-Paperclip-Run-Id", runId);

    expect(res.status).toBe(200);
    expect(res.body.runId).toBe(runId);
  });
});
