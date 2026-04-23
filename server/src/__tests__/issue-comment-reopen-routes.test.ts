import express from "express";
import { Readable } from "node:stream";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
  create: vi.fn(),
  addComment: vi.fn(),
  findMentionedAgents: vi.fn(),
  listAttachments: vi.fn(),
  listComments: vi.fn(),
}));

const mockDocumentService = vi.hoisted(() => ({
  getIssueDocumentByKey: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  reportRunActivity: vi.fn(async () => undefined),
  getRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null),
  getActiveRunForIssue: vi.fn(async () => null),
  cancelRun: vi.fn(async () => null),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  list: vi.fn(),
}));

const mockPluginRegistry = vi.hoisted(() => ({
  getByKey: vi.fn(),
}));

const mockWorkerManager = vi.hoisted(() => ({
  call: vi.fn(async () => ({ ok: true })),
  getWorker: vi.fn(() => ({ id: "plugin-1-worker" })),
  isRunning: vi.fn(() => true),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));
const mockStorage = vi.hoisted(() => ({
  getObject: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  documentService: () => mockDocumentService,
  executionWorkspaceService: () => ({}),
  goalService: () => ({}),
  heartbeatService: () => mockHeartbeatService,
  issueApprovalService: () => ({}),
  issueService: () => mockIssueService,
  logActivity: mockLogActivity,
  projectService: () => ({}),
  routineService: () => ({
    syncRunStatusForIssue: vi.fn(async () => undefined),
  }),
  workProductService: () => ({}),
}));

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", issueRoutes({} as any, mockStorage as any, {
    workerManager: mockWorkerManager as any,
    pluginRegistry: mockPluginRegistry as any,
  }));
  app.use(errorHandler);
  return app;
}

function makeIssue(status: "todo" | "done" | "in_review") {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    companyId: "company-1",
    status,
    assigneeAgentId: "22222222-2222-4222-8222-222222222222",
    assigneeUserId: null,
    createdByUserId: "local-board",
    identifier: "PAP-580",
    title: "Comment reopen default",
  };
}

