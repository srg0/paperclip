// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IssueKannaSurface } from "./IssueKannaSurface";

const queryState = vi.hoisted(() => ({
  current: {
    data: null as unknown,
    isLoading: false,
    refetch: vi.fn(),
  },
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: vi.fn(() => queryState.current),
}));

vi.mock("../../api/plugins", () => ({
  pluginsApi: {
    bridgeGetData: vi.fn(),
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function setEmbedUrl(embedUrl: string, chatId = "chat-1") {
  queryState.current = {
    data: {
      enabled: true,
      embedUrl,
      chatId,
      envName: "ai02",
      branch: "task/hom-1029",
    },
    isLoading: false,
    refetch: vi.fn(),
  };
}

describe("IssueKannaSurface", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("keeps iframe src stable when only the one-time Kanna token changes", () => {
    const root = createRoot(container);
    const firstUrl = "https://atlas.homio.pro/chat/chat-1?kannaEmbedToken=token-one";
    const secondUrl = "https://atlas.homio.pro/chat/chat-1?kannaEmbedToken=token-two";

    setEmbedUrl(firstUrl);
    act(() => {
      root.render(
        <IssueKannaSurface
          issueId="issue-1029"
          companyId="company-1"
          enabled
          fallback={<div>fallback</div>}
        />,
      );
    });

    expect(container.querySelector("iframe")?.getAttribute("src")).toBe(firstUrl);

    setEmbedUrl(secondUrl);
    act(() => {
      root.render(
        <IssueKannaSurface
          issueId="issue-1029"
          companyId="company-1"
          enabled
          fallback={<div>fallback</div>}
        />,
      );
    });

    expect(container.querySelector("iframe")?.getAttribute("src")).toBe(firstUrl);

    act(() => {
      root.unmount();
    });
  });

  it("updates iframe src when the Kanna chat identity changes", () => {
    const root = createRoot(container);
    const firstUrl = "https://atlas.homio.pro/chat/chat-1?kannaEmbedToken=token-one";
    const secondUrl = "https://atlas.homio.pro/chat/chat-2?kannaEmbedToken=token-two";

    setEmbedUrl(firstUrl, "chat-1");
    act(() => {
      root.render(
        <IssueKannaSurface
          issueId="issue-1029"
          companyId="company-1"
          enabled
          fallback={<div>fallback</div>}
        />,
      );
    });

    setEmbedUrl(secondUrl, "chat-2");
    act(() => {
      root.render(
        <IssueKannaSurface
          issueId="issue-1029"
          companyId="company-1"
          enabled
          fallback={<div>fallback</div>}
        />,
      );
    });

    expect(container.querySelector("iframe")?.getAttribute("src")).toBe(secondUrl);

    act(() => {
      root.unmount();
    });
  });
});
