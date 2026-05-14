// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IssueKannaSurface } from "./IssueKannaSurface";

const queryState = vi.hoisted(() => ({
  kanna: {
    data: null as unknown,
    isLoading: false,
    refetch: vi.fn(),
  },
  issueExecution: {
    data: null as unknown,
    isLoading: false,
    refetch: vi.fn(),
  },
  calls: [] as Array<{ queryKey?: unknown[]; queryFn?: () => Promise<unknown> }>,
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: vi.fn((options: { queryKey?: unknown[]; queryFn?: () => Promise<unknown> }) => {
    queryState.calls.push(options);
    return options.queryKey?.[0] === "atlas-bridge-issue-execution"
      ? queryState.issueExecution
      : queryState.kanna;
  }),
}));

vi.mock("../../api/plugins", () => ({
  pluginsApi: {
    bridgeGetData: vi.fn(),
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function setEmbedUrl(embedUrl: string, chatId = "chat-1") {
  queryState.kanna = {
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
    queryState.kanna = {
      data: null,
      isLoading: false,
      refetch: vi.fn(),
    };
    queryState.issueExecution = {
      data: null,
      isLoading: false,
      refetch: vi.fn(),
    };
    queryState.calls = [];
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

  it("defaults in-review issues to the verifier Kanna role", () => {
    const root = createRoot(container);
    setEmbedUrl("https://atlas.homio.pro/chat/chat-1?kannaEmbedToken=token-one");

    act(() => {
      root.render(
        <IssueKannaSurface
          issueId="issue-1029"
          companyId="company-1"
          issueStatus="in_review"
          enabled
          fallback={<div>fallback</div>}
        />,
      );
    });

    const kannaQuery = queryState.calls.find((call) => call.queryKey?.[0] === "atlas-bridge-kanna-embed");
    expect(kannaQuery?.queryKey).toContain("technical_verifier");

    act(() => {
      root.unmount();
    });
  });

  it("renders clickable evidence above the Kanna iframe", () => {
    const root = createRoot(container);
    setEmbedUrl("https://atlas.homio.pro/chat/chat-1?kannaEmbedToken=token-one");
    queryState.issueExecution = {
      data: {
        currentExecution: {
          envName: "agrobazar-hmr",
        },
        human: {
          verifyStatus: "evidence_present",
          evidence: [{
            label: "HMR screenshot",
            url: "https://atlas.homio.pro/app/output/agrobazar-kanna/agr-16.png",
            kind: "screenshot",
            score: "strong",
            description: "Скриншот проверки на HMR.",
          }],
        },
      },
      isLoading: false,
      refetch: vi.fn(),
    };

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

    const evidenceLink = container.querySelector(
      'a[href="https://atlas.homio.pro/app/output/agrobazar-kanna/agr-16.png"]',
    );
    expect(evidenceLink?.textContent).toContain("HMR screenshot");
    expect(container.textContent).toContain("score: strong");
    expect(container.textContent).toContain("verify: evidence_present");

    act(() => {
      root.unmount();
    });
  });
});
