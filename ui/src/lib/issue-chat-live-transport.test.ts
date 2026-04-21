import { describe, expect, it } from "vitest";
import type { LiveEvent } from "@paperclipai/shared";
import { normalizeIssueChatLiveEvent } from "./issue-chat-live-transport";

const ISSUE = {
  id: "issue-1",
  identifier: "HOM-957",
};

const AGENTS = [
  {
    id: "agent-atlas",
    name: "Atlas Executor",
  },
] as const;

function makeLiveEvent(input: Partial<LiveEvent> & { type: LiveEvent["type"] }): LiveEvent {
  return {
    id: 1,
    companyId: "company-1",
    createdAt: "2026-04-21T08:00:00.000Z",
    payload: {},
    ...input,
  };
}

describe("normalizeIssueChatLiveEvent", () => {
  it("maps accepted follow-up activity into a live signal", () => {
    const update = normalizeIssueChatLiveEvent({
      issue: ISSUE,
      agents: AGENTS as never,
      event: makeLiveEvent({
        type: "activity.logged",
        payload: {
          action: "issue.followup_requested",
          entityType: "issue",
          entityId: ISSUE.id,
          agentId: "agent-atlas",
          details: {
            nextTurn: 7,
          },
        },
      }),
    });

    expect(update?.signal).toMatchObject({
      state: "accepted",
      title: "Thinking",
      turnLabel: "TURN 7",
    });
    expect(update?.feedItem?.title).toBe("Thinking");
    expect(update?.feedItem?.summary).toBe("TURN 7");
  });

  it("maps accepted directed-agent activity into a live signal", () => {
    const update = normalizeIssueChatLiveEvent({
      issue: ISSUE,
      agents: AGENTS as never,
      event: makeLiveEvent({
        type: "activity.logged",
        payload: {
          action: "issue.followup_requested",
          entityType: "issue",
          entityId: ISSUE.id,
          agentId: "agent-atlas",
          details: {
            requestType: "directed_agent",
            targetAgentId: "agent-atlas",
            detail: "Прямой ответ агента поставлен в очередь.",
          },
        },
      }),
    });

    expect(update?.signal?.state).toBe("accepted");
    expect(update?.feedItem?.title).toBe("Thinking");
    expect(update?.feedItem?.summary).toBe("Atlas Executor");
  });

  it("maps blocked follow-up activity into a blocked live signal", () => {
    const update = normalizeIssueChatLiveEvent({
      issue: ISSUE,
      agents: AGENTS as never,
      event: makeLiveEvent({
        type: "activity.logged",
        payload: {
          action: "issue.followup_blocked",
          entityType: "issue",
          entityId: ISSUE.id,
          details: {
            error: "Bridge worker is not running",
            turnNumber: 8,
          },
        },
      }),
    });

    expect(update?.signal).toMatchObject({
      state: "blocked",
      title: "Blocked",
      turnLabel: "TURN 8",
    });
    expect(update?.feedItem?.title).toBe("Blocked");
    expect(update?.feedItem?.summary).toContain("Bridge worker is not running");
  });

  it("maps queued and running heartbeat events when they belong to the issue", () => {
    const queued = normalizeIssueChatLiveEvent({
      issue: ISSUE,
      agents: AGENTS as never,
      event: makeLiveEvent({
        type: "heartbeat.run.queued",
        payload: {
          issueId: ISSUE.id,
          agentId: "agent-atlas",
        },
      }),
    });
    const running = normalizeIssueChatLiveEvent({
      issue: ISSUE,
      agents: AGENTS as never,
      event: makeLiveEvent({
        id: 2,
        type: "heartbeat.run.status",
        payload: {
          issueId: ISSUE.id,
          agentId: "agent-atlas",
          status: "running",
        },
      }),
    });

    expect(queued?.signal?.state).toBe("queued");
    expect(queued?.signal?.title).toBe("Starting");
    expect(running?.signal?.state).toBe("running");
    expect(running?.signal?.title).toBe("Running");
    expect(running?.feedItem?.title).toBe("Running");
    expect(running?.feedItem?.summary).toBe("Atlas Executor");
  });

  it("maps run log chunks into live feed output", () => {
    const update = normalizeIssueChatLiveEvent({
      issue: ISSUE,
      agents: AGENTS as never,
      event: makeLiveEvent({
        type: "heartbeat.run.log",
        payload: {
          issueId: ISSUE.id,
          agentId: "agent-atlas",
          stream: "stdout",
          chunk: "thinking...\nloading files",
        },
      }),
    });

    expect(update?.signal).toBeNull();
    expect(update?.feedItem).toMatchObject({
      title: "Atlas Executor: live output",
      summary: "loading files",
      tone: "working",
    });
  });

  it("ignores unrelated live events", () => {
    const update = normalizeIssueChatLiveEvent({
      issue: ISSUE,
      agents: AGENTS as never,
      event: makeLiveEvent({
        type: "heartbeat.run.status",
        payload: {
          issueId: "issue-2",
          status: "running",
        },
      }),
    });

    expect(update).toBeNull();
  });
});
