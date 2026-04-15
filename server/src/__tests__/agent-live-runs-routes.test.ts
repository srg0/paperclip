import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentRoutes } from "../routes/agents.js";
import { errorHandler } from "../middleware/index.js";

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockApprovalService = vi.hoisted(() => ({}));
const mockBudgetService = vi.hoisted(() => ({}));
const mockHeartbeatService = vi.hoisted(() => ({}));
const mockIssueApprovalService = vi.hoisted(() => ({}));
const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  getByIdentifier: vi.fn(),
}));
const mockSecretService = vi.hoisted(() => ({}));
const mockAgentInstructionsService = vi.hoisted(() => ({}));
const mockCompanySkillService = vi.hoisted(() => ({}));
const mockWorkspaceOperationService = vi.hoisted(() => ({}));
const mockDocumentService = vi.hoisted(() => ({
  getIssueDocumentByKey: vi.fn(),
}));
const mockInstanceSettingsService = vi.hoisted(() => ({
  getGeneral: vi.fn(),
}));
const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  agentService: () => mockAgentService,
  agentInstructionsService: () => mockAgentInstructionsService,
  accessService: () => mockAccessService,
  approvalService: () => mockApprovalService,
  companySkillService: () => mockCompanySkillService,
  budgetService: () => mockBudgetService,
  documentService: () => mockDocumentService,
  heartbeatService: () => mockHeartbeatService,
  issueApprovalService: () => mockIssueApprovalService,
  issueService: () => mockIssueService,
  logActivity: mockLogActivity,
  secretService: () => mockSecretService,
  syncInstructionsBundleConfigFromFilePath: vi.fn((_agent, config) => config),
  workspaceOperationService: () => mockWorkspaceOperationService,
}));

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => mockInstanceSettingsService,
}));

function createDbStub() {
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockResolvedValue([]),
          }),
        }),
      }),
    }),
  };
}

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "board-user",
      source: "local_implicit",
      isInstanceAdmin: true,
      companyIds: ["company-1"],
    };
    next();
  });
  app.use("/api", agentRoutes(createDbStub() as any));
  app.use(errorHandler);
  return app;
}

describe("agent live-runs routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInstanceSettingsService.getGeneral.mockResolvedValue({ censorUsernameInLogs: false });
    mockIssueService.getById.mockResolvedValue({
      id: "issue-1",
      companyId: "company-1",
      identifier: "HOM-574",
      status: "in_progress",
      assigneeAgentId: "atlas-executor-agent",
      createdAt: new Date("2026-04-15T12:23:13.000Z"),
      updatedAt: new Date("2026-04-15T12:23:19.000Z"),
    });
    mockIssueService.getByIdentifier.mockResolvedValue({
      id: "issue-1",
      companyId: "company-1",
      identifier: "HOM-574",
      status: "in_progress",
      assigneeAgentId: "atlas-executor-agent",
      createdAt: new Date("2026-04-15T12:23:13.000Z"),
      updatedAt: new Date("2026-04-15T12:23:19.000Z"),
    });
    mockAgentService.getById.mockResolvedValue({
      id: "atlas-executor-agent",
      companyId: "company-1",
      name: "Atlas Executor",
      adapterType: "process",
    });
  });

  it("returns a synthetic atlas live-run when atlas-execution is running without heartbeat runs", async () => {
    mockDocumentService.getIssueDocumentByKey.mockResolvedValue({
      key: "atlas-execution",
      updatedAt: new Date("2026-04-15T12:23:39.000Z"),
      body: [
        "# Итог выполнения Atlas",
        "",
        "- Turn: `TURN 4`",
        "- Atlas task: `paperclip-issue-1-t4-123`",
        "- Execution state: `running`",
        "- Slot env: `ai01`",
      ].join("\n"),
    });

    const res = await request(createApp()).get("/api/issues/HOM-574/live-runs");

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      expect.objectContaining({
        id: "paperclip-issue-1-t4-123",
        status: "running",
        invocationSource: "atlas_execution",
        triggerDetail: "TURN 4",
        agentId: "atlas-executor-agent",
        agentName: "Atlas Executor",
        syntheticSource: "atlas_execution",
        openable: false,
        slotEnv: "ai01",
        issueId: "issue-1",
      }),
    ]);
  });
});
