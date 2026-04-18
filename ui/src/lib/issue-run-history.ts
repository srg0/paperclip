import type { Agent } from "@paperclipai/shared";
import type { RunForIssue } from "../api/activity";

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function isBenignCheckoutConflictRun(run: RunForIssue, agents: Agent[] = []): boolean {
  if (run.status !== "failed") return false;
  const result = readRecord(run.resultJson);
  const stderr = readString(result?.stderr) ?? "";
  if (!stderr.includes("Issue checkout conflict")) return false;
  if (!stderr.includes("executionRunId")) return false;
  const agent = agents.find((candidate) => candidate.id === run.agentId) ?? null;
  const agentName = readString(agent?.name)?.toLowerCase() ?? "";
  if (agentName && agentName !== "delivery orchestrator") return false;
  return true;
}

export function filterIssueTimelineRuns(runs: RunForIssue[], agents: Agent[] = []): RunForIssue[] {
  return runs.filter((run) => !isBenignCheckoutConflictRun(run, agents));
}
