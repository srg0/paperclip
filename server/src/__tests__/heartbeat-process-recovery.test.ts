import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  companySkills,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { runningProcesses } from "../adapters/index.ts";
import { heartbeatService } from "../services/heartbeat.ts";
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const itLinuxOnly = process.platform === "linux" ? it : it.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat recovery tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function spawnAliveProcess() {
  return spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
}

async function waitForRunToLeaveActive(
  db: ReturnType<typeof createDb>,
  runId: string,
) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const run = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    if (run && run.status !== "queued" && run.status !== "running") return run.status;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return null;
}

describeEmbeddedPostgres("heartbeat orphaned process recovery", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const childProcesses = new Set<ChildProcess>();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-recovery-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    runningProcesses.clear();
    for (const child of childProcesses) {
      child.kill("SIGKILL");
    }
    childProcesses.clear();
    await db.delete(issues);
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(companySkills);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    for (const child of childProcesses) {
      child.kill("SIGKILL");
    }
    childProcesses.clear();
    runningProcesses.clear();
    await tempDb?.cleanup();
  });

  async function seedRunFixture(input?: {
    adapterType?: string;
    agentStatus?: "active" | "paused" | "terminated" | "pending_approval";
    runStatus?: "running" | "queued" | "failed";
    processPid?: number | null;
    processStartedAt?: Date | null;
    processLossRetryCount?: number;
    includeIssue?: boolean;
    runErrorCode?: string | null;
    runError?: string | null;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    const issueId = randomUUID();
    const now = new Date("2026-03-19T00:00:00.000Z");
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: input?.agentStatus ?? "paused",
      adapterType: input?.adapterType ?? "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: input?.includeIssue === false ? {} : { issueId },
      status: "claimed",
      runId,
      claimedAt: now,
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: input?.runStatus ?? "running",
      wakeupRequestId,
      contextSnapshot: input?.includeIssue === false ? {} : { issueId },
      processPid: input?.processPid ?? null,
      processStartedAt: input?.processStartedAt ?? null,
      processLossRetryCount: input?.processLossRetryCount ?? 0,
      errorCode: input?.runErrorCode ?? null,
      error: input?.runError ?? null,
      startedAt: now,
      updatedAt: new Date("2026-03-19T00:00:00.000Z"),
    });

    if (input?.includeIssue !== false) {
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: "Recover local adapter after lost process",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: agentId,
        checkoutRunId: runId,
        executionRunId: runId,
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
      });
    }

    return { companyId, agentId, runId, wakeupRequestId, issueId };
  }

  it("keeps a local run active when the recorded pid is still alive", async () => {
    const child = spawnAliveProcess();
    childProcesses.add(child);
    expect(child.pid).toBeTypeOf("number");

    const { runId, wakeupRequestId } = await seedRunFixture({
      processPid: child.pid ?? null,
      includeIssue: false,
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(0);

    const run = await heartbeat.getRun(runId);
    expect(run?.status).toBe("running");
    expect(run?.errorCode).toBe("process_detached");
    expect(run?.error).toContain(String(child.pid));

    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeupRequestId))
      .then((rows) => rows[0] ?? null);
    expect(wakeup?.status).toBe("claimed");
  });

  it("queues exactly one retry when the recorded local pid is dead", async () => {
    const { agentId, runId, issueId } = await seedRunFixture({
      processPid: 999_999_999,
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(1);
    expect(result.runIds).toEqual([runId]);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(2);

    const failedRun = runs.find((row) => row.id === runId);
    const retryRun = runs.find((row) => row.id !== runId);
    expect(failedRun?.status).toBe("failed");
    expect(failedRun?.errorCode).toBe("process_lost");
    expect(retryRun?.status).toBe("queued");
    expect(retryRun?.retryOfRunId).toBe(runId);
    expect(retryRun?.processLossRetryCount).toBe(1);

    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.executionRunId).toBe(retryRun?.id ?? null);
    expect(issue?.checkoutRunId).toBe(runId);
  });

  itLinuxOnly("treats an alive pid as lost when the recorded process start time no longer matches", async () => {
    const child = spawnAliveProcess();
    childProcesses.add(child);
    expect(child.pid).toBeTypeOf("number");

    const { agentId, runId, issueId } = await seedRunFixture({
      processPid: child.pid ?? null,
      processStartedAt: new Date("2000-01-01T00:00:00.000Z"),
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(1);
    expect(result.runIds).toEqual([runId]);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(2);

    const failedRun = runs.find((row) => row.id === runId);
    const retryRun = runs.find((row) => row.id !== runId);
    expect(failedRun?.status).toBe("failed");
    expect(failedRun?.errorCode).toBe("process_lost");
    expect(retryRun?.status).toBe("queued");
    expect(retryRun?.retryOfRunId).toBe(runId);

    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.executionRunId).toBe(retryRun?.id ?? null);
  });

  it("queues exactly one retry for issue-bound process adapters even when the pid was never recorded", async () => {
    const { agentId, runId, issueId } = await seedRunFixture({
      adapterType: "process",
      processPid: null,
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(1);
    expect(result.runIds).toEqual([runId]);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(2);

    const failedRun = runs.find((row) => row.id === runId);
    const retryRun = runs.find((row) => row.id !== runId);
    expect(failedRun?.status).toBe("failed");
    expect(failedRun?.errorCode).toBe("process_lost");
    expect(retryRun?.status).toBe("queued");
    expect(retryRun?.retryOfRunId).toBe(runId);
    expect(retryRun?.processLossRetryCount).toBe(1);

    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.executionRunId).toBe(retryRun?.id ?? null);
  });

  it("does not queue a second retry after the first process-loss retry was already used", async () => {
    const { agentId, runId, issueId } = await seedRunFixture({
      processPid: 999_999_999,
      processLossRetryCount: 1,
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(1);
    expect(result.runIds).toEqual([runId]);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("failed");

    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.executionRunId).toBeNull();
    expect(issue?.checkoutRunId).toBe(runId);
  });

  it("does not queue a retry for process adapters without issue context when the pid is missing", async () => {
    const { agentId, runId } = await seedRunFixture({
      adapterType: "process",
      processPid: null,
      includeIssue: false,
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(1);
    expect(result.runIds).toEqual([runId]);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("failed");
    expect(runs[0]?.errorCode).toBe("process_lost");
    expect(runs[0]?.retryOfRunId).toBeNull();
  });

  it("clears the detached warning when the run reports activity again", async () => {
    const { runId } = await seedRunFixture({
      includeIssue: false,
      runErrorCode: "process_detached",
      runError: "Lost in-memory process handle, but child pid 123 is still alive",
    });
    const heartbeat = heartbeatService(db);

    const updated = await heartbeat.reportRunActivity(runId);
    expect(updated?.errorCode).toBeNull();
    expect(updated?.error).toBeNull();

    const run = await heartbeat.getRun(runId);
    expect(run?.errorCode).toBeNull();
    expect(run?.error).toBeNull();
  });

  it("defers follow-up instead of coalescing into an already running issue execution", async () => {
    const { agentId, runId, issueId } = await seedRunFixture({
      agentStatus: "active",
      runStatus: "running",
    });
    const heartbeat = heartbeatService(db);

    const wakeResult = await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      contextSnapshot: { issueId, followup: true },
      reason: "follow_up",
      payload: { issueId, followup: true },
    });

    expect(wakeResult).toBeNull();

    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.executionRunId).toBe(runId);

    const wakes = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakes.some((row) => row.status === "coalesced")).toBe(false);
    expect(wakes.some((row) => row.status === "deferred_issue_execution")).toBe(true);
  });

  it("skips a stale directed comment wake before promoting the current assignee wake", async () => {
    const { companyId, agentId: verifierAgentId, runId, issueId } = await seedRunFixture({
      agentStatus: "active",
      runStatus: "running",
    });
    const deliveryAgentId = randomUUID();
    await db.insert(agents).values({
      id: deliveryAgentId,
      companyId,
      name: "Delivery Agent",
      role: "engineer",
      status: "active",
      adapterType: "process",
      adapterConfig: { command: process.execPath, args: ["-e", ""], timeoutSec: 5 },
      runtimeConfig: {},
      permissions: {},
    });

    const heartbeat = heartbeatService(db);

    await heartbeat.wakeup(verifierAgentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: {
        issueId,
        commentId: randomUUID(),
        mutation: "comment",
      },
      contextSnapshot: {
        issueId,
        taskId: issueId,
        wakeReason: "issue_commented",
        source: "issue.comment.directed",
        directedCommentTargetId: verifierAgentId,
      },
    });

    await db
      .update(issues)
      .set({
        assigneeAgentId: deliveryAgentId,
        updatedAt: new Date(),
      })
      .where(eq(issues.id, issueId));

    await heartbeat.wakeup(deliveryAgentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      contextSnapshot: {
        issueId,
        taskId: issueId,
        wakeReason: "issue_assigned",
        source: "issue.assignment",
      },
    });

    const cancelled = await heartbeat.cancelRun(runId);
    expect(cancelled?.status).toBe("cancelled");

    const verifierWake = await db
      .select()
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.agentId, verifierAgentId),
          eq(agentWakeupRequests.reason, "stale_directed_comment_target"),
        ),
      )
      .then((rows) => rows[0] ?? null);
    expect(verifierWake?.status).toBe("skipped");
    expect(verifierWake?.error).toContain("issue is no longer assigned");

    const deliveryWake = await db
      .select()
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.agentId, deliveryAgentId), eq(agentWakeupRequests.reason, "issue_execution_promoted")))
      .then((rows) => rows[0] ?? null);
    expect(deliveryWake?.runId).toBeTruthy();
    const deliveryRunStatus = await waitForRunToLeaveActive(db, deliveryWake?.runId ?? "");
    expect(deliveryRunStatus).toBe("succeeded");

    const deliveryRun = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, deliveryWake?.runId ?? ""))
      .then((rows) => rows[0] ?? null);
    expect(deliveryRun).toBeTruthy();
    expect(deliveryRun?.agentId).toBe(deliveryAgentId);

    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.executionRunId === null || issue?.executionRunId === deliveryRun?.id).toBe(true);
    expect(issue?.executionAgentNameKey === null || issue?.executionAgentNameKey === "delivery agent").toBe(true);

    const pendingDeferred = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.status, "deferred_issue_execution"));
    expect(pendingDeferred).toHaveLength(0);
  });

  it("does not coalesce workspace reroute follow-up into a queued issue execution", async () => {
    const { agentId, runId, issueId } = await seedRunFixture({
      agentStatus: "active",
      runStatus: "queued",
    });
    const heartbeat = heartbeatService(db);

    const wakeResult = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      contextSnapshot: { issueId },
      reason: "workspace_reroute_followup",
      payload: { issueId },
    });

    expect(wakeResult).toBeNull();

    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.executionRunId).toBe(runId);

    const wakes = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(
      wakes.some(
        (row) =>
          row.status === "coalesced" &&
          row.reason === "issue_execution_same_name",
      ),
    ).toBe(false);
    expect(
      wakes.some(
        (row) =>
          row.status === "deferred_issue_execution" &&
          row.reason === "issue_execution_deferred",
      ),
    ).toBe(true);
  });

  it("defers follow-up instead of spawning a new root run while process-loss retry is still pending", async () => {
    const { agentId, runId, issueId } = await seedRunFixture({
      agentStatus: "active",
      runStatus: "failed",
      processPid: 999_999_999,
      runErrorCode: "process_lost",
      runError: "Process lost -- child pid 999999999 is no longer running; retrying once",
    });
    const heartbeat = heartbeatService(db);

    const wakeResult = await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      contextSnapshot: { issueId, followup: true },
      reason: "follow_up",
      payload: { issueId, followup: true },
    });

    expect(wakeResult).toBeNull();

    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.executionRunId).toBe(runId);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(1);
    expect(runs[0]?.id).toBe(runId);

    const deferredWake = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .then((rows) =>
        rows.find((row) => row.status === "deferred_issue_execution" && row.reason === "issue_execution_process_loss_retry_pending") ?? null,
      );
    expect(deferredWake).toBeTruthy();
  });

  it("defers follow-up while a process adapter retry is still pending even when the lost run never recorded a pid", async () => {
    const { agentId, runId, issueId } = await seedRunFixture({
      adapterType: "process",
      agentStatus: "active",
      runStatus: "failed",
      processPid: null,
      runErrorCode: "process_lost",
      runError: "Process lost -- server may have restarted; retrying once",
    });
    const heartbeat = heartbeatService(db);

    const wakeResult = await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      contextSnapshot: { issueId, followup: true },
      reason: "follow_up",
      payload: { issueId, followup: true },
    });

    expect(wakeResult).toBeNull();

    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.executionRunId).toBe(runId);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(1);
    expect(runs[0]?.id).toBe(runId);

    const deferredWake = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .then((rows) =>
        rows.find((row) => row.status === "deferred_issue_execution" && row.reason === "issue_execution_process_loss_retry_pending") ?? null,
      );
    expect(deferredWake).toBeTruthy();
  });
});
