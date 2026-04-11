import { beforeEach, describe, expect, it, vi } from "vitest";

const issueGetByIdMock = vi.fn();
const upsertIssueDocumentMock = vi.fn();

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
  }),
}));

vi.mock("../services/goals.js", () => ({
  goalService: () => ({}),
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
});
