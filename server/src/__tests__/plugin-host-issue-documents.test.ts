import { beforeEach, describe, expect, it, vi } from "vitest";

const issueGetByIdMock = vi.fn();
const issueListMock = vi.fn();
const upsertIssueDocumentMock = vi.fn();
const executionWorkspaceGetByIdMock = vi.fn();

vi.mock("../services/companies.js", () => ({
  companyService: () => ({}),
}));

vi.mock("../services/agents.js", () => ({
  agentService: () => ({}),
}));

vi.mock("../services/projects.js", () => ({
  projectService: () => ({}),
}));

vi.mock("../services/issues.js", () => ({
  issueService: () => ({
    getById: issueGetByIdMock,
    list: issueListMock,
  }),
}));

vi.mock("../services/goals.js", () => ({
  goalService: () => ({}),
}));

vi.mock("../services/execution-workspaces.js", () => ({
  executionWorkspaceService: () => ({
    getById: executionWorkspaceGetByIdMock,
  }),
}));

vi.mock("../services/documents.js", () => ({
  documentService: () => ({
    listIssueDocuments: vi.fn(async () => []),
    getIssueDocumentByKey: vi.fn(async () => null),
    upsertIssueDocument: upsertIssueDocumentMock,
    deleteIssueDocument: vi.fn(async () => undefined),
  }),
}));

vi.mock("../services/heartbeat.js", () => ({
  heartbeatService: () => ({}),
}));

vi.mock("../services/live-events.js", () => ({
  subscribeCompanyLiveEvents: vi.fn(),
}));

vi.mock("../services/activity.js", () => ({
  activityService: () => ({}),
}));

vi.mock("../services/costs.js", () => ({
  costService: () => ({}),
}));

vi.mock("../services/assets.js", () => ({
  assetService: () => ({}),
}));

vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => ({
    getConfig: vi.fn(async () => null),
  }),
}));

vi.mock("../services/plugin-state-store.js", () => ({
  pluginStateStore: () => ({}),
}));

vi.mock("../services/plugin-secrets-handler.js", () => ({
  createPluginSecretsHandler: () => ({}),
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: vi.fn(),
}));

describe("plugin host issue document forwarding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    issueGetByIdMock.mockResolvedValue({
      id: "issue-1",
      companyId: "company-1",
    });
    issueListMock.mockResolvedValue([]);
    executionWorkspaceGetByIdMock.mockResolvedValue(null);
    upsertIssueDocumentMock.mockResolvedValue({
      document: {
        id: "doc-1",
        issueId: "issue-1",
        key: "atlas-execution",
        latestRevisionId: "rev-2",
        latestRevisionNumber: 2,
      },
    });
  });

  it("forwards baseRevisionId to documentService when plugin updates an issue document", async () => {
    const { buildHostServices } = await import("../services/plugin-host-services.js");

    const hostServices = buildHostServices(
      {} as any,
      "plugin-1",
      "homio.atlas-bridge",
      {
        forPlugin: () => ({
          publish: vi.fn(),
          subscribe: vi.fn(() => ({ unsubscribe: vi.fn() })),
        }),
      } as any,
    );

    await hostServices.issueDocuments.upsert({
      companyId: "company-1",
      issueId: "issue-1",
      key: "atlas-execution",
      title: "Atlas Execution",
      format: "markdown",
      body: "# updated",
      changeSummary: "refresh projection",
      baseRevisionId: "rev-1",
    } as any);

    expect(upsertIssueDocumentMock).toHaveBeenCalledWith(expect.objectContaining({
      issueId: "issue-1",
      key: "atlas-execution",
      body: "# updated",
      changeSummary: "refresh projection",
      baseRevisionId: "rev-1",
    }));
  });

  it("enriches issues.get with currentExecutionWorkspace for plugin workers", async () => {
    issueGetByIdMock.mockResolvedValue({
      id: "issue-1",
      companyId: "company-1",
      executionWorkspaceId: "ws-1",
    });
    executionWorkspaceGetByIdMock.mockResolvedValue({
      id: "ws-1",
      companyId: "company-1",
      name: "Issue workspace",
      cwd: "/tmp/ws",
      repoUrl: "ssh://git@example.test/repo.git",
      branchName: "feature/issue",
    });

    const { buildHostServices } = await import("../services/plugin-host-services.js");

    const hostServices = buildHostServices(
      {} as any,
      "plugin-1",
      "homio.atlas-bridge",
      {
        forPlugin: () => ({
          publish: vi.fn(),
          subscribe: vi.fn(() => ({ unsubscribe: vi.fn() })),
        }),
      } as any,
    );

    const issue = await hostServices.issues.get({
      companyId: "company-1",
      issueId: "issue-1",
    } as any);

    expect(executionWorkspaceGetByIdMock).toHaveBeenCalledWith("ws-1");
    expect(issue).toEqual(expect.objectContaining({
      id: "issue-1",
      executionWorkspaceId: "ws-1",
      currentExecutionWorkspace: expect.objectContaining({
        id: "ws-1",
        repoUrl: "ssh://git@example.test/repo.git",
        branchName: "feature/issue",
      }),
    }));
  });

  it("does not apply plugin-side windowing after issueService pagination", async () => {
    issueListMock.mockResolvedValue([
      { id: "issue-201", companyId: "company-1" },
      { id: "issue-202", companyId: "company-1" },
    ]);

    const { buildHostServices } = await import("../services/plugin-host-services.js");

    const hostServices = buildHostServices(
      {} as any,
      "plugin-1",
      "homio.atlas-bridge",
      {
        forPlugin: () => ({
          publish: vi.fn(),
          subscribe: vi.fn(() => ({ unsubscribe: vi.fn() })),
        }),
      } as any,
    );

    const issues = await hostServices.issues.list({
      companyId: "company-1",
      limit: 2,
      offset: 200,
    } as any);

    expect(issueListMock).toHaveBeenCalledWith("company-1", expect.objectContaining({
      companyId: "company-1",
      limit: 2,
      offset: 200,
    }));
    expect(issues.map((issue) => issue.id)).toEqual(["issue-201", "issue-202"]);
  });
});