describe("issue comment reopen routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDocumentService.getIssueDocumentByKey.mockResolvedValue(null);
    mockPluginRegistry.getByKey.mockResolvedValue(null);
    mockWorkerManager.isRunning.mockReturnValue(true);
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-1",
      issueId: "11111111-1111-4111-8111-111111111111",
      companyId: "company-1",
      body: "hello",
      createdAt: new Date(),
      updatedAt: new Date(),
      authorAgentId: null,
      authorUserId: "local-board",
    });
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.listAttachments.mockResolvedValue([]);
    mockIssueService.listComments.mockResolvedValue([]);
    mockIssueService.create.mockResolvedValue({
      id: "issue-created-1",
      companyId: "company-1",
      status: "todo",
      assigneeAgentId: "delivery-agent-id",
      assigneeUserId: null,
      identifier: "PAP-581",
      title: "Created",
    });
    mockAgentService.getById.mockImplementation(async (id: string) => ({
      id,
      companyId: "company-1",
      name:
        id === "22222222-2222-4222-8222-222222222222"
          ? "Atlas Executor"
          : id === "33333333-3333-4333-8333-333333333333"
            ? "Business Analyst"
            : "Agent",
      urlKey: "agent",
      role: "general",
      status: "active",
    }));
    mockAgentService.list.mockResolvedValue([]);
    mockStorage.getObject.mockResolvedValue({
      contentType: "image/png",
      stream: Readable.from([Buffer.from("image-bytes")]),
    });
  });

  it("defaults new issues to Delivery Orchestrator when no explicit assignee is provided", async () => {
    mockAgentService.list.mockResolvedValue([
      {
        id: "delivery-agent-id",
        name: "Delivery Orchestrator",
        urlKey: "delivery-orchestrator",
        role: "general",
        title: "Delivery Orchestrator",
        status: "active",
      },
    ]);

    const res = await request(createApp())
      .post("/api/companies/company-1/issues")
      .send({ title: "New issue" });

    expect(res.status).toBe(201);
    expect(mockIssueService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        title: "New issue",
        assigneeAgentId: "delivery-agent-id",
      }),
    );
  });

  it("treats reopen=true as a no-op when the issue is already open", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("todo"));
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeIssue("todo"),
      ...patch,
    }));

    const res = await request(createApp())
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ comment: "hello", reopen: true, assigneeAgentId: "33333333-3333-4333-8333-333333333333" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111", {
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
    });
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.updated",
        details: expect.not.objectContaining({ reopened: true }),
      }),
    );
  });

  it("reopens closed issues via the PATCH comment path", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("done"));
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeIssue("done"),
      ...patch,
    }));

    const res = await request(createApp())
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ comment: "hello", reopen: true, assigneeAgentId: "33333333-3333-4333-8333-333333333333" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111", {
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      status: "todo",
    });
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.updated",
        details: expect.objectContaining({
          reopened: true,
          reopenedFrom: "done",
          status: "todo",
        }),
      }),
    );
  });

  it("interrupts an active run before a combined comment update", async () => {
    const issue = {
      ...makeIssue("todo"),
      executionRunId: "run-1",
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
    }));
    mockHeartbeatService.getRun.mockResolvedValue({
      id: "run-1",
      companyId: "company-1",
      agentId: "22222222-2222-4222-8222-222222222222",
      status: "running",
    });
    mockHeartbeatService.cancelRun.mockResolvedValue({
      id: "run-1",
      companyId: "company-1",
      agentId: "22222222-2222-4222-8222-222222222222",
      status: "cancelled",
    });

    const res = await request(createApp())
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ comment: "hello", interrupt: true, assigneeAgentId: "33333333-3333-4333-8333-333333333333" });

    expect(res.status).toBe(200);
    expect(mockHeartbeatService.getRun).toHaveBeenCalledWith("run-1");
    expect(mockHeartbeatService.cancelRun).toHaveBeenCalledWith("run-1");
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "heartbeat.cancelled",
        details: expect.objectContaining({
          source: "issue_comment_interrupt",
          issueId: "11111111-1111-4111-8111-111111111111",
        }),
      }),
    );
  });

  it("starts atlas follow-up directly from a plain board comment when the issue has atlas execution state", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("todo"));
    mockDocumentService.getIssueDocumentByKey.mockResolvedValue({
      key: "atlas-execution",
      body: ["# Atlas Execution", "", "- Turn: `TURN 4`"].join("\n"),
    });
    mockPluginRegistry.getByKey.mockResolvedValue({
      id: "plugin-1",
      pluginKey: "homio.atlas-bridge",
      status: "ready",
    });

    const res = await request(createApp())
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: "Сохрани желтую кнопку. Добавь черную обводку и скругление." });

    expect(res.status).toBe(201);
    expect(res.body.atlasFollowupTriggered).toBe(true);
    expect(res.body.atlasFollowup).toMatchObject({
      status: "accepted",
      requestType: "followup",
      turnNumber: 5,
      turnLabel: "TURN 5",
    });
    expect(res.body.comment?.id).toBe("comment-1");
    expect(mockWorkerManager.call).toHaveBeenCalledWith(
      "plugin-1",
      "performAction",
      {
        key: "atlas-bridge-followup-issue-execution",
        params: {
          issueId: "11111111-1111-4111-8111-111111111111",
          companyId: "company-1",
          commentId: "comment-1",
          request: "Сохрани желтую кнопку. Добавь черную обводку и скругление.",
          commentImages: [],
          deferInitialSync: true,
          turnNumber: 5,
          turnLabel: "TURN 5",
        },
        renderEnvironment: null,
      },
      15_000,
    );
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalledWith(
      "22222222-2222-4222-8222-222222222222",
      expect.objectContaining({ reason: "issue_commented" }),
    );
  });

  it("routes explicit MR approval comments to Atlas MR creation instead of follow-up", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("todo"));
    mockDocumentService.getIssueDocumentByKey.mockResolvedValue({
      key: "atlas-execution",
      body: ["# Atlas Execution", "", "- Turn: `TURN 4`"].join("\n"),
    });
    mockPluginRegistry.getByKey.mockResolvedValue({
      id: "plugin-1",
      pluginKey: "homio.atlas-bridge",
      status: "ready",
    });

    const res = await request(createApp())
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: "Проверил руками, всё ок. Открой MR." });

    expect(res.status).toBe(201);
    expect(mockWorkerManager.call).toHaveBeenCalledWith(
      "plugin-1",
      "performAction",
      {
        key: "atlas-bridge-open-issue-merge-request",
        params: {
          issueId: "11111111-1111-4111-8111-111111111111",
          companyId: "company-1",
          commentId: "comment-1",
        },
        renderEnvironment: null,
      },
      15_000,
    );
    expect(mockWorkerManager.call).not.toHaveBeenCalledWith(
      "plugin-1",
      "performAction",
      expect.objectContaining({
        key: "atlas-bridge-followup-issue-execution",
      }),
    );
  });

  it("routes colloquial Russian MR comments to Atlas MR creation too", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("todo"));
    mockDocumentService.getIssueDocumentByKey.mockResolvedValue({
      key: "atlas-execution",
      body: ["# Atlas Execution", "", "- Turn: `TURN 4`"].join("\n"),
    });
    mockPluginRegistry.getByKey.mockResolvedValue({
      id: "plugin-1",
      pluginKey: "homio.atlas-bridge",
      status: "ready",
    });

    const res = await request(createApp())
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: "норм делай mr" });

    expect(res.status).toBe(201);
    expect(mockWorkerManager.call).toHaveBeenCalledWith(
      "plugin-1",
      "performAction",
      expect.objectContaining({
        key: "atlas-bridge-open-issue-merge-request",
        params: expect.objectContaining({
          issueId: "11111111-1111-4111-8111-111111111111",
          companyId: "company-1",
          commentId: "comment-1",
        }),
      }),
      15_000,
    );
  });

  it("routes colloquial MR comments to MR creation even when the issue is already in review", async () => {
    mockIssueService.getById.mockResolvedValue({
      ...makeIssue("todo"),
      status: "in_review",
    });
    mockDocumentService.getIssueDocumentByKey.mockResolvedValue({
      key: "atlas-execution",
      body: ["# Atlas Execution", "", "- Turn: `TURN 4`"].join("\n"),
    });
    mockPluginRegistry.getByKey.mockResolvedValue({
      id: "plugin-1",
      pluginKey: "homio.atlas-bridge",
      status: "ready",
    });

    const res = await request(createApp())
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: "норм делай mr" });

    expect(res.status).toBe(201);
    expect(mockWorkerManager.call).toHaveBeenCalledWith(
      "plugin-1",
      "performAction",
      expect.objectContaining({
        key: "atlas-bridge-open-issue-merge-request",
      }),
      15_000,
    );
  });

  it("does not wake the assignee into a new turn when MR creation is requested but blocked", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("todo"));
    mockDocumentService.getIssueDocumentByKey.mockResolvedValue({
      key: "atlas-execution",
      body: ["# Atlas Execution", "", "- Turn: `TURN 4`"].join("\n"),
    });
    mockPluginRegistry.getByKey.mockResolvedValue({
      id: "plugin-1",
      pluginKey: "homio.atlas-bridge",
      status: "ready",
    });
    mockWorkerManager.call.mockRejectedValueOnce(new Error("Issue is not review-ready for merge request creation"));

    const res = await request(createApp())
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: "норм делай mr" });

    expect(res.status).toBe(201);
    expect(res.body.atlasFollowupTriggered).toBe(false);
    expect(res.body.atlasMergeRequestHandled).toBe(true);
    expect(res.body.atlasMergeRequestError).toContain("Issue is not review-ready for merge request creation");
    expect(res.body.atlasFollowup).toMatchObject({
      status: "blocked",
      requestType: "merge_request",
    });
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalledWith(
      "22222222-2222-4222-8222-222222222222",
      expect.objectContaining({ reason: "issue_commented" }),
    );
  });

  it("reopens in_review issues via the direct comment route before saving the comment", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("in_review"));
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeIssue("in_review"),
      ...patch,
    }));

    const res = await request(createApp())
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: "Новый follow-up после review.", reopen: true });

    expect(res.status).toBe(201);
    expect(mockIssueService.update).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111", {
      status: "todo",
    });
  });

  it("returns a blocked follow-up ack and suppresses generic wakeups when Atlas bridge is unavailable", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("todo"));
    mockDocumentService.getIssueDocumentByKey.mockResolvedValue({
      key: "atlas-execution",
      body: ["# Atlas Execution", "", "- Turn: `TURN 4`"].join("\n"),
    });
    mockPluginRegistry.getByKey.mockResolvedValue({
      id: "plugin-1",
      pluginKey: "homio.atlas-bridge",
      status: "ready",
    });
    mockWorkerManager.isRunning.mockReturnValue(false);

    const res = await request(createApp())
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: "Сразу ответь в этот же тред." });

    expect(res.status).toBe(201);
    expect(res.body.atlasFollowupTriggered).toBe(false);
    expect(res.body.atlasFollowup).toMatchObject({
      status: "blocked",
      requestType: "followup",
      turnNumber: 5,
      turnLabel: "TURN 5",
    });
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalledWith(
      "22222222-2222-4222-8222-222222222222",
      expect.objectContaining({ reason: "issue_commented" }),
    );
  });

  it("starts atlas follow-up from the PATCH comment path too", async () => {
    const issue = makeIssue("todo");
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockResolvedValue(issue);
    mockDocumentService.getIssueDocumentByKey.mockResolvedValue({
      key: "atlas-execution",
      body: ["# Atlas Execution", "", "- Turn: `TURN 2`"].join("\n"),
    });
    mockPluginRegistry.getByKey.mockResolvedValue({
      id: "plugin-1",
      pluginKey: "homio.atlas-bridge",
      status: "ready",
    });

    const res = await request(createApp())
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ comment: "Оставь желтый цвет. Добавь черную обводку." });

    expect(res.status).toBe(200);
    expect(res.body.atlasFollowupTriggered).toBe(true);
    expect(res.body.atlasFollowup).toMatchObject({
      status: "accepted",
      requestType: "followup",
      turnNumber: 3,
      turnLabel: "TURN 3",
    });
    expect(res.body.comment?.id).toBe("comment-1");
    expect(mockWorkerManager.call).toHaveBeenCalledWith(
      "plugin-1",
      "performAction",
      {
        key: "atlas-bridge-followup-issue-execution",
        params: {
          issueId: "11111111-1111-4111-8111-111111111111",
          companyId: "company-1",
          commentId: "comment-1",
          request: "Оставь желтый цвет. Добавь черную обводку.",
          commentImages: [],
          deferInitialSync: true,
          turnNumber: 3,
          turnLabel: "TURN 3",
        },
        renderEnvironment: null,
      },
      15_000,
    );
  });

  it("routes reassigned comments to the selected agent instead of Atlas follow-up", async () => {
    const issue = {
      ...makeIssue("todo"),
      executionRunId: "run-1",
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockResolvedValue({
      ...issue,
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
    });
    mockHeartbeatService.getRun.mockResolvedValue({
      id: "run-1",
      companyId: "company-1",
      agentId: "22222222-2222-4222-8222-222222222222",
      status: "running",
    });
    mockHeartbeatService.cancelRun.mockResolvedValue({
      id: "run-1",
      companyId: "company-1",
      agentId: "22222222-2222-4222-8222-222222222222",
      status: "cancelled",
    });
    mockDocumentService.getIssueDocumentByKey.mockResolvedValue({
      key: "atlas-execution",
      body: ["# Atlas Execution", "", "- Turn: `TURN 2`"].join("\n"),
    });
    mockPluginRegistry.getByKey.mockResolvedValue({
      id: "plugin-1",
      pluginKey: "homio.atlas-bridge",
      status: "ready",
    });

    const res = await request(createApp())
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({
        comment: "Расскажи, что именно ты проверил и что осталось сомнительным.",
        assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      });

    expect(res.status).toBe(200);
    expect(res.body.atlasFollowupTriggered).toBe(false);
    expect(res.body.interruptedRunId).toBe("run-1");
    expect(mockHeartbeatService.cancelRun).toHaveBeenCalledWith("run-1");
    expect(mockWorkerManager.call).not.toHaveBeenCalledWith(
      "plugin-1",
      "performAction",
      expect.objectContaining({
        key: "atlas-bridge-followup-issue-execution",
      }),
      15_000,
    );
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      "33333333-3333-4333-8333-333333333333",
      expect.objectContaining({
        reason: "issue_commented",
        payload: expect.objectContaining({
          issueId: "11111111-1111-4111-8111-111111111111",
          commentId: "comment-1",
        }),
        contextSnapshot: expect.objectContaining({
          issueId: "11111111-1111-4111-8111-111111111111",
          commentId: "comment-1",
          wakeCommentId: "comment-1",
          source: "issue.comment.reassign",
          wakeReason: "issue_commented",
        }),
      }),
    );
  });

  it("routes directed Atlas comments through the bridge follow-up path instead of local wakeup", async () => {
    const issue = {
      ...makeIssue("todo"),
      executionRunId: "run-1",
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockResolvedValue(issue);
    mockHeartbeatService.getRun.mockResolvedValue({
      id: "run-1",
      companyId: "company-1",
      agentId: "22222222-2222-4222-8222-222222222222",
      status: "running",
      contextSnapshot: { issueId: issue.id },
    });
    mockHeartbeatService.cancelRun.mockResolvedValue({
      id: "run-1",
      companyId: "company-1",
      agentId: "22222222-2222-4222-8222-222222222222",
      status: "cancelled",
    });
    mockDocumentService.getIssueDocumentByKey.mockResolvedValue({
      key: "atlas-execution",
      body: ["# Atlas Execution", "", "- Turn: `TURN 2`"].join("\n"),
    });
    mockPluginRegistry.getByKey.mockResolvedValue({
      id: "plugin-1",
      pluginKey: "homio.atlas-bridge",
      status: "ready",
    });

    const res = await request(createApp())
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({
        comment: "Ответь подробнее, что именно ты проверил и что осталось спорным.",
        commentTargetAgentId: "22222222-2222-4222-8222-222222222222",
      });

    expect(res.status).toBe(200);
    expect(res.body.atlasFollowupTriggered).toBe(false);
    expect(res.body.interruptedRunId).toBe("run-1");
    expect(mockHeartbeatService.cancelRun).toHaveBeenCalledWith("run-1");
    expect(mockWorkerManager.call).toHaveBeenCalledWith(
      "plugin-1",
      "performAction",
      {
        key: "atlas-bridge-followup-issue-execution",
        params: expect.objectContaining({
          issueId: issue.id,
          companyId: "company-1",
          commentId: "comment-1",
          deferInitialSync: true,
          turnNumber: 3,
          turnLabel: "TURN 3",
        }),
        renderEnvironment: null,
      },
      15_000,
    );
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalledWith(
      "22222222-2222-4222-8222-222222222222",
      expect.objectContaining({
        reason: "issue_commented",
      }),
    );
    expect(mockIssueService.addComment).toHaveBeenCalledTimes(1);
  });

  it("interrupts legacy issue-scoped runs before routing reassigned comments", async () => {
    const issue = makeIssue("todo");
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockResolvedValue({
      ...issue,
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
    });
    mockHeartbeatService.getActiveRunForIssue.mockResolvedValue({
      id: "legacy-run-1",
      companyId: "company-1",
      agentId: "22222222-2222-4222-8222-222222222222",
      status: "running",
      contextSnapshot: { issueId: issue.id },
    });
    mockHeartbeatService.cancelRun.mockResolvedValue({
      id: "legacy-run-1",
      companyId: "company-1",
      agentId: "22222222-2222-4222-8222-222222222222",
      status: "cancelled",
    });
    mockDocumentService.getIssueDocumentByKey.mockResolvedValue({
      key: "atlas-execution",
      body: ["# Atlas Execution", "", "- Turn: `TURN 2`"].join("\n"),
    });

    const res = await request(createApp())
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({
        comment: "Explain the current verification gap in your own words.",
        assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      });

    expect(res.status).toBe(200);
    expect(res.body.atlasFollowupTriggered).toBe(false);
    expect(res.body.interruptedRunId).toBe("legacy-run-1");
    expect(mockHeartbeatService.getActiveRunForIssue).toHaveBeenCalledWith(issue.id);
    expect(mockHeartbeatService.cancelRun).toHaveBeenCalledWith("legacy-run-1");
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      "33333333-3333-4333-8333-333333333333",
      expect.objectContaining({
        reason: "issue_commented",
        contextSnapshot: expect.objectContaining({
          issueId: issue.id,
          wakeCommentId: "comment-1",
          interruptedRunId: "legacy-run-1",
          source: "issue.comment.reassign",
        }),
      }),
    );
  });

  it("routes direct Atlas comment posts through the bridge follow-up path", async () => {
    const issue = {
      ...makeIssue("todo"),
      executionRunId: "run-2",
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockHeartbeatService.getRun.mockResolvedValue({
      id: "run-2",
      companyId: "company-1",
      agentId: "22222222-2222-4222-8222-222222222222",
      status: "running",
      contextSnapshot: { issueId: issue.id },
    });
    mockHeartbeatService.cancelRun.mockResolvedValue({
      id: "run-2",
      companyId: "company-1",
      agentId: "22222222-2222-4222-8222-222222222222",
      status: "cancelled",
    });
    mockDocumentService.getIssueDocumentByKey.mockResolvedValue({
      key: "atlas-execution",
      body: ["# Atlas Execution", "", "- Turn: `TURN 4`"].join("\n"),
    });
    mockPluginRegistry.getByKey.mockResolvedValue({
      id: "plugin-1",
      pluginKey: "homio.atlas-bridge",
      status: "ready",
    });

    const res = await request(createApp())
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({
        body: "Скажи человеческим языком, почему ты принял именно такой вердикт.",
        commentTargetAgentId: "22222222-2222-4222-8222-222222222222",
      });

    expect(res.status).toBe(201);
    expect(res.body.atlasFollowupTriggered).toBe(false);
    expect(res.body.atlasFollowup).toMatchObject({
      status: "accepted",
      requestType: "directed_agent",
      detail: null,
    });
    expect(res.body.interruptedRunId).toBe("run-2");
    expect(mockIssueService.addComment).toHaveBeenCalledTimes(1);
    expect(mockHeartbeatService.cancelRun).toHaveBeenCalledWith("run-2");
    expect(mockWorkerManager.call).toHaveBeenCalledWith(
      "plugin-1",
      "performAction",
      {
        key: "atlas-bridge-followup-issue-execution",
        params: expect.objectContaining({
          issueId: issue.id,
          companyId: "company-1",
          commentId: "comment-1",
          deferInitialSync: true,
          turnNumber: 5,
          turnLabel: "TURN 5",
        }),
        renderEnvironment: null,
      },
      15_000,
    );
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalledWith(
      "22222222-2222-4222-8222-222222222222",
      expect.objectContaining({
        reason: "issue_commented",
      }),
    );
  });

  it("returns a blocked directed-agent follow-up when the bridge dispatch is rejected", async () => {
    const issue = {
      ...makeIssue("todo"),
      executionRunId: "run-2",
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockHeartbeatService.getRun.mockResolvedValue({
      id: "run-2",
      companyId: "company-1",
      agentId: "22222222-2222-4222-8222-222222222222",
      status: "running",
      contextSnapshot: { issueId: issue.id },
    });
    mockHeartbeatService.cancelRun.mockResolvedValue({
      id: "run-2",
      companyId: "company-1",
      agentId: "22222222-2222-4222-8222-222222222222",
      status: "cancelled",
    });
    mockPluginRegistry.getByKey.mockResolvedValue({
      id: "plugin-1",
      pluginKey: "homio.atlas-bridge",
      status: "ready",
    });
    mockWorkerManager.call.mockRejectedValueOnce(new Error("Directed bridge dispatch rejected"));
    mockDocumentService.getIssueDocumentByKey.mockResolvedValue({
      key: "atlas-execution",
      body: ["# Atlas Execution", "", "- Turn: `TURN 4`"].join("\n"),
    });

    const res = await request(createApp())
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({
        body: "Ответь прямо в чат без повторного review-сводного комментария.",
        commentTargetAgentId: "22222222-2222-4222-8222-222222222222",
      });

    expect(res.status).toBe(201);
    expect(res.body.atlasFollowup).toMatchObject({
      status: "blocked",
      requestType: "directed_agent",
      detail: "Directed bridge dispatch rejected",
    });
  });

  it("propagates comment images into Atlas follow-up context", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("todo"));
    mockDocumentService.getIssueDocumentByKey.mockResolvedValue({
      key: "atlas-execution",
      body: ["# Atlas Execution", "", "- Turn: `TURN 4`"].join("\n"),
    });
    mockPluginRegistry.getByKey.mockResolvedValue({
      id: "plugin-1",
      pluginKey: "homio.atlas-bridge",
      status: "ready",
    });
    mockIssueService.listAttachments.mockResolvedValue([
      {
        id: "attachment-1",
        issueId: "11111111-1111-4111-8111-111111111111",
        issueCommentId: "comment-1",
        companyId: "company-1",
        objectKey: "attachments/comment-1.png",
        originalFilename: "regression.png",
        contentType: "image/png",
        byteSize: 128,
        sha256: "sha256-test",
      },
    ]);

    const res = await request(createApp())
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: "Исправь разметку.\n\n![](/api/attachments/attachment-1/content)\nкриво размечается." });

    expect(res.status).toBe(201);
    expect(mockWorkerManager.call).toHaveBeenCalledWith(
      "plugin-1",
      "performAction",
      {
        key: "atlas-bridge-followup-issue-execution",
        params: expect.objectContaining({
          issueId: "11111111-1111-4111-8111-111111111111",
          companyId: "company-1",
          commentId: "comment-1",
          deferInitialSync: true,
          turnNumber: 5,
          turnLabel: "TURN 5",
          request: expect.stringContaining("Reference images from this comment:"),
          commentImages: [
            expect.objectContaining({
              attachmentId: "attachment-1",
              originalFilename: "regression.png",
              contentType: "image/png",
              sourceUrl: "/api/attachments/attachment-1/content",
              absoluteUrl: expect.stringContaining("/api/attachments/attachment-1/content"),
              inlineDataUrl: expect.stringMatching(/^data:image\/png;base64,/),
            }),
          ],
        }),
        renderEnvironment: null,
      },
      15_000,
    );
  });

  it("preserves an explicit follow-up turn number from the new comment body", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("todo"));
    mockDocumentService.getIssueDocumentByKey.mockResolvedValue({
      key: "atlas-execution",
      body: ["# Atlas Execution", "", "- Turn: `TURN 1`"].join("\n"),
    });
    mockPluginRegistry.getByKey.mockResolvedValue({
      id: "plugin-1",
      pluginKey: "homio.atlas-bridge",
      status: "ready",
    });

    const res = await request(createApp())
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: "## Follow-up turn 13\n\nПерепроверь сложный сценарий." });

    expect(res.status).toBe(201);
    expect(mockWorkerManager.call).toHaveBeenCalledWith(
      "plugin-1",
      "performAction",
      {
        key: "atlas-bridge-followup-issue-execution",
        params: expect.objectContaining({
          deferInitialSync: true,
          turnNumber: 13,
          turnLabel: "TURN 13",
        }),
        renderEnvironment: null,
      },
      15_000,
    );
  });

  it("falls back to the latest follow-up turn from comment history when the execution document lags", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("todo"));
    mockDocumentService.getIssueDocumentByKey.mockResolvedValue({
      key: "atlas-execution",
      body: ["# Atlas Execution", "", "- Turn: `TURN 1`"].join("\n"),
    });
    mockPluginRegistry.getByKey.mockResolvedValue({
      id: "plugin-1",
      pluginKey: "homio.atlas-bridge",
      status: "ready",
    });
    mockIssueService.listComments.mockResolvedValue([
      { id: "older-1", body: "## Follow-up turn 12\n\nСтарый turn." },
      { id: "older-2", body: "Обычный комментарий без turn." },
    ]);

    const res = await request(createApp())
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: "Новая доработка без явного turn в body." });

    expect(res.status).toBe(201);
    expect(mockWorkerManager.call).toHaveBeenCalledWith(
      "plugin-1",
      "performAction",
      {
        key: "atlas-bridge-followup-issue-execution",
        params: expect.objectContaining({
          deferInitialSync: true,
          turnNumber: 13,
          turnLabel: "TURN 13",
        }),
        renderEnvironment: null,
      },
      15_000,
    );
  });
});
