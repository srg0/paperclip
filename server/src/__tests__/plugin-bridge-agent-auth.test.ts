import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { pluginRoutes } from "../routes/plugins.js";

const mockRegistry = vi.hoisted(() => ({
  getById: vi.fn(),
  getByKey: vi.fn(),
  listInstalled: vi.fn(),
  listByStatus: vi.fn(),
}));

const mockWorkerManager = vi.hoisted(() => ({
  call: vi.fn(),
}));

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  getByIdentifier: vi.fn(),
  assertCheckoutOwner: vi.fn(),
}));

vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => mockRegistry,
}));

vi.mock("../services/plugin-lifecycle.js", () => ({
  pluginLifecycleManager: () => ({}),
}));

vi.mock("../services/issues.js", () => ({
  issueService: () => mockIssueService,
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
    mockIssueService.getById.mockResolvedValue(null);
    mockIssueService.getByIdentifier.mockResolvedValue(null);
    mockIssueService.assertCheckoutOwner.mockResolvedValue({
      id: "issue-1",
      status: "in_progress",
      assigneeAgentId: "agent-1",
      checkoutRunId: "run-1",
    });
  });

  it("allows company-scoped agents to discover installed plugins without management-only fields", async () => {
    const installedAt = new Date("2026-06-29T00:00:00.000Z");
    const updatedAt = new Date("2026-06-29T00:10:00.000Z");
    mockRegistry.listInstalled.mockResolvedValue([
      {
        id: "plugin-row-1",
        pluginKey: "homio.atlas-bridge",
        packageName: "@homio/atlas-bridge-plugin",
        version: "0.0.144",
        apiVersion: 1,
        categories: ["automation"],
        manifestJson: { id: "homio.atlas-bridge", version: "0.0.144" },
        status: "ready",
        installOrder: 1,
        packagePath: "/private/path",
        lastError: "operator-only detail",
        installedAt,
        updatedAt,
      },
    ]);

    const app = createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "agent_jwt",
      runId: "run-1",
    });

    const res = await request(app).get("/api/plugins?limit=100");

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      {
        id: "plugin-row-1",
        pluginKey: "homio.atlas-bridge",
        packageName: "@homio/atlas-bridge-plugin",
        version: "0.0.144",
        apiVersion: 1,
        categories: ["automation"],
        manifestJson: { id: "homio.atlas-bridge", version: "0.0.144" },
        status: "ready",
        installOrder: 1,
        installedAt: installedAt.toISOString(),
        updatedAt: updatedAt.toISOString(),
      },
    ]);
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

  it("allows checked-out agents to run stand deploy without top-level companyId", async () => {
    mockIssueService.getById.mockResolvedValue({
      id: "issue-1",
      companyId: "company-1",
      status: "in_progress",
      assigneeAgentId: "agent-1",
    });
    const app = createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "agent_jwt",
      runId: "run-1",
    });

    const res = await request(app)
      .post("/api/plugins/homio.atlas-bridge/actions/atlas-bridge-run-stand-deploy-request")
      .send({
        params: {
          issueId: "issue-1",
          request: {
            issueId: "AGR-145",
            project: "agrobazar",
            stand: "ai-hmr",
          },
        },
      });

    expect(res.status).toBe(200);
    expect(mockIssueService.assertCheckoutOwner).toHaveBeenCalledWith("issue-1", "agent-1", "run-1");
    expect(mockWorkerManager.call).toHaveBeenCalledWith("plugin-row-1", "performAction", {
      key: "atlas-bridge-run-stand-deploy-request",
      params: {
        issueId: "issue-1",
        companyId: "company-1",
        request: {
          issueId: "AGR-145",
          project: "agrobazar",
          stand: "ai-hmr",
        },
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
