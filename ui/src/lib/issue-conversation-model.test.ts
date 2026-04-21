import { describe, expect, it } from "vitest";
import type { LiveRunForIssue } from "../api/heartbeats";
import { buildIssueConversationModel } from "./issue-conversation-model";
import type { IssueExecutionCommentContext } from "./issue-execution-turns";

function makeContext(overrides: Partial<IssueExecutionCommentContext> = {}): IssueExecutionCommentContext {
  return {
    turns: [
      {
        sequence: 1,
        request: "Сделай HyperFrames рабочим в create social post.",
        startedAt: "2026-04-21T18:00:00.000Z",
        settledAt: "2026-04-21T18:05:00.000Z",
        status: "settled",
        verifierScope: null,
        standUrl: null,
        evidenceUrl: null,
        outcome: "TURN 1 завершён",
        latestCommentId: "comment-1",
        events: [
          {
            role: "Reporter",
            title: "TURN 1 завершён",
            summary: "Первый turn закончился.",
            createdAt: "2026-04-21T18:05:00.000Z",
            sourceCommentId: "comment-1",
          },
        ],
      },
      {
        sequence: 2,
        request: "Покажи живые статусы прямо в чате.",
        startedAt: "2026-04-21T18:10:00.000Z",
        settledAt: "2026-04-21T18:12:00.000Z",
        status: "settled",
        verifierScope: null,
        standUrl: null,
        evidenceUrl: null,
        outcome: "TURN 2 завершён",
        latestCommentId: "comment-2",
        events: [
          {
            role: "Reporter",
            title: "TURN 2 завершён",
            summary: "Второй turn закончился.",
            createdAt: "2026-04-21T18:12:00.000Z",
            sourceCommentId: "comment-2",
          },
        ],
      },
    ],
    latestExecutedTurn: null,
    pendingUserRequests: [
      "старый follow-up 1",
      "старый follow-up 2",
      "чек",
    ],
    projectionWarning: "После последнего Atlas turn появились новые user comments (3), но новый execution ещё не начался.",
    ...overrides,
  };
}

function makeLiveRun(overrides: Partial<LiveRunForIssue> = {}): LiveRunForIssue {
  return {
    id: "paperclip-issue-t3-123",
    status: "running",
    invocationSource: "atlas_execution",
    triggerDetail: "TURN 3",
    startedAt: "2026-04-21T18:19:25.433Z",
    finishedAt: null,
    createdAt: "2026-04-21T18:19:25.433Z",
    agentId: "agent-atlas",
    agentName: "Atlas Executor",
    adapterType: "atlas_execution",
    issueId: "issue-1",
    syntheticSource: "atlas_execution",
    openable: false,
    slotEnv: "ai01",
    ...overrides,
  };
}

describe("buildIssueConversationModel", () => {
  it("folds stale pending requests under the current live launch and shows the actual turn label", () => {
    const model = buildIssueConversationModel({
      context: makeContext(),
      liveRuns: [makeLiveRun()],
      transcriptByRun: new Map(),
      verbosity: "auto",
    });

    expect(model.turns).toHaveLength(3);
    const pendingTurn = model.turns.at(-1);
    expect(pendingTurn?.turnLabel).toBe("TURN 3");
    expect(pendingTurn?.request).toBe("чек");
    expect(pendingTurn?.status).toBe("running");
    expect(pendingTurn?.summary).toContain("TURN 3");
    expect(pendingTurn?.summary).toContain("Atlas Executor");
    expect(pendingTurn?.summary).toContain("slot ai01");
    expect(pendingTurn?.summary).toContain("2 earlier messages folded");
    expect(pendingTurn?.nextAction).toContain("2 earlier follow-up messages");
  });
});
