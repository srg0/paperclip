import express from "express";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

const mockLifecycle = vi.hoisted(() => ({
  load: vi.fn(),
  upgrade: vi.fn(),
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
  pluginLifecycleManager: () => mockLifecycle,
}));

vi.mock("../services/issues.js", () => ({
  issueService: () => mockIssueService,
}));

const mockLoader = {
  getLocalPluginDir: vi.fn(),
  installPlugin: vi.fn(),
  loadManifest: vi.fn(),
};

const ORIGINAL_HMR_LOCAL_PLUGIN_ADMIN = process.env.PAPERCLIP_HMR_LOCAL_PLUGIN_ADMIN;
const ORIGINAL_HMR_LOCAL_PLUGIN_PATHS = process.env.PAPERCLIP_HMR_LOCAL_PLUGIN_PATHS;
const ORIGINAL_PUBLIC_URL = process.env.PAPERCLIP_PUBLIC_URL;

function createApp(actor: any, loader: any = mockLoader) {
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
      loader,
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
    delete process.env.PAPERCLIP_HMR_LOCAL_PLUGIN_ADMIN;
    delete process.env.PAPERCLIP_HMR_LOCAL_PLUGIN_PATHS;
    delete process.env.PAPERCLIP_PUBLIC_URL;
    mockRegistry.getById.mockResolvedValue(null);
    mockRegistry.getByKey.mockResolvedValue({
      id: "plugin-row-1",
      pluginKey: "homio.atlas-bridge",
      packageName: "@homio/atlas-bridge-plugin",
      version: "0.0.145",
      status: "ready",
    });
    mockWorkerManager.call.mockResolvedValue({ ok: true });
    mockLifecycle.upgrade.mockResolvedValue({
      id: "plugin-row-1",
      pluginKey: "homio.atlas-bridge",
      packageName: "@homio/atlas-bridge-plugin",
      version: "0.0.145",
      status: "ready",
    });
    mockIssueService.getById.mockResolvedValue(null);
    mockIssueService.getByIdentifier.mockResolvedValue(null);
    mockIssueService.assertCheckoutOwner.mockResolvedValue({
      id: "issue-1",
      status: "in_progress",
      assigneeAgentId: "agent-1",
      checkoutRunId: "run-1",
    });
  });

  afterEach(() => {
    if (ORIGINAL_HMR_LOCAL_PLUGIN_ADMIN === undefined) delete process.env.PAPERCLIP_HMR_LOCAL_PLUGIN_ADMIN;
    else process.env.PAPERCLIP_HMR_LOCAL_PLUGIN_ADMIN = ORIGINAL_HMR_LOCAL_PLUGIN_ADMIN;
    if (ORIGINAL_HMR_LOCAL_PLUGIN_PATHS === undefined) delete process.env.PAPERCLIP_HMR_LOCAL_PLUGIN_PATHS;
    else process.env.PAPERCLIP_HMR_LOCAL_PLUGIN_PATHS = ORIGINAL_HMR_LOCAL_PLUGIN_PATHS;
    if (ORIGINAL_PUBLIC_URL === undefined) delete process.env.PAPERCLIP_PUBLIC_URL;
    else process.env.PAPERCLIP_PUBLIC_URL = ORIGINAL_PUBLIC_URL;
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

  it("keeps local plugin upgrade board-only unless the HMR local admin contract is enabled", async () => {
    process.env.PAPERCLIP_HMR_LOCAL_PLUGIN_ADMIN = "false";
    const app = createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "agent_jwt",
      runId: "run-1",
    });

    const res = await request(app)
      .post("/api/plugins/homio.atlas-bridge/upgrade")
      .send({
        packageName: "/workspace/projects/paperclip-atlas-bridge/packages/atlas-bridge-plugin",
        isLocalPath: true,
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("HMR local plugin admin is not enabled");
    expect(mockLifecycle.upgrade).not.toHaveBeenCalled();
  });

  it("allows HMR company-scoped agents to upgrade an allowlisted local plugin snapshot", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "paperclip-hmr-plugin-"));
    const sourceRoot = path.join(tempRoot, "projects", "paperclip-atlas-bridge", "packages", "atlas-bridge-plugin");
    const localPluginDir = path.join(tempRoot, "home", ".paperclip", "plugins");
    await mkdir(sourceRoot, { recursive: true });
    await writeFile(path.join(sourceRoot, "worker.js"), "retry_execution\n", { flag: "wx" });

    try {
      process.env.PAPERCLIP_HMR_LOCAL_PLUGIN_ADMIN = "true";
      process.env.PAPERCLIP_HMR_LOCAL_PLUGIN_PATHS = path.join(tempRoot, "projects");
      mockLoader.getLocalPluginDir.mockReturnValue(localPluginDir);

      const app = createApp({
        type: "agent",
        agentId: "agent-1",
        companyId: "company-1",
        source: "agent_jwt",
        runId: "run-1",
      });

      const res = await request(app)
        .post("/api/plugins/homio.atlas-bridge/upgrade")
        .send({
          packageName: sourceRoot,
          isLocalPath: true,
        });

      const expectedSnapshot = path.join(localPluginDir, "homio.atlas-bridge");
      expect(res.status).toBe(200);
      expect(mockLifecycle.upgrade).toHaveBeenCalledWith("plugin-row-1", {
        localPath: expectedSnapshot,
        version: undefined,
      });
      expect(existsSync(expectedSnapshot)).toBe(true);
      await expect(readFile(path.join(expectedSnapshot, "worker.js"), "utf8"))
        .resolves.toContain("retry_execution");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
