// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IssueLiveSessionPanel } from "./IssueLiveSessionPanel";

vi.mock("@/lib/router", () => ({
  Link: ({ children, className, ...props }: React.ComponentProps<"a">) => (
    <a className={className} {...props}>{children}</a>
  ),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: vi.fn(() => ({ data: undefined })),
  useQueryClient: vi.fn(() => ({
    invalidateQueries: vi.fn(),
  })),
}));

vi.mock("./transcript/useLiveRunTranscripts", () => ({
  useLiveRunTranscripts: vi.fn(() => ({
    transcriptByRun: new Map(),
    hasOutputForRun: () => false,
  })),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("IssueLiveSessionPanel", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("renders a settled narrative card from atlas execution fallback when no live runs exist", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <IssueLiveSessionPanel
          issueId="issue-1"
          companyId="company-1"
          atlasExecutionFallback={{
            updatedAt: "2026-04-17T10:18:00.000Z",
            currentState: "Execution завершен и готов к review.",
            summary: "VerifyReport зеленый, evidence опубликован.",
            verifyStatus: "passed",
            evidenceUrl: "https://atlas.homio.pro/app/output/example.png",
          }}
        />,
      );
    });

    expect(container.textContent).toContain("Interactive Session");
    expect(container.textContent).toContain("Settled");
    expect(container.textContent).toContain("1 run");
    expect(container.textContent).toContain("Atlas execution");
    expect(container.textContent).toContain("VerifyReport зеленый, evidence опубликован.");

    act(() => {
      root.unmount();
    });
  });
});
