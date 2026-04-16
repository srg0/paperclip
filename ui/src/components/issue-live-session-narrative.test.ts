// @vitest-environment node

import { describe, expect, it } from "vitest";
import type { TranscriptEntry } from "../adapters";
import { buildNarrativeSummary } from "./issue-live-session-narrative";

describe("buildNarrativeSummary", () => {
  it("turns active command execution into a readable current-focus step", () => {
    const entries: TranscriptEntry[] = [
      {
        kind: "init",
        ts: "2026-04-17T10:00:00.000Z",
        model: "gpt-5.4-mini",
        sessionId: "sess_1",
      },
      {
        kind: "tool_call",
        ts: "2026-04-17T10:00:01.000Z",
        name: "command_execution",
        toolUseId: "cmd_1",
        input: { command: "rg \"Interactive Session\" ui/src" },
      },
      {
        kind: "stdout",
        ts: "2026-04-17T10:00:02.000Z",
        text: "ui/src/pages/IssueDetail.tsx",
      },
    ];

    const summary = buildNarrativeSummary(entries, true);

    expect(summary.current).toMatchObject({
      title: "Shell command running",
      tone: "working",
    });
    expect(summary.current?.detail).toContain("IssueDetail");
    expect(summary.statusLine).toContain("Comment below");
  });

  it("surfaces final results as review-ready narrative checkpoints", () => {
    const entries: TranscriptEntry[] = [
      {
        kind: "assistant",
        ts: "2026-04-17T10:00:00.000Z",
        text: "Implemented the interactive session panel.",
      },
      {
        kind: "result",
        ts: "2026-04-17T10:00:03.000Z",
        text: "Verified locally. Ready for review.",
        inputTokens: 10,
        outputTokens: 20,
        cachedTokens: 0,
        costUsd: 0.01,
        subtype: "completed",
        isError: false,
        errors: [],
      },
    ];

    const summary = buildNarrativeSummary(entries, false);

    expect(summary.current).toMatchObject({
      title: "Result is ready",
      tone: "success",
      detail: "Verified locally. Ready for review.",
    });
    expect(summary.statusLine).toContain("ready for review");
  });

  it("highlights stderr as an error checkpoint", () => {
    const entries: TranscriptEntry[] = [
      {
        kind: "stderr",
        ts: "2026-04-17T10:00:00.000Z",
        text: "command failed: permission denied",
      },
    ];

    const summary = buildNarrativeSummary(entries, false);

    expect(summary.current).toMatchObject({
      title: "Error output received",
      tone: "error",
    });
    expect(summary.statusLine).toContain("needs attention");
  });
});
