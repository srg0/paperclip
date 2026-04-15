import type { ActivityEvent, Agent, Issue, IssueDocument } from "@paperclipai/shared";
import type { RunForIssue } from "@/api/activity";
import type { ActiveRunForIssue, LiveRunForIssue } from "@/api/heartbeats";

export type IssueExecutionStageKey =
  | "orchestrate"
  | "atlas_execute"
  | "stand_apply"
  | "verify"
  | "report";

export type IssueExecutionStageState =
  | "not_started"
  | "running"
  | "passed"
  | "blocked"
  | "failed"
  | "skipped"
  | "looping"
  | "retrying";

export interface IssueExecutionHeaderStage {
  key: IssueExecutionStageKey;
  label: string;
  ownerLabel: string;
  ownerKey: string;
  ownerIcon: string | null;
  state: IssueExecutionStageState;
  countBadge: string | null;
  note: string | null;
}

export interface ParsedExecutionDocument {
  headline: string | null;
  summary: string | null;
  nextStep: string | null;
  standUrl: string | null;
  evidenceUrl: string | null;
  verifyStatus: string | null;
  turnLabel: string | null;
  turnNumber: number | null;
  executionState: string | null;
  attachmentState: string | null;
  failureClass: string | null;
  retryCount: number;
  artifactCount: number | null;
  slotEnv: string | null;
  slotBranch: string | null;
  slotStatus: string | null;
  updatedAt: string | null;
  recentMilestones: ParsedExecutionMilestone[];
}

export interface ParsedExecutionMilestone {
  role: string;
  title: string;
  summary: string;
  at: string | null;
}

export interface IssueExecutionHeaderModel {
  currentAgent: string;
  expectedNext: string;
  actualNextObserved: string;
  flowStatus: string;
  flowSeverity: "neutral" | "success" | "warning" | "error";
  standLabel: string | null;
  executionStateLabel: string;
  elapsedLabel: string | null;
  lastUpdatedAt: string | null;
  turnLabel: string;
  loopLabel: string;
  retryLabel: string;
  mismatchText: string | null;
  headline: string | null;
  summary: string | null;
  nextStep: string | null;
  stages: IssueExecutionHeaderStage[];
  milestones: ParsedExecutionMilestone[];
  evidenceUrl: string | null;
  standUrl: string | null;
}

type StageDefinition = {
  key: IssueExecutionStageKey;
  label: string;
  ownerKey: string;
  ownerLabel: string;
};

const STAGES: StageDefinition[] = [
  { key: "orchestrate", label: "Orchestrate", ownerKey: "delivery-orchestrator", ownerLabel: "Delivery Orchestrator" },
  { key: "atlas_execute", label: "Atlas Execute", ownerKey: "atlas-executor", ownerLabel: "Atlas Executor" },
  { key: "stand_apply", label: "Stand Apply", ownerKey: "stand-controller", ownerLabel: "Stand Controller" },
  { key: "verify", label: "Verify", ownerKey: "technical-verifier", ownerLabel: "Technical Verifier" },
  { key: "report", label: "Report", ownerKey: "reporter", ownerLabel: "Reporter" },
];

