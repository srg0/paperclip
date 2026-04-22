import type { TranscriptEntry } from "../adapters";
import type { LiveRunForIssue } from "../api/heartbeats";
import { normalizeTranscript } from "../components/transcript/RunTranscriptView";
import type { IssueExecutionCommentContext, IssueExecutionTurn } from "./issue-execution-turns";

export type IssueConversationVerbosity = "auto" | "brief" | "debug";
export type IssueConversationEffectiveVerbosity = "brief" | "standard" | "debug";

export interface IssueConversationArtifact {
  label: string;
  url: string;
  kind: "preview" | "evidence" | "diff" | "debug";
  durability: "ephemeral" | "durable";
}

export interface IssueConversationPhaseBundle {
  id: string;
  label: string;
  status: "pending" | "running" | "completed" | "failed";
  summary: string;
  itemCount?: number;
  items?: string[];
}

export interface IssueConversationTurnCard {
  id: string;
  sequence: number;
  turnLabel?: string | null;
  request: string;
  status: "queued" | "running" | "completed" | "blocked" | "failed" | "waiting";
  statusLabel: string;
  tone: "neutral" | "working" | "success" | "warning" | "danger";
  summary: string;
  proofSummary: string | null;
  nextAction: string | null;
  proofState: "none" | "weak" | "review_ready";
  artifacts: IssueConversationArtifact[];
  phaseBundles: IssueConversationPhaseBundle[];
  updatedAt: string | null;
}

export interface IssueConversationLiveStrip {
  title: string;
  summary: string;
  tone: "working" | "warning" | "danger";
  bundles: IssueConversationPhaseBundle[];
}

export interface IssueConversationAttentionCard {
  title: string;
  body: string;
  tone: "warning" | "danger" | "working";
}

export interface IssueConversationModel {
  effectiveVerbosity: IssueConversationEffectiveVerbosity;
  turns: IssueConversationTurnCard[];
  liveStrip: IssueConversationLiveStrip | null;
  attention: IssueConversationAttentionCard | null;
}

