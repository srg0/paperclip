import { describe, expect, it } from "vitest";
import {
  buildLaunchActionBody,
  buildSyncActionBody,
  parseArgs,
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
    ])).toMatchObject({
      baseUrl: "https://paperclip.ai.k-digital.pro",
      companyPrefix: "HOM",
      agentName: "OpenClaw",
      issueId: "HOM-1",
      syncProbe: true,
    });
  });
});
