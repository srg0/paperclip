import { describe, expect, it } from "vitest";
import {
  buildCreateIssueBody,
  buildDataProbeBody,
  buildRetryActionBody,
  buildFollowupActionBody,
  buildIssueOriginLookupUrl,
  buildLaunchActionBody,
  buildProofHeartbeatRunRecord,
  buildSkippedHeartbeatRunRecord,
  findPlugin,
  buildSyncActionBody,
  parseArgs,
  summarizeFetchError,
  summarizeHttpResult,
} from "../../../scripts/hmr-plugin-route-auth-proof.mjs";

describe("hmr plugin route auth proof helper", () => {
  it("builds action bodies with top-level and nested company scope", () => {
    expect(buildSyncActionBody("company-1", "issue-1")).toMatchObject({
      companyId: "company-1",
      params: {
        companyId: "company-1",
        issueId: "issue-1",
      },
    });

    expect(buildLaunchActionBody("company-1", "issue-1", { repo: "homio/core", envName: "ai01" })).toMatchObject({
      companyId: "company-1",
      params: {
        companyId: "company-1",
        issueId: "issue-1",
        repo: "homio/core",
        envName: "ai01",
      },
    });

    expect(buildFollowupActionBody("company-1", "issue-1", {
      repo: "homio/core",
      envName: "ai01",
      request: "continue the same HMR proof",
      branch: "task/paperclip-hmr-positive-replay",
      currentAtlasTaskId: "paperclip-issue-t2",
      taskId: "paperclip-issue-t3",
      turnNumber: 3,
      turnLabel: "TURN 3",
    })).toEqual({
      companyId: "company-1",
      params: {
        companyId: "company-1",
        issueId: "issue-1",
        repo: "homio/core",
        envName: "ai01",
        request: "continue the same HMR proof",
        branch: "task/paperclip-hmr-positive-replay",
        currentAtlasTaskId: "paperclip-issue-t2",
        taskId: "paperclip-issue-t3",
        turnNumber: 3,
        turnLabel: "TURN 3",
      },
    });

    expect(buildRetryActionBody("company-1", "issue-1", {
      repo: "homio/core",
      envName: "ai01",
      request: "retry after verifier env repair",
      maxRetryExecutions: 1,
      minBackoffMs: 0,
      repairVerificationKey: "def-hmr-verify-env-012@7517b200",
      repairProofRef: "repair-cycle-def-hmr-verify-env-012.md",
    })).toEqual({
      companyId: "company-1",
      params: {
        companyId: "company-1",
        issueId: "issue-1",
        repo: "homio/core",
        envName: "ai01",
        request: "retry after verifier env repair",
        maxRetryExecutions: 1,
        minBackoffMs: 0,
        repairVerificationKey: "def-hmr-verify-env-012@7517b200",
        repairProofRef: "repair-cycle-def-hmr-verify-env-012.md",
      },
    });
  });

  it("builds data probe bodies with top-level and nested company scope", () => {
    expect(buildDataProbeBody("company-1", "issue-1")).toEqual({
      companyId: "company-1",
      params: {
        companyId: "company-1",
        issueId: "issue-1",
      },
    });
  });

  it("treats only 401 and 403 as route auth failures", () => {
    expect(summarizeHttpResult(403, '{"error":"Board access required"}')).toMatchObject({
      routeAuthOk: false,
    });
    expect(summarizeHttpResult(502, '{"code":"PLUGIN_ERROR"}')).toMatchObject({
      routeAuthOk: true,
    });
  });

  it("parses probe options without exposing credential material", () => {
    expect(parseArgs([
      "--base-url",
      "https://paperclip.ai.k-digital.pro",
      "--company-prefix",
      "HOM",
      "--agent-name",
      "OpenClaw",
      "--issue-id",
      "HOM-1",
      "--sync-probe",
      "--followup-probe",
      "--retry-probe",
      "--data-probe",
      "--data-key",
      "atlas-bridge-issue-execution",
      "--branch",
      "task/paperclip-hmr-positive-replay",
      "--current-atlas-task-id",
      "paperclip-issue-t2",
      "--turn-number",
      "3",
      "--turn-label",
      "TURN 3",
      "--max-retry-executions",
      "1",
      "--min-backoff-ms",
      "0",
      "--repair-verification-key",
      "def-hmr-verify-env-012@7517b200",
      "--repair-proof-ref",
      "repair-cycle-def-hmr-verify-env-012.md",
      "--skip-heartbeat-run",
    ])).toMatchObject({
      baseUrl: "https://paperclip.ai.k-digital.pro",
      companyPrefix: "HOM",
      agentName: "OpenClaw",
      issueId: "HOM-1",
      syncProbe: true,
      followupProbe: true,
      retryProbe: true,
      dataProbe: true,
      dataKey: "atlas-bridge-issue-execution",
      branch: "task/paperclip-hmr-positive-replay",
      currentAtlasTaskId: "paperclip-issue-t2",
      turnNumber: 3,
      turnLabel: "TURN 3",
      maxRetryExecutions: 1,
      minBackoffMs: 0,
      repairVerificationKey: "def-hmr-verify-env-012@7517b200",
      repairProofRef: "repair-cycle-def-hmr-verify-env-012.md",
      skipHeartbeatRun: true,
    });
  });

  it("finds plugins across supported discovery response shapes", () => {
    expect(findPlugin({
      body: [
        {
          id: "plugin-uuid",
          pluginKey: "homio.atlas-bridge",
          version: "0.0.145",
        },
      ],
    }, "homio.atlas-bridge")).toMatchObject({
      id: "plugin-uuid",
    });

    expect(findPlugin({
      body: {
        plugins: [
          {
            id: "plugin-uuid",
            manifest: {
              pluginKey: "homio.atlas-bridge",
            },
          },
        ],
      },
    }, "homio.atlas-bridge")).toMatchObject({
      id: "plugin-uuid",
    });
  });

  it("builds a persisted heartbeat run context for local JWT proof", () => {
    const now = new Date("2026-07-01T00:00:00.000Z");
    expect(buildProofHeartbeatRunRecord({
      runId: "11111111-1111-4111-8111-111111111111",
      companyId: "22222222-2222-4222-8222-222222222222",
      agentId: "33333333-3333-4333-8333-333333333333",
      now,
    })).toMatchObject({
      id: "11111111-1111-4111-8111-111111111111",
      companyId: "22222222-2222-4222-8222-222222222222",
      agentId: "33333333-3333-4333-8333-333333333333",
      invocationSource: "hmr_plugin_route_auth_proof",
      triggerDetail: "local_agent_jwt_route_proof",
      status: "succeeded",
      startedAt: now,
      finishedAt: now,
      resultJson: {
        proof: "hmr_plugin_route_auth",
        routeContext: "public_paperclip_api",
      },
    });
  });

  it("can skip heartbeat run insertion for read-only proof", () => {
    expect(buildSkippedHeartbeatRunRecord("11111111-1111-4111-8111-111111111111")).toEqual({
      id: "11111111-1111-4111-8111-111111111111",
      created: false,
      skipped: true,
      status: "skipped",
      reason: "skip_heartbeat_run",
    });
  });

  it("serializes fetch failures as route results", () => {
    const result = summarizeFetchError(
      new TypeError("fetch failed", { cause: Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" }) }),
      "https://paperclip.ai.k-digital.pro/api/plugins",
    );

    expect(result).toMatchObject({
      status: null,
      transportOk: false,
      routeAuthOk: null,
      body: null,
      error: {
        name: "TypeError",
        message: "fetch failed",
        url: "https://paperclip.ai.k-digital.pro/api/plugins",
        cause: {
          code: "ETIMEDOUT",
          message: "connect ETIMEDOUT",
        },
      },
    });
  });

  it("builds origin-scoped issue create payloads and lookup URLs", () => {
    expect(parseArgs([
      "--create-issue",
      "--issue-title",
      "HMR replay",
      "--origin-kind",
      "smoke_orchestrator_hmr_positive_replay",
      "--origin-id",
      "atlas-verifier-positive-001",
      "--run-id",
      "11111111-1111-4111-8111-111111111111",
    ])).toMatchObject({
      createIssue: true,
      issueTitle: "HMR replay",
      originKind: "smoke_orchestrator_hmr_positive_replay",
      originId: "atlas-verifier-positive-001",
      runId: "11111111-1111-4111-8111-111111111111",
    });

    expect(buildCreateIssueBody({
      title: "HMR replay",
      description: "positive replay",
      status: "backlog",
      priority: "high",
      originKind: "smoke_orchestrator_hmr_positive_replay",
      originId: "atlas-verifier-positive-001",
    })).toEqual({
      title: "HMR replay",
      description: "positive replay",
      status: "backlog",
      priority: "high",
      originKind: "smoke_orchestrator_hmr_positive_replay",
      originId: "atlas-verifier-positive-001",
    });

    expect(buildIssueOriginLookupUrl(
      "https://paperclip.ai.k-digital.pro",
      "22222222-2222-4222-8222-222222222222",
      "smoke_orchestrator_hmr_positive_replay",
      "atlas verifier positive/001",
    )).toBe("https://paperclip.ai.k-digital.pro/api/companies/22222222-2222-4222-8222-222222222222/issues?originKind=smoke_orchestrator_hmr_positive_replay&originId=atlas+verifier+positive%2F001&limit=10");
  });
});