function cleanMarkdownText(value: string | null | undefined): string {
  return (value ?? "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/^\s*#+\s+/gm, "")
    .replace(/^\s*[-*]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

function compact(parts: Array<string | null | undefined>): string {
  return parts.map((part) => cleanMarkdownText(part)).filter(Boolean).join(" ");
}

function latestEventSummary(turn: IssueExecutionTurn, roles: string[]): string | null {
  const reversed = [...turn.events].reverse();
  for (const role of roles) {
    const event = reversed.find((entry) => entry.role.trim().toLowerCase() === role);
    const value = cleanMarkdownText(event?.summary ?? event?.title ?? "");
    if (value) return value;
  }
  return null;
}

function extractImplementationSummary(turn: IssueExecutionTurn): string | null {
  return latestEventSummary(turn, [
    "reporter",
    "stand controller",
    "atlas executor",
    "delivery orchestrator",
  ]) ?? [...turn.events]
    .reverse()
    .map((event) => cleanMarkdownText(event.summary ?? event.title ?? ""))
    .find(Boolean) ?? null;
}

function proofStateForTurn(turn: IssueExecutionTurn): "none" | "weak" | "review_ready" {
  if (!turn.verifierScope && !turn.evidenceUrl) return "none";
  const proof = cleanMarkdownText(turn.verifierScope ?? "");
  if (!turn.evidenceUrl) return "weak";
  if (!proof) return "review_ready";
  if (proof.toLowerCase().includes("не доказывает") || proof.toLowerCase().includes("слишком общей")) {
    return "weak";
  }
  return "review_ready";
}

function outcomeTone(turn: IssueExecutionTurn): IssueConversationTurnCard["tone"] {
  const outcome = cleanMarkdownText(turn.outcome ?? "").toLowerCase();
  if (turn.status === "running") return "working";
  if (outcome.includes("не прошла") || outcome.includes("с замечаниями")) return "danger";
  if (outcome.includes("готов") || outcome.includes("ревью")) {
    return proofStateForTurn(turn) === "weak" ? "warning" : "success";
  }
  if (proofStateForTurn(turn) === "review_ready") return "success";
  if (proofStateForTurn(turn) === "weak") return "warning";
  return "neutral";
}

function outcomeStatus(turn: IssueExecutionTurn, hasActiveLiveRun: boolean): IssueConversationTurnCard["status"] {
  const outcome = cleanMarkdownText(turn.outcome ?? "").toLowerCase();
  if (hasActiveLiveRun) return "running";
  if (outcome.includes("не прошла") || outcome.includes("с замечаниями")) return "failed";
  if (turn.status === "settled") return "completed";
  return "running";
}

function statusLabel(status: IssueConversationTurnCard["status"]): string {
  switch (status) {
    case "queued":
      return "Queued";
    case "waiting":
      return "Waiting";
    case "running":
      return "Running";
    case "completed":
      return "Completed";
    case "blocked":
      return "Blocked";
    case "failed":
      return "Needs Follow-up";
    default:
      return "Updated";
  }
}

function nextActionForTurn(turn: IssueExecutionTurn, isLatest: boolean, hasActiveLiveRun: boolean): string | null {
  const outcome = cleanMarkdownText(turn.outcome ?? "").toLowerCase();
  const proofState = proofStateForTurn(turn);
  if (hasActiveLiveRun && isLatest) return null;
  if (outcome.includes("не прошла") || outcome.includes("с замечаниями")) {
    return "A follow-up turn is needed before this can be treated as ready for review.";
  }
  if (proofState === "weak") {
    return "The result looks close, but proof is still weak. Human review or a tighter verifier pass is needed.";
  }
  if (proofState === "review_ready") {
    return "Review-ready proof is attached. Operator can inspect preview and evidence instead of reading the raw logs.";
  }
  return isLatest ? "Waiting for the next execution update." : null;
}

function phaseLabelForRole(role: string): string {
  const normalized = role.trim().toLowerCase();
  if (normalized === "delivery orchestrator") return "Plan";
  if (normalized === "atlas executor") return "Execute";
  if (normalized === "stand controller") return "Apply";
  if (normalized === "technical verifier") return "Verify";
  if (normalized === "reporter") return "Report";
  return cleanMarkdownText(role) || "Update";
}

function buildPhaseBundles(turn: IssueExecutionTurn, status: IssueConversationTurnCard["status"]): IssueConversationPhaseBundle[] {
  const bundles = new Map<string, IssueConversationPhaseBundle>();
  for (const event of turn.events) {
    const label = phaseLabelForRole(event.role);
    const key = label.toLowerCase();
    const summary = cleanMarkdownText(event.summary ?? event.title ?? "");
    const existing = bundles.get(key);
    if (!existing) {
      bundles.set(key, {
        id: `${turn.sequence}-${key}`,
        label,
        status: status === "failed" && key === "verify"
          ? "failed"
          : status === "running" && key === "report"
            ? "pending"
            : "completed",
        summary: summary || `${label} updated this turn.`,
        itemCount: 1,
        items: summary ? [summary] : [],
      });
      continue;
    }
    existing.itemCount = (existing.itemCount ?? 1) + 1;
    if (summary) existing.summary = summary;
    if (summary && !existing.items?.includes(summary)) {
      existing.items = [...(existing.items ?? []), summary];
    }
    if (status === "running" && key === "report") existing.status = "pending";
  }
  return [...bundles.values()];
}

function buildArtifacts(turn: IssueExecutionTurn): IssueConversationArtifact[] {
  const artifacts: IssueConversationArtifact[] = [
    {
      label: "Diff",
      url: "#document-atlas-change-summary",
      kind: "diff",
      durability: "durable",
    },
    {
      label: "Debug Pack",
      url: "#document-atlas-debug-pack",
      kind: "debug",
      durability: "durable",
    },
  ];
  if (turn.standUrl) {
    artifacts.unshift({
      label: "Preview",
      url: turn.standUrl,
      kind: "preview",
      durability: "ephemeral",
    });
  }
  if (turn.evidenceUrl) {
    artifacts.unshift({
      label: "Evidence",
      url: turn.evidenceUrl,
      kind: "evidence",
      durability: "durable",
    });
  }
  return artifacts;
}

function buildTurnCard(
  turn: IssueExecutionTurn,
  options: { isLatest: boolean; hasActiveLiveRun: boolean },
): IssueConversationTurnCard {
  const status = outcomeStatus(turn, options.hasActiveLiveRun && options.isLatest);
  const implementation = extractImplementationSummary(turn);
  const proof = cleanMarkdownText(turn.verifierScope ?? "");
  const proofState = proofStateForTurn(turn);

  return {
    id: `turn-${turn.sequence}`,
    sequence: turn.sequence,
    turnLabel: `Turn ${turn.sequence}`,
    request: cleanMarkdownText(turn.request) || "No explicit request recorded for this turn.",
    status,
    statusLabel: statusLabel(status),
    tone: outcomeTone({ ...turn, status: options.hasActiveLiveRun && options.isLatest ? "running" : turn.status }),
    summary: compact([
      implementation
        ? `What changed: ${implementation}.`
        : turn.outcome
          ? `Latest result: ${cleanMarkdownText(turn.outcome)}.`
          : null,
    ]) || "Execution is still collecting the next meaningful update.",
    proofSummary: proof ? `Proof: ${proof}.` : null,
    nextAction: nextActionForTurn(turn, options.isLatest, options.hasActiveLiveRun),
    proofState,
    artifacts: buildArtifacts(turn),
    phaseBundles: buildPhaseBundles(turn, status),
    updatedAt: turn.settledAt ?? turn.startedAt,
  };
}

interface PrimaryLiveRunMeta {
  status: "queued" | "running";
  turnNumber: number | null;
  turnLabel: string | null;
  agentName: string;
  slotEnv: string | null;
}

function parseLiveTurnNumber(run: LiveRunForIssue): number | null {
  const triggerDetail = cleanMarkdownText(run.triggerDetail ?? "");
  const explicit = /turn(?:[\s_-]+)?(\d+)/i.exec(triggerDetail);
  if (explicit?.[1]) {
    const parsed = Number.parseInt(explicit[1], 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  const idMatch = /-t(\d+)-/i.exec(run.id);
  if (idMatch?.[1]) {
    const parsed = Number.parseInt(idMatch[1], 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function parseLiveTurnLabel(run: LiveRunForIssue): string | null {
  const triggerDetail = cleanMarkdownText(run.triggerDetail ?? "");
  if (triggerDetail) return triggerDetail.toUpperCase().startsWith("TURN ") ? triggerDetail : triggerDetail;
  const turnNumber = parseLiveTurnNumber(run);
  return turnNumber !== null ? `TURN ${turnNumber}` : null;
}

function selectPrimaryLiveRun(liveRuns: LiveRunForIssue[]): PrimaryLiveRunMeta | null {
  const active = [...liveRuns]
    .filter((run) => run.status === "running" || run.status === "queued")
    .sort((a, b) => {
      const aTime = new Date(a.startedAt ?? a.createdAt).getTime();
      const bTime = new Date(b.startedAt ?? b.createdAt).getTime();
      if (a.status !== b.status) {
        return a.status === "running" ? -1 : 1;
      }
      return bTime - aTime;
    })[0];
  if (!active) return null;
  return {
    status: active.status === "running" ? "running" : "queued",
    turnNumber: parseLiveTurnNumber(active),
    turnLabel: parseLiveTurnLabel(active),
    agentName: cleanMarkdownText(active.agentName ?? "") || "Atlas Executor",
    slotEnv: cleanMarkdownText(active.slotEnv ?? "") || null,
  };
}

function buildPendingTurnCards(
  pendingUserRequests: string[],
  primaryLiveRun: PrimaryLiveRunMeta | null,
  lastSequence: number,
): IssueConversationTurnCard[] {
  if (pendingUserRequests.length === 0) return [];

  const latestRequest = cleanMarkdownText(pendingUserRequests[pendingUserRequests.length - 1] ?? "");
  const hiddenCount = Math.max(0, pendingUserRequests.length - 1);
  const hiddenMessages = pendingUserRequests
    .slice(0, -1)
    .map((message) => cleanMarkdownText(message))
    .filter(Boolean);
  const status: IssueConversationTurnCard["status"] = primaryLiveRun?.status === "running"
    ? "running"
    : primaryLiveRun?.status === "queued"
      ? "queued"
      : "waiting";
  const liveSummaryParts = [
    status === "running" ? "Running" : status === "queued" ? "Starting" : "No live run yet",
    primaryLiveRun?.turnLabel ?? null,
    primaryLiveRun?.agentName ?? null,
    primaryLiveRun?.slotEnv ? `slot ${primaryLiveRun.slotEnv}` : null,
  ].filter(Boolean);
  if (hiddenCount > 0) {
    liveSummaryParts.push(`${hiddenCount} earlier messages folded`);
  }

  return [{
    id: "pending-turn-current",
    sequence: primaryLiveRun?.turnNumber ?? (lastSequence + 1),
    turnLabel: primaryLiveRun?.turnLabel ?? (status === "running" ? "Running" : status === "queued" ? "Starting" : "Follow-up"),
    request: latestRequest || "Waiting for the newest follow-up request.",
    status,
    statusLabel: statusLabel(status),
    tone: status === "running" ? "working" : status === "queued" ? "neutral" : "warning",
    summary: liveSummaryParts.join(" · ") || "Starting",
    proofSummary: null,
    nextAction: hiddenCount > 0
      ? `${hiddenCount} earlier follow-up message${hiddenCount === 1 ? "" : "s"} are folded under the current live launch.`
      : status === "waiting"
        ? "The latest follow-up is recorded, but there is still no live launch for it."
      : null,
    proofState: "none",
    artifacts: [],
    phaseBundles: [
      {
        id: "pending-run-current",
        label: status === "running" ? "Running" : status === "queued" ? "Starting" : "Waiting",
        status: status === "running" ? "running" : status === "queued" ? "pending" : "failed",
        summary: primaryLiveRun?.turnLabel ?? primaryLiveRun?.agentName ?? "No live run yet",
      },
      ...(hiddenCount > 0
        ? [{
            id: "pending-run-folded-messages",
            label: "Messages",
            status: "pending" as const,
            summary: `${hiddenCount} earlier follow-up message${hiddenCount === 1 ? "" : "s"} folded`,
            itemCount: hiddenCount,
            items: hiddenMessages,
          }]
        : []),
    ],
    updatedAt: null,
  }];
}

function summarizeLiveRuns(
  liveRuns: LiveRunForIssue[],
  transcriptByRun: Map<string, TranscriptEntry[]>,
): IssueConversationLiveStrip | null {
  if (liveRuns.length === 0) return null;
  const primaryLiveRun = selectPrimaryLiveRun(liveRuns);

  let commandCount = 0;
  let toolCount = 0;
  let errorCount = 0;
  let thinkingCount = 0;
  const bundles: IssueConversationPhaseBundle[] = [];

  for (const run of liveRuns) {
    const blocks = normalizeTranscript(transcriptByRun.get(run.id) ?? [], run.status === "running");
    let runCommandCount = 0;
    let runToolCount = 0;
    let runErrorCount = 0;
    let runThinkingCount = 0;
    for (const block of blocks) {
      if (block.type === "command_group") runCommandCount += block.items.length;
      if (block.type === "tool_group") runToolCount += block.items.length;
      if (block.type === "tool" && block.name !== "command_execution") runToolCount += 1;
      if (block.type === "thinking") runThinkingCount += 1;
      if ((block.type === "tool" && block.status === "error") || (block.type === "event" && block.tone === "error")) {
        runErrorCount += 1;
      }
    }
    commandCount += runCommandCount;
    toolCount += runToolCount;
    errorCount += runErrorCount;
    thinkingCount += runThinkingCount;
    if (runCommandCount > 0) {
      bundles.push({
        id: `${run.id}-commands`,
        label: "Commands",
        status: runErrorCount > 0 ? "failed" : "running",
        summary: `${runCommandCount} command${runCommandCount === 1 ? "" : "s"}`,
        itemCount: runCommandCount,
      });
    }
    if (runToolCount > 0) {
      bundles.push({
        id: `${run.id}-tools`,
        label: "Tools",
        status: runErrorCount > 0 ? "failed" : "running",
        summary: `${runToolCount} tool${runToolCount === 1 ? "" : "s"}`,
        itemCount: runToolCount,
      });
    }
    if (runThinkingCount > 0) {
      bundles.push({
        id: `${run.id}-thinking`,
        label: "Thinking",
        status: "running",
        summary: `${runThinkingCount} thinking`,
        itemCount: runThinkingCount,
      });
    }
  }

  const tone = errorCount > 0 ? "danger" : commandCount + toolCount + thinkingCount > 0 ? "working" : "warning";
  const summary = [
    primaryLiveRun?.turnLabel ?? `${liveRuns.length} run${liveRuns.length === 1 ? "" : "s"}`,
    primaryLiveRun?.agentName ?? null,
    primaryLiveRun?.slotEnv ? `slot ${primaryLiveRun.slotEnv}` : null,
    commandCount > 0 ? `${commandCount} commands` : null,
    toolCount > 0 ? `${toolCount} tools` : null,
    thinkingCount > 0 ? `${thinkingCount} thinking` : null,
    errorCount > 0 ? `${errorCount} errors` : null,
  ].filter(Boolean).join(" · ");

  return {
    title: errorCount > 0 ? "Needs attention" : thinkingCount > 0 ? "Thinking" : commandCount + toolCount > 0 ? "Running" : "Starting",
    summary: summary || "Live execution",
    tone,
    bundles,
  };
}

function resolveEffectiveVerbosity(input: {
  preference: IssueConversationVerbosity;
  hasActiveLiveRun: boolean;
  projectionWarning: string | null;
  pendingUserRequests: number;
  turns: IssueExecutionTurn[];
}): IssueConversationEffectiveVerbosity {
  if (input.preference === "brief") return "brief";
  if (input.preference === "debug") return "debug";

  let score = 0;
  if (input.hasActiveLiveRun) score += 1;
  if (input.projectionWarning) score += 2;
  if (input.pendingUserRequests > 0) score += 2;

  const latestTurn = input.turns[input.turns.length - 1] ?? null;
  const latestOutcome = cleanMarkdownText(latestTurn?.outcome ?? "").toLowerCase();
  if (latestOutcome.includes("не прошла") || latestOutcome.includes("с замечаниями")) score += 3;
  if (latestTurn && proofStateForTurn(latestTurn) === "weak") score += 2;
  if (!input.hasActiveLiveRun && latestTurn && proofStateForTurn(latestTurn) === "review_ready") score -= 2;

  if (score <= 0) return "brief";
  if (score >= 4) return "debug";
  return "standard";
}

export function buildIssueConversationModel(input: {
  context: IssueExecutionCommentContext | null;
  liveRuns: LiveRunForIssue[];
  transcriptByRun: Map<string, TranscriptEntry[]>;
  verbosity: IssueConversationVerbosity;
}): IssueConversationModel {
  const context = input.context;
  if (!context) {
    return {
      effectiveVerbosity: input.verbosity === "debug" ? "debug" : input.verbosity === "brief" ? "brief" : "standard",
      turns: [],
      liveStrip: null,
      attention: null,
    };
  }

  const hasActiveLiveRun = input.liveRuns.some((run) => run.status === "queued" || run.status === "running");
  const primaryLiveRun = selectPrimaryLiveRun(input.liveRuns);
  const effectiveVerbosity = resolveEffectiveVerbosity({
    preference: input.verbosity,
    hasActiveLiveRun,
    projectionWarning: context.projectionWarning,
    pendingUserRequests: context.pendingUserRequests.length,
    turns: context.turns,
  });

  const turns = context.turns.map((turn, index) =>
    buildTurnCard(turn, {
      isLatest: index === context.turns.length - 1,
      hasActiveLiveRun,
    }),
  );
  turns.push(...buildPendingTurnCards(context.pendingUserRequests, primaryLiveRun, context.turns.length));

  const liveStrip = summarizeLiveRuns(input.liveRuns, input.transcriptByRun);
  const attention = context.projectionWarning && context.pendingUserRequests.length === 0
    ? {
        title: "Conversation state is ahead of the projection",
        body: context.projectionWarning,
        tone: "warning" as const,
      }
    : liveStrip?.tone === "danger"
      ? {
          title: "Live execution is noisy enough to matter",
          body: "The main flow stays collapsed, but the current live run is emitting errors. Open Task Dashboard if you need the raw transcript.",
          tone: "danger" as const,
        }
      : null;

  return {
    effectiveVerbosity,
    turns,
    liveStrip,
    attention,
  };
}
