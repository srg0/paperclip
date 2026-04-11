import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { pluginRoutes } from "../routes/plugins.js";

const mockRegistry = vi.hoisted(() => ({
  getById: vi.fn(),
  getByKey: vi.fn(),
}));

const mockWorkerManager = vi.hoisted(() => ({
  call: vi.fn(),
}));

vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => mockRegistry,
}));

vi.mock("../services/plugin-lifecycle.js", () => ({
  pluginLifecycleManager: () => ({}),
}));

function createApp(actor: any) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use(
    "/api",
    pluginRoutes(
      {} as any,
      {} as any,
      undefined,
      undefined,
      undefined,
      { workerManager: mockWorkerManager } as any,
    ),
  );
  app.use(errorHandler);
  return app;
}

describe("plugin bridge agent access", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRegistry.getById.mockResolvedValue(null);
    mockRegistry.getByKey.mockResolvedValue({
      id: "plugin-row-1",
      pluginKey: "homio.atlas-bridge",
      status: "ready",
    });
    mockWorkerManager.call.mockResolvedValue({ ok: true });
  });

  it("allows company-scoped agents to call plugin action routes", async () => {
    const app = createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "agent_jwt",
      runId: "run-1",
    });

    const res = await request(app)
      .post("/api/plugins/homio.atlas-bridge/actions/atlas-bridge-sync-issue-projection")
      .send({
        companyId: "company-1",
        params: { issueId: "issue-1", reason: "atlas_executor_prelaunch" },
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { ok: true } });
    expect(mockWorkerManager.call).toHaveBeenCalledWith("plugin-row-1", "performAction", {
      key: "atlas-bridge-sync-issue-projection",
      params: { issueId: "issue-1", reason: "atlas_executor_prelaunch" },
      renderEnvironment: null,
    });
  });

  it("allows company-scoped agents to call plugin data routes", async () => {
    const app = createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "agent_jwt",
      runId: "run-1",
    });

    const res = await request(app)
      .post("/api/plugins/homio.atlas-bridge/data/atlas-bridge-issue-execution")
      .send({
        companyId: "company-1",
        params: { issueId: "issue-1" },
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { ok: true } });
    expect(mockWorkerManager.call).toHaveBeenCalledWith("plugin-row-1", "getData", {
      key: "atlas-bridge-issue-execution",
      params: { issueId: "issue-1" },
      renderEnvironment: null,
    });
  });

  it("allows legacy agent bridge calls when companyId is nested inside params", async () => {
    const app = createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "agent_jwt",
      runId: "run-1",
    });

    const res = await request(app)
      .post("/api/plugins/homio.atlas-bridge/actions/atlas-bridge-sync-issue-projection")
      .send({
        params: {
          companyId: "company-1",
          issueId: "issue-1",
          reason: "atlas_executor_prelaunch",
        },
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { ok: true } });
    expect(mockWorkerManager.call).toHaveBeenCalledWith("plugin-row-1", "performAction", {
      key: "atlas-bridge-sync-issue-projection",
      params: {
        companyId: "company-1",
        issueId: "issue-1",
        reason: "atlas_executor_prelaunch",
      },
      renderEnvironment: null,
    });
  });

  it("rejects agent bridge calls without companyId", async () => {
    const app = createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "agent_jwt",
      runId: "run-1",
    });

    const res = await request(app)
      .post("/api/plugins/homio.atlas-bridge/actions/atlas-bridge-sync-issue-projection")
      .send({
        params: { issueId: "issue-1", reason: "atlas_executor_prelaunch" },
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("companyId is required for agent bridge access");
    expect(mockWorkerManager.call).not.toHaveBeenCalled();
  });
});
