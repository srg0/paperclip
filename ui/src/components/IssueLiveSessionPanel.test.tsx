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
            turnLabel: "TURN 2",
            currentState: "Execution завершен и готов к review.",
            summary: "VerifyReport зеленый, evidence опубликован.",
            latestRequest: "Добавь double tap activation.",
            executorSummary: "Добавил double tap activation.",
            verifierScope: "Project media surface regression",
            verificationLimitations: ["Нужна ручная проверка double tap."],
            pendingRequests: ["норм делай mr"],
            turnHistory: [
              {
                sequence: 1,
                request: "Первичная fullscreen gallery",
                status: "settled",
                verifierScope: "Project media surface regression",
                outcome: "Итог готов для проверки человеком",
                startedAt: "2026-04-17T09:58:00.000Z",
                settledAt: "2026-04-17T10:06:00.000Z",
              },
              {
                sequence: 2,
                request: "Добавь double tap activation.",
                status: "settled",
                verifierScope: "Project media surface regression",
                outcome: "Итог готов для проверки человеком",
                startedAt: "2026-04-17T10:08:00.000Z",
                settledAt: "2026-04-17T10:18:00.000Z",
              },
            ],
            verifyStatus: "passed",
            evidenceUrl: "https://atlas.homio.pro/app/output/example.png",
            rawBody: "# Сводка выполнения Atlas\n\nTURN 2 raw body",
          }}
        />,
      );
    });

    expect(container.textContent).toContain("Execution narrative");
    expect(container.textContent).toContain("Settled");
    expect(container.textContent).toContain("1 run");
    expect(container.textContent).toContain("Atlas execution");
    expect(container.textContent).toContain("Projected turn");
    expect(container.textContent).toContain("TURN 2");
    expect(container.textContent).toContain("Latest executed request");
    expect(container.textContent).toContain("Turn history");
    expect(container.textContent).toContain("TURN 1");
    expect(container.textContent).toContain("TURN 2");
    expect(container.textContent).toContain("Executor said");
    expect(container.textContent).toContain("Добавил double tap activation.");
    expect(container.textContent).toContain("Still missing");
    expect(container.textContent).toContain("Нужна ручная проверка double tap.");
    expect(container.textContent).toContain("Newer user comments");
    expect(container.textContent).toContain("норм делай mr");

    act(() => {
      root.unmount();
    });
  });

  it("surfaces a projection warning for stale synthetic atlas turns", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <IssueLiveSessionPanel
          issueId="issue-2"
          companyId="company-1"
          atlasExecutionFallback={{
            updatedAt: "2026-04-17T10:18:00.000Z",
            turnLabel: "TURN 3",
            summary: "Atlas summary",
            currentState: "Execution settled",
            projectionWarning: "Issue already has a newer follow-up request than the current projected turn.",
          }}
        />,
      );
    });

    expect(container.textContent).toContain("TURN 3");
    expect(container.textContent).toContain("Execution settled");
    expect(container.textContent).toContain("Issue already has a newer follow-up request");

    act(() => {
      root.unmount();
    });
  });
});