const FIELD_PATTERNS = {
  nextStep: /^- Следующий шаг: (.+)$/m,
  verifyStatus: /^- Проверка: `([^`]+)`$/m,
  evidenceUrl: /^- Evidence: (.+)$/m,
  turnLabel: /^- Turn: `([^`]+)`$/m,
  executionState: /^- Execution state: `([^`]+)`$/m,
  attachmentState: /^- Attachment state: `([^`]+)`$/m,
  failureClass: /^- Failure class: `([^`]+)`$/m,
  retryCount: /^- Retry count: `([^`]+)`$/m,
  artifactCount: /^- Artifact count: `([^`]+)`$/m,
  slotEnv: /^- Slot env: `([^`]+)`$/m,
  slotBranch: /^- Slot branch: `([^`]+)`$/m,
  slotStatus: /^- Slot status: `([^`]+)`$/m,
  standUrl: /^- Открыть стенд: (.+)$/m,
  updatedAt: /^- Projection updated: `([^`]+)`$/m,
};

const STAGE_KEYS = new Set(STAGES.map((stage) => stage.key));

function parseField(pattern: RegExp, body: string): string | null {
  const match = pattern.exec(body);
  return match?.[1]?.trim() || null;
}

function parseIntField(value: string | null): number {
  if (!value) return 0;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseTurnNumber(turnLabel: string | null): number | null {
  if (!turnLabel) return null;
  const match = /turn(?:[\s_-]+)?(\d+)/i.exec(turnLabel);
  if (!match) return null;
  const value = Number.parseInt(match[1], 10);
  return Number.isFinite(value) ? value : null;
}

function parseRecentMilestones(body: string): ParsedExecutionMilestone[] {
  const sectionMatch = /## Последние этапы\s+([\s\S]*?)(?=\n## |\s*$)/m.exec(body);
  if (!sectionMatch) return [];
  const lines = sectionMatch[1].split("\n").map((line) => line.trim()).filter(Boolean);
  const milestones: ParsedExecutionMilestone[] = [];
  for (const line of lines) {
    const match = /^- \*\*(.+?)\*\* — (.+?): (.+?)(?: \((.+)\))?$/.exec(line);
    if (!match) continue;
    milestones.push({
      role: match[1].trim(),
      title: match[2].trim(),
      summary: match[3].trim(),
      at: match[4]?.trim() || null,
    });
  }
  return milestones;
}

function parseHeadlineAndSummary(body: string): Pick<ParsedExecutionDocument, "headline" | "summary"> {
  const lines = body.split("\n");
  const headlineIndex = lines.findIndex((line) => line.trim() === "# Сводка выполнения Atlas");
  if (headlineIndex === -1) return { headline: null, summary: null };
  const headline = lines[headlineIndex + 2]?.trim() || null;
  const summary = lines[headlineIndex + 4]?.trim() || null;
  return { headline, summary };
}

export function parseExecutionDocument(document: IssueDocument | null | undefined): ParsedExecutionDocument {
  const body = document?.body ?? "";
  const { headline, summary } = parseHeadlineAndSummary(body);
  const turnLabel = parseField(FIELD_PATTERNS.turnLabel, body);
  return {
    headline,
    summary,
    nextStep: parseField(FIELD_PATTERNS.nextStep, body),
    standUrl: parseField(FIELD_PATTERNS.standUrl, body),
    evidenceUrl: parseField(FIELD_PATTERNS.evidenceUrl, body),
    verifyStatus: parseField(FIELD_PATTERNS.verifyStatus, body),
    turnLabel,
    turnNumber: parseTurnNumber(turnLabel),
    executionState: parseField(FIELD_PATTERNS.executionState, body),
    attachmentState: parseField(FIELD_PATTERNS.attachmentState, body),
    failureClass: parseField(FIELD_PATTERNS.failureClass, body),
    retryCount: parseIntField(parseField(FIELD_PATTERNS.retryCount, body)),
    artifactCount: (() => {
      const value = parseField(FIELD_PATTERNS.artifactCount, body);
      if (!value) return null;
      const parsed = Number.parseInt(value, 10);
      return Number.isFinite(parsed) ? parsed : null;
    })(),
    slotEnv: parseField(FIELD_PATTERNS.slotEnv, body),
    slotBranch: parseField(FIELD_PATTERNS.slotBranch, body),
    slotStatus: parseField(FIELD_PATTERNS.slotStatus, body),
    updatedAt: parseField(FIELD_PATTERNS.updatedAt, body),
    recentMilestones: parseRecentMilestones(body),
  };
}

function normalizeStageKey(value: string | null | undefined): IssueExecutionStageKey | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (normalized.includes("delivery-orchestrator") || normalized.includes("orchestrator")) return "orchestrate";
  if (normalized.includes("atlas-executor") || normalized.includes("executor")) return "atlas_execute";
  if (normalized.includes("stand-controller") || normalized.includes("stand apply") || normalized.includes("stand")) return "stand_apply";
  if (normalized.includes("technical-verifier") || normalized.includes("verifier") || normalized.includes("verify")) return "verify";
  if (normalized.includes("reporter") || normalized.includes("report")) return "report";
  if (STAGE_KEYS.has(normalized as IssueExecutionStageKey)) return normalized as IssueExecutionStageKey;
  return null;
}

function getAgentStage(agentId: string | null | undefined, agentMap: Map<string, Agent>): IssueExecutionStageKey | null {
  if (!agentId) return null;
  const agent = agentMap.get(agentId);
  return normalizeStageKey(agent?.urlKey ?? agent?.name ?? agent?.role ?? null);
}

function getStageDefinition(key: IssueExecutionStageKey | null): StageDefinition | null {
  return STAGES.find((stage) => stage.key === key) ?? null;
}

function getStageIndex(key: IssueExecutionStageKey | null): number {
  if (!key) return -1;
  return STAGES.findIndex((stage) => stage.key === key);
}

function inferCurrentStage(input: {
  issue: Issue;
  activeRun: ActiveRunForIssue | null | undefined;
  parsed: ParsedExecutionDocument;
  agentMap: Map<string, Agent>;
}): IssueExecutionStageKey | null {
  const { issue, activeRun, parsed, agentMap } = input;
  const activeStage = activeRun ? getAgentStage(activeRun.agentId, agentMap) : null;
  if (activeStage) return activeStage;

  const latestMilestoneStage = (() => {
    const lastMilestone = [...parsed.recentMilestones]
      .reverse()
      .find((milestone) => Boolean(normalizeStageKey(milestone.role)));
    return normalizeStageKey(lastMilestone?.role ?? null);
  })();
  if (latestMilestoneStage && (parsed.turnNumber || parsed.executionState || parsed.verifyStatus)) {
    return latestMilestoneStage;
  }

  const successExecution = Boolean(
    parsed.executionState
    && ["completed", "succeeded", "success", "ready"].includes(parsed.executionState.toLowerCase()),
  );
  const autoReviewBlocked = Boolean(
    parsed.verifyStatus === "passed"
    && [parsed.headline, parsed.summary, parsed.nextStep]
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
      .includes("auto-review заблокирован"),
  );

  if (issue.status === "in_review" || String(issue.status) === "done") return "report";
  if (autoReviewBlocked && successExecution) return "report";
  if (parsed.verifyStatus) return successExecution ? "verify" : "verify";
  if (parsed.attachmentState === "attached" || parsed.standUrl) return "stand_apply";
  if (parsed.executionState === "running" || parsed.executionState === "queued" || parsed.executionState === "completed") {
    return "atlas_execute";
  }

  const assigneeStage = getAgentStage(issue.assigneeAgentId, agentMap);
  if (assigneeStage && issue.status !== "done" && issue.status !== "cancelled") {
    return assigneeStage;
  }
  if (issue.status === "in_progress" || issue.status === "blocked") return "orchestrate";
  return null;
}

function collectObservedStages(input: {
  linkedRuns: RunForIssue[];
  liveRuns: LiveRunForIssue[];
  activeRun: ActiveRunForIssue | null | undefined;
  activity: ActivityEvent[];
  parsed: ParsedExecutionDocument;
  agentMap: Map<string, Agent>;
}): IssueExecutionStageKey[] {
  const observed: Array<{ stage: IssueExecutionStageKey; at: number }> = [];
  for (const run of input.linkedRuns) {
    const stage = getAgentStage(run.agentId, input.agentMap);
    if (!stage) continue;
    observed.push({ stage, at: new Date(run.startedAt ?? run.createdAt).getTime() });
  }
  for (const run of input.liveRuns) {
    const stage = getAgentStage(run.agentId, input.agentMap);
    if (!stage) continue;
    observed.push({ stage, at: new Date(run.startedAt ?? run.createdAt).getTime() });
  }
  if (input.activeRun) {
    const stage = getAgentStage(input.activeRun.agentId, input.agentMap);
    if (stage) observed.push({ stage, at: new Date(input.activeRun.startedAt ?? input.activeRun.createdAt).getTime() });
  }
  for (const event of input.activity) {
    const stage = getAgentStage(event.agentId, input.agentMap);
    if (!stage) continue;
    observed.push({ stage, at: new Date(event.createdAt).getTime() });
  }
  for (const milestone of input.parsed.recentMilestones) {
    const stage = normalizeStageKey(milestone.role);
    if (!stage) continue;
    observed.push({ stage, at: milestone.at ? new Date(milestone.at).getTime() : Number.MAX_SAFE_INTEGER });
  }
  observed.sort((a, b) => a.at - b.at);
  const sequence: IssueExecutionStageKey[] = [];
  for (const item of observed) {
    if (sequence[sequence.length - 1] !== item.stage) sequence.push(item.stage);
  }
  return sequence;
}

function countStageOccurrences(sequence: IssueExecutionStageKey[]): Map<IssueExecutionStageKey, number> {
  const counts = new Map<IssueExecutionStageKey, number>();
  for (const stage of sequence) counts.set(stage, (counts.get(stage) ?? 0) + 1);
  return counts;
}

function deriveExpectedNextStage(currentStage: IssueExecutionStageKey | null, issue: Issue, isStageActive: boolean): IssueExecutionStageKey | null {
  if (!currentStage) return issue.status === "todo" || issue.status === "backlog" ? "orchestrate" : null;
  if (issue.status === "done" || issue.status === "cancelled") return null;
  if (issue.status === "in_review" && currentStage === "report") return null;
  if (isStageActive) return currentStage;
  const index = getStageIndex(currentStage);
  return STAGES[index + 1]?.key ?? null;
}

function deriveActualNextObservedStage(currentStage: IssueExecutionStageKey | null, observedStages: IssueExecutionStageKey[]): IssueExecutionStageKey | null {
  if (!currentStage) return observedStages[0] ?? null;
  const currentIndex = observedStages.lastIndexOf(currentStage);
  if (currentIndex > 0) return observedStages[currentIndex] ?? null;
  return observedStages[0] ?? currentStage;
}

function getMismatchSeverity(expected: IssueExecutionStageKey | null, actual: IssueExecutionStageKey | null): "neutral" | "success" | "warning" | "error" {
  if (!expected || !actual) return "neutral";
  if (expected === actual) return "success";
  const expectedIndex = getStageIndex(expected);
  const actualIndex = getStageIndex(actual);
  if (expectedIndex === -1 || actualIndex === -1) return "neutral";
  if (Math.abs(actualIndex - expectedIndex) <= 1) return "warning";
  return "error";
}

function deriveFlowStatus(input: {
  parsed: ParsedExecutionDocument;
  expectedNextStage: IssueExecutionStageKey | null;
  actualNextObservedStage: IssueExecutionStageKey | null;
}): Pick<IssueExecutionHeaderModel, "flowStatus" | "flowSeverity" | "mismatchText"> {
  const { parsed, expectedNextStage, actualNextObservedStage } = input;
  if (parsed.failureClass) {
    return {
      flowStatus: "Diverged",
      flowSeverity: "error",
      mismatchText: `Failure class: ${parsed.failureClass}`,
    };
  }
  const severity = getMismatchSeverity(expectedNextStage, actualNextObservedStage);
  if (severity === "success") {
    return { flowStatus: "On track", flowSeverity: "success", mismatchText: null };
  }
  if (severity === "warning") {
    const expected = getStageDefinition(expectedNextStage)?.ownerLabel ?? "Unknown";
    const actual = getStageDefinition(actualNextObservedStage)?.ownerLabel ?? "Unknown";
    return {
      flowStatus: "Recovery loop",
      flowSeverity: "warning",
      mismatchText: `Expected ${expected}, observed ${actual}`,
    };
  }
  if (severity === "error") {
    const expected = getStageDefinition(expectedNextStage)?.ownerLabel ?? "Unknown";
    const actual = getStageDefinition(actualNextObservedStage)?.ownerLabel ?? "Unknown";
    return {
      flowStatus: "Mismatch",
      flowSeverity: "error",
      mismatchText: `Expected ${expected}, observed ${actual}`,
    };
  }
  return { flowStatus: "Pending", flowSeverity: "neutral", mismatchText: null };
}

function inferStandLabel(issue: Issue, parsed: ParsedExecutionDocument): string | null {
  if (parsed.slotEnv) return parsed.slotEnv;
  const workspaceName = issue.currentExecutionWorkspace?.name ?? issue.currentExecutionWorkspace?.branchName ?? null;
  if (workspaceName) return workspaceName;
  const url = parsed.standUrl ?? "";
  const match = /https:\/\/(ai\d{2})\.homio\.pro/i.exec(url);
  return match?.[1] ?? null;
}

function labelForStageOwner(stage: IssueExecutionStageKey | null): string {
  return getStageDefinition(stage)?.ownerLabel ?? "Unknown";
}

export function buildIssueExecutionHeaderModel(input: {
  issue: Issue;
  executionDocument: IssueDocument | null | undefined;
  linkedRuns: RunForIssue[];
  liveRuns: LiveRunForIssue[];
  activeRun: ActiveRunForIssue | null | undefined;
  activity: ActivityEvent[];
  agents: Agent[];
}): IssueExecutionHeaderModel {
  const agentMap = new Map(input.agents.map((agent) => [agent.id, agent] as const));
  const stageAgentMap = new Map<IssueExecutionStageKey, Agent>();
  for (const agent of input.agents) {
    const stage = normalizeStageKey(agent.urlKey ?? agent.name ?? agent.role ?? null);
    if (stage && !stageAgentMap.has(stage)) {
      stageAgentMap.set(stage, agent);
    }
  }
  const parsed = parseExecutionDocument(input.executionDocument);
  const successExecution = Boolean(
    parsed.executionState
    && ["completed", "succeeded", "success", "ready"].includes(parsed.executionState.toLowerCase()),
  );
  const autoReviewBlocked = Boolean(
    parsed.verifyStatus === "passed"
    && [parsed.headline, parsed.summary, parsed.nextStep]
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
      .includes("auto-review заблокирован"),
  );
  const currentStage = inferCurrentStage({
    issue: input.issue,
    activeRun: input.activeRun,
    parsed,
    agentMap,
  });
  const observedStages = collectObservedStages({
    linkedRuns: input.linkedRuns,
    liveRuns: input.liveRuns,
    activeRun: input.activeRun,
    activity: input.activity,
    parsed,
    agentMap,
  });
  const stageOccurrences = countStageOccurrences(observedStages);
  const retryCount = input.activeRun?.processLossRetryCount ?? parsed.retryCount;
  const isStageActive = Boolean(input.activeRun) || parsed.executionState === "running" || parsed.executionState === "queued";
  const expectedNextStage = deriveExpectedNextStage(currentStage, input.issue, isStageActive);
  const actualNextObservedStage = deriveActualNextObservedStage(currentStage, observedStages);
  const flow = deriveFlowStatus({
    parsed,
    expectedNextStage,
    actualNextObservedStage,
  });
  const currentStageIndex = getStageIndex(currentStage);
  const loopCount = [...stageOccurrences.values()].reduce((total, count) => total + Math.max(0, count - 1), 0);
  let stages = STAGES.map((stage, index): IssueExecutionHeaderStage => {
    const occurrences = stageOccurrences.get(stage.key) ?? 0;
    let state: IssueExecutionStageState = "not_started";
    if (index < currentStageIndex || (input.issue.status === "in_review" && index <= getStageIndex("report")) || input.issue.status === "done") {
      state = occurrences > 1 ? "looping" : "passed";
    }
    if (index === currentStageIndex) {
      if (parsed.failureClass) state = "failed";
      else if (stage.key === "report" && autoReviewBlocked && successExecution) state = "blocked";
      else if (retryCount > 0 && isStageActive) state = "retrying";
      else if (occurrences > 1) state = "looping";
      else state = isStageActive ? "running" : "passed";
    }
    if (parsed.attachmentState === "drifted" && stage.key === "stand_apply") state = "blocked";
    return {
      key: stage.key,
      label: stage.label,
      ownerLabel: stage.ownerLabel,
      ownerKey: stage.ownerKey,
      ownerIcon: stageAgentMap.get(stage.key)?.icon ?? null,
      state,
      countBadge: retryCount > 0 && stage.key === currentStage ? `R${retryCount}` : occurrences > 1 ? `L${occurrences - 1}` : null,
      note: stage.key === currentStage ? parsed.nextStep : null,
    };
  });

  if (successExecution && parsed.verifyStatus) {
    stages = stages.map((stage) => {
      if (stage.key === "report" && autoReviewBlocked) {
        return {
          ...stage,
          state: "blocked",
          note: parsed.nextStep ?? stage.note,
        };
      }
      if (stage.key !== "report" && stage.state === "not_started") {
        return {
          ...stage,
          state: "passed",
        };
      }
      return stage;
    });
  }

  const currentAgent = input.activeRun?.agentName
    ?? agentMap.get(input.issue.assigneeAgentId ?? "")?.name
    ?? labelForStageOwner(currentStage);

  return {
    currentAgent,
    expectedNext: expectedNextStage ? labelForStageOwner(expectedNextStage) : "None",
    actualNextObserved: actualNextObservedStage ? labelForStageOwner(actualNextObservedStage) : "Pending",
    flowStatus: flow.flowStatus,
    flowSeverity: flow.flowSeverity,
    standLabel: inferStandLabel(input.issue, parsed),
    executionStateLabel: parsed.executionState ?? input.issue.status,
    elapsedLabel: input.activeRun?.startedAt ?? input.issue.startedAt ? "Active now" : null,
    lastUpdatedAt: parsed.updatedAt ?? String(input.executionDocument?.updatedAt ?? input.issue.updatedAt),
    turnLabel: parsed.turnNumber ? `Turn ${parsed.turnNumber}` : parsed.turnLabel ?? "Turn pending",
    loopLabel: loopCount > 0 ? `Loop ${loopCount}` : "Loop 0",
    retryLabel: retryCount > 0 ? `Retry ${retryCount}` : "Retry 0",
    mismatchText: flow.mismatchText,
    headline: parsed.headline,
    summary: parsed.summary,
    nextStep: parsed.nextStep,
    stages,
    milestones: parsed.recentMilestones,
    evidenceUrl: parsed.evidenceUrl,
    standUrl: parsed.standUrl,
  };
}
