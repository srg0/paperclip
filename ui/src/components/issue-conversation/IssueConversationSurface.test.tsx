// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IssueConversationSurface } from "./IssueConversationSurface";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("IssueConversationSurface", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("renders only chat messages in the main single-chat surface", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <IssueConversationSurface
          chatMessages={[
            {
              id: "msg-user-1",
              speaker: "user",
              body: "Проверь, где мы сейчас.",
              createdAt: "2026-04-22T07:20:00.000Z",
              tone: "info",
            },
            {
              id: "msg-assistant-1",
              speaker: "assistant",
              body: "Принял. Проверяю текущий статус и отвечу сюда же.",
              createdAt: "2026-04-22T07:20:03.000Z",
              tone: "working",
              links: [{ label: "Открыть стенд", url: "https://ai01.homio.pro" }],
            },
          ]}
        />,
      );
    });

    expect(container.querySelector('[data-testid="issue-conversation-surface"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="issue-chat-thread"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="issue-followup-status"]')).toBeNull();
    expect(container.textContent).not.toContain("Chat messages will appear here once Atlas replies or the next turn starts.");
    expect(container.textContent).toContain("Проверь, где мы сейчас.");
    expect(container.textContent).toContain("Принял. Проверяю текущий статус и отвечу сюда же.");
    expect(container.textContent).toContain("Открыть стенд");

    act(() => {
      root.unmount();
    });
  });

  it("does not invent an empty-state panel when there are no chat messages", () => {
    const root = createRoot(container);

    act(() => {
      root.render(<IssueConversationSurface chatMessages={[]} />);
    });

    expect(container.querySelector('[data-testid="issue-chat-thread"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="issue-followup-status"]')).toBeNull();
    expect(container.textContent).not.toContain("Chat messages will appear here once Atlas replies or the next turn starts.");

    act(() => {
      root.unmount();
    });
  });

  it("keeps follow-up status visible and renders live feed in the main thread", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <IssueConversationSurface
          chatMessages={[
            {
              id: "msg-user-1",
              speaker: "user",
              body: "Ответь сюда коротко.",
              createdAt: "2026-04-22T07:20:00.000Z",
              tone: "info",
            },
            {
              id: "msg-assistant-1",
              speaker: "assistant",
              body: "Принял follow-up.",
              createdAt: "2026-04-22T07:20:02.000Z",
              tone: "working",
            },
          ]}
          pendingFollowupStatus={{
            state: "running",
            title: "Running",
            summary: "Atlas Executor",
            detail: "TURN 10 attached",
            turnLabel: "TURN 10",
          }}
          liveFeed={[
            {
              key: "feed-1",
              createdAt: "2026-04-22T07:20:04.000Z",
              title: "Atlas Executor: live output",
              summary: "Executor взял задачу в работу",
              tone: "working",
            },
          ]}
        />,
      );
    });

    const status = container.querySelector('[data-testid="issue-followup-status"]');
    expect(status).not.toBeNull();
    expect(status?.getAttribute("data-state")).toBe("running");
    expect(container.textContent).toContain("TURN 10");
    expect(container.textContent).toContain("Executor взял задачу в работу");
    expect(container.querySelectorAll('[data-testid="issue-live-feed-item"]').length).toBe(1);

    act(() => {
      root.unmount();
    });
  });
});
