import { describe, expect, it } from "vitest";
import type { Agent } from "@paperclipai/shared";
import type { RunForIssue } from "../api/activity";
import { filterIssueTimelineRuns, isBenignCheckoutConflictRun } from "./issue-run-history";

const deliveryAgent = {
  id: "delivery-1",
  companyId: "co-1",
  name: "Delivery Orchestrator",
  role: "ops",
  adapterType: "local",
  model: null,
  temperature: null,
  systemPrompt: "",
  prompt: "",
  config: null,
  status: "active",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  icon: null,
  urlKey: null,
  pausedAt: null,
  pauseReason: null,
  terminatedAt: null,
  terminationReason: null,
  defaultProjectId: null,
} as unknown as Agent;

function makeRun(overrides: Partial<RunForIssue> = {}): RunForIssue {
  return {
    runId: "run-1",
    status: "failed",
    agentId: "delivery-1",
    startedAt: "2026-04-18T02:56:38.258Z",
    finishedAt: "2026-04-18T02:56:41.379Z",
    createdAt: "2026-04-18T02:56:38.182Z",
    invocationSource: "assignment",
    usageJson: null,
    resultJson: {
      stderr: "POST /api/issues/x/checkout failed: 409 {\"error\":\"Issue checkout conflict\",\"details\":{\"executionRunId\":\"run-1\"}}",
    },
    ...overrides,
  };
}

describe("issue run history filtering", () => {
  it("classifies delivery checkout conflicts as benign timeline noise", () => {
    expect(isBenignCheckoutConflictRun(makeRun(), [deliveryAgent])).toBe(true);
  });

  it("keeps non-conflict failed runs visible", () => {
    expect(
      isBenignCheckoutConflictRun(
        makeRun({
          resultJson: { stderr: "Unhandled exception without checkout conflict" },
        }),
        [deliveryAgent],
      ),
    ).toBe(false);
  });

  it("filters only the benign delivery conflict entries from timeline runs", () => {
    const kept = makeRun({
      runId: "run-2",
      resultJson: { stderr: "Unhandled exception without checkout conflict" },
    });
    expect(filterIssueTimelineRuns([makeRun(), kept], [deliveryAgent]).map((run) => run.runId)).toEqual(["run-2"]);
  });
});
