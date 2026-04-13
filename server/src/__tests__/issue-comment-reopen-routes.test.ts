import express from "express";
import { Readable } from "node:stream";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
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
  cancelRun: vi.fn(async () => null),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockPluginRegistry = vi.hoisted(() => ({
  getByKey: vi.fn(),
}));

const mockWorkerManager = vi.hoisted(() => ({
  call: vi.fn(async () => ({ ok: true })),
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

function makeIssue(status: "todo" | "done") {
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
    mockStorage.getObject.mockResolvedValue({
      contentType: "image/png",
      stream: Readable.from([Buffer.from("image-bytes")]),
    });
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
    expect(mockWorkerManager.call).toHaveBeenCalledWith("plugin-1", "performAction", {
      key: "atlas-bridge-followup-issue-execution",
      params: {
        issueId: "11111111-1111-4111-8111-111111111111",
        companyId: "company-1",
        commentId: "comment-1",
        request: "Сохрани желтую кнопку. Добавь черную обводку и скругление.",
        commentImages: [],
        turnNumber: 5,
        turnLabel: "TURN 5",
      },
      renderEnvironment: null,
    });
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
    expect(mockWorkerManager.call).toHaveBeenCalledWith("plugin-1", "performAction", {
      key: "atlas-bridge-open-issue-merge-request",
      params: {
        issueId: "11111111-1111-4111-8111-111111111111",
        companyId: "company-1",
        commentId: "comment-1",
      },
      renderEnvironment: null,
    });
    expect(mockWorkerManager.call).not.toHaveBeenCalledWith(
      "plugin-1",
      "performAction",
      expect.objectContaining({
        key: "atlas-bridge-followup-issue-execution",
      }),
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
    expect(mockWorkerManager.call).toHaveBeenCalledWith("plugin-1", "performAction", {
      key: "atlas-bridge-followup-issue-execution",
      params: {
        issueId: "11111111-1111-4111-8111-111111111111",
        companyId: "company-1",
        commentId: "comment-1",
        request: "Оставь желтый цвет. Добавь черную обводку.",
        commentImages: [],
        turnNumber: 3,
        turnLabel: "TURN 3",
      },
      renderEnvironment: null,
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
    expect(mockWorkerManager.call).toHaveBeenCalledWith("plugin-1", "performAction", {
      key: "atlas-bridge-followup-issue-execution",
      params: expect.objectContaining({
        issueId: "11111111-1111-4111-8111-111111111111",
        companyId: "company-1",
        commentId: "comment-1",
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
    });
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
    expect(mockWorkerManager.call).toHaveBeenCalledWith("plugin-1", "performAction", {
      key: "atlas-bridge-followup-issue-execution",
      params: expect.objectContaining({
        turnNumber: 13,
        turnLabel: "TURN 13",
      }),
      renderEnvironment: null,
    });
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
    expect(mockWorkerManager.call).toHaveBeenCalledWith("plugin-1", "performAction", {
      key: "atlas-bridge-followup-issue-execution",
      params: expect.objectContaining({
        turnNumber: 13,
        turnLabel: "TURN 13",
      }),
      renderEnvironment: null,
    });
  });
});
