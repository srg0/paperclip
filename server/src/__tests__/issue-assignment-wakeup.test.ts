import { describe, expect, it, vi } from "vitest";
import { queueIssueAssignmentWakeup } from "../services/issue-assignment-wakeup.js";

describe("queueIssueAssignmentWakeup", () => {
  it("wakes assigned actionable issues", async () => {
    const wakeup = vi.fn().mockResolvedValue(null);

    await queueIssueAssignmentWakeup({
      heartbeat: { wakeup },
      issue: { id: "issue-1", assigneeAgentId: "agent-1", status: "todo" },
      reason: "issue_assigned",
      mutation: "create",
      contextSource: "issue.create",
    });

    expect(wakeup).toHaveBeenCalledWith(
      "agent-1",
      expect.objectContaining({
        source: "assignment",
        reason: "issue_assigned",
        payload: { issueId: "issue-1", mutation: "create" },
      }),
    );
  });

  it("does not wake backlog issues", async () => {
    const wakeup = vi.fn().mockResolvedValue(null);

    await queueIssueAssignmentWakeup({
      heartbeat: { wakeup },
      issue: { id: "issue-1", assigneeAgentId: "agent-1", status: "backlog" },
      reason: "issue_assigned",
      mutation: "create",
      contextSource: "issue.create",
    });

    expect(wakeup).not.toHaveBeenCalled();
  });

  it("does not wake terminal issues", async () => {
    const wakeup = vi.fn().mockResolvedValue(null);

    for (const status of ["done", "cancelled"]) {
      await queueIssueAssignmentWakeup({
        heartbeat: { wakeup },
        issue: { id: `issue-${status}`, assigneeAgentId: "agent-1", status },
        reason: "issue_assigned",
        mutation: "create",
        contextSource: "issue.create",
      });
    }

    expect(wakeup).not.toHaveBeenCalled();
  });

  it("does not wake dependency-blocked issues", async () => {
    const wakeup = vi.fn().mockResolvedValue(null);

    await queueIssueAssignmentWakeup({
      heartbeat: { wakeup },
      issue: { id: "issue-1", assigneeAgentId: "agent-1", status: "blocked" },
      reason: "issue_assigned",
      mutation: "create",
      contextSource: "issue.create",
      dependencyBlocked: true,
    });

    expect(wakeup).not.toHaveBeenCalled();
  });
});
