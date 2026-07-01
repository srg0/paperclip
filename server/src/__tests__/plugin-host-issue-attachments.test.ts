import { beforeEach, describe, expect, it, vi } from "vitest";

const issueGetByIdMock = vi.fn();
const issueListAttachmentsMock = vi.fn();
const issueGetAttachmentByIdMock = vi.fn();
const issueCreateAttachmentMock = vi.fn();

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
    listAttachments: issueListAttachmentsMock,
    getAttachmentById: issueGetAttachmentByIdMock,
    createAttachment: issueCreateAttachmentMock,
  }),
}));

vi.mock("../services/goals.js", () => ({
  goalService: () => ({}),
}));

vi.mock("../services/execution-workspaces.js", () => ({
  executionWorkspaceService: () => ({}),
}));

vi.mock("../services/documents.js", () => ({
  documentService: () => ({}),
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

function eventBusStub() {
  return {
    forPlugin: () => ({
      publish: vi.fn(),
      subscribe: vi.fn(() => ({ unsubscribe: vi.fn() })),
    }),
  } as any;
}

const pngDataUrl = "data:image/png;base64,iVBORw0KGgo=";

describe("plugin host issue attachment forwarding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    issueGetByIdMock.mockResolvedValue({
      id: "issue-1",
      companyId: "company-1",
    });
    issueListAttachmentsMock.mockResolvedValue([]);
    issueGetAttachmentByIdMock.mockResolvedValue(null);
    issueCreateAttachmentMock.mockResolvedValue({
      id: "attachment-1",
      companyId: "company-1",
      issueId: "issue-1",
      issueCommentId: null,
      assetId: "asset-1",
      provider: "local_disk",
      objectKey: "company-1/issues/issue-1/screenshot.png",
      contentType: "image/png",
      byteSize: 8,
      sha256: "sha",
      originalFilename: "screenshot.png",
      createdByAgentId: null,
      createdByUserId: null,
      createdAt: new Date("2026-07-01T00:00:00.000Z"),
      updatedAt: new Date("2026-07-01T00:00:00.000Z"),
    });
  });

  it("creates native issue attachments from a plugin data URL through host storage", async () => {
    const putFile = vi.fn(async () => ({
      provider: "local_disk" as const,
      objectKey: "company-1/issues/issue-1/screenshot.png",
      contentType: "image/png",
      byteSize: 8,
      sha256: "sha",
      originalFilename: "screenshot.png",
    }));
    const { buildHostServices } = await import("../services/plugin-host-services.js");
    const hostServices = buildHostServices(
      {} as any,
      "plugin-1",
      "homio.atlas-bridge",
      eventBusStub(),
      undefined,
      { putFile } as any,
    );

    const attachment = await hostServices.issueAttachments.createFromDataUrl({
      companyId: "company-1",
      issueId: "issue-1",
      dataUrl: pngDataUrl,
      filename: "screenshot.png",
    } as any);

    expect(putFile).toHaveBeenCalledWith(expect.objectContaining({
      companyId: "company-1",
      namespace: "issues/issue-1",
      originalFilename: "screenshot.png",
      contentType: "image/png",
      body: expect.any(Buffer),
    }));
    expect(issueCreateAttachmentMock).toHaveBeenCalledWith(expect.objectContaining({
      issueId: "issue-1",
      provider: "local_disk",
      objectKey: "company-1/issues/issue-1/screenshot.png",
      contentType: "image/png",
      originalFilename: "screenshot.png",
    }));
    expect(attachment).toMatchObject({
      id: "attachment-1",
      contentPath: "/api/attachments/attachment-1/content",
    });
  });

  it("lists and reads native issue attachments with content paths", async () => {
    const attachment = {
      id: "attachment-1",
      companyId: "company-1",
      issueId: "issue-1",
      issueCommentId: null,
      assetId: "asset-1",
      provider: "local_disk",
      objectKey: "company-1/issues/issue-1/screenshot.png",
      contentType: "image/png",
      byteSize: 8,
      sha256: "sha",
      originalFilename: "screenshot.png",
      createdByAgentId: null,
      createdByUserId: null,
      createdAt: new Date("2026-07-01T00:00:00.000Z"),
      updatedAt: new Date("2026-07-01T00:00:00.000Z"),
    };
    issueListAttachmentsMock.mockResolvedValue([attachment]);
    issueGetAttachmentByIdMock.mockResolvedValue(attachment);
    const { buildHostServices } = await import("../services/plugin-host-services.js");
    const hostServices = buildHostServices(
      {} as any,
      "plugin-1",
      "homio.atlas-bridge",
      eventBusStub(),
    );

    await expect(hostServices.issueAttachments.list({
      companyId: "company-1",
      issueId: "issue-1",
    } as any)).resolves.toEqual([
      expect.objectContaining({
        id: "attachment-1",
        contentPath: "/api/attachments/attachment-1/content",
      }),
    ]);
    await expect(hostServices.issueAttachments.get({
      companyId: "company-1",
      attachmentId: "attachment-1",
    } as any)).resolves.toMatchObject({
      id: "attachment-1",
      contentPath: "/api/attachments/attachment-1/content",
    });
  });

  it("rejects unsupported data URL attachment content types", async () => {
    const { buildHostServices } = await import("../services/plugin-host-services.js");
    const hostServices = buildHostServices(
      {} as any,
      "plugin-1",
      "homio.atlas-bridge",
      eventBusStub(),
      undefined,
      { putFile: vi.fn() } as any,
    );

    await expect(hostServices.issueAttachments.createFromDataUrl({
      companyId: "company-1",
      issueId: "issue-1",
      dataUrl: "data:application/x-msdownload;base64,AAECAwQ=",
      filename: "bad.exe",
    } as any)).rejects.toThrow(/Unsupported attachment type/);
  });
});
