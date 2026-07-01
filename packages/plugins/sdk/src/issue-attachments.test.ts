import { describe, expect, it, vi } from "vitest";
import {
  CapabilityDeniedError,
  createHostClientHandlers,
  getRequiredCapability,
} from "./host-client-factory.js";

describe("plugin issue attachment host capability mapping", () => {
  it("maps attachment RPC methods to read/write capabilities", () => {
    expect(getRequiredCapability("issues.attachments.list")).toBe("issue.attachments.read");
    expect(getRequiredCapability("issues.attachments.get")).toBe("issue.attachments.read");
    expect(getRequiredCapability("issues.attachments.createFromUrl")).toBe("issue.attachments.write");
    expect(getRequiredCapability("issues.attachments.createFromDataUrl")).toBe("issue.attachments.write");
  });

  it("rejects attachment writes without the attachment write capability", async () => {
    const handlers = createHostClientHandlers({
      pluginId: "test.plugin",
      capabilities: ["issues.read"],
      services: {} as any,
    });

    await expect(handlers["issues.attachments.createFromDataUrl"]({
      companyId: "company-1",
      issueId: "issue-1",
      dataUrl: "data:image/png;base64,iVBORw0KGgo=",
    })).rejects.toBeInstanceOf(CapabilityDeniedError);
  });

  it("delegates attachment writes when the plugin declares the capability", async () => {
    const createFromDataUrl = vi.fn(async () => ({
      id: "attachment-1",
      companyId: "company-1",
      issueId: "issue-1",
      issueCommentId: null,
      assetId: "asset-1",
      provider: "local_disk",
      objectKey: "company-1/issues/issue-1/proof.png",
      contentType: "image/png",
      byteSize: 8,
      sha256: "sha",
      originalFilename: "proof.png",
      createdByAgentId: null,
      createdByUserId: null,
      createdAt: new Date("2026-07-01T00:00:00.000Z"),
      updatedAt: new Date("2026-07-01T00:00:00.000Z"),
      contentPath: "/api/attachments/attachment-1/content",
    }));
    const handlers = createHostClientHandlers({
      pluginId: "test.plugin",
      capabilities: ["issue.attachments.write"],
      services: {
        issueAttachments: {
          createFromDataUrl,
        },
      } as any,
    });

    await expect(handlers["issues.attachments.createFromDataUrl"]({
      companyId: "company-1",
      issueId: "issue-1",
      dataUrl: "data:image/png;base64,iVBORw0KGgo=",
      filename: "proof.png",
    })).resolves.toMatchObject({
      id: "attachment-1",
      contentPath: "/api/attachments/attachment-1/content",
    });
    expect(createFromDataUrl).toHaveBeenCalledWith(expect.objectContaining({
      companyId: "company-1",
      issueId: "issue-1",
      filename: "proof.png",
    }));
  });
});
