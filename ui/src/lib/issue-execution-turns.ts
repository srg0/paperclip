import type { Issue, IssueComment } from "@paperclipai/shared";

export interface IssueExecutionTurnEvent {
  role: string;
  title: string | null;
  summary: string | null;
  createdAt: string;
}

export interface IssueExecutionTurn {
  sequence: number;
  request: string | null;
  startedAt: string | null;
  settledAt: string | null;
  status: "running" | "settled";
  verifierScope: string | null;
  standUrl: string | null;
  evidenceUrl: string | null;
  outcome: string | null;
  events: IssueExecutionTurnEvent[];
}

export interface IssueExecutionCommentContext {
  turns: IssueExecutionTurn[];
  latestExecutedTurn: IssueExecutionTurn | null;
  pendingUserRequests: string[];
  projectionWarning: string | null;
}

export interface IssueExecutionCommentContextInput {
  issue: Pick<Issue, "title" | "description">;
  comments: Array<
    Pick<IssueComment, "authorAgentId" | "authorUserId" | "body" | "createdAt">
  >;
  projectedTurnNumber?: number | null;
}

interface ParsedBridgeComment {
  role: string;
  title: string | null;
  summary: string | null;
  standUrl: string | null;
  evidenceUrl: string | null;
  verifierScope: string | null;
}

function normalizeTimestamp(value: Date | string | null | undefined): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value.trim().length > 0) return value;
  return "1970-01-01T00:00:00.000Z";
}

function extractDisplayRole(body: string): string | null {
  const markerMatch = /paperclip-display-author:\s*[^·\n]+·\s*([^\n>]+?)\s*-->/.exec(body);
  if (markerMatch?.[1]) return markerMatch[1].trim();
  const headingMatch = /^###\s+(.+)$/m.exec(body);
  return headingMatch?.[1]?.trim() ?? null;
}

function extractFirstBoldLine(body: string): string | null {
  const match = /\*\*([^*\n]+)\*\*/.exec(body);
  return match?.[1]?.trim() ?? null;
}

function cleanMarkdownText(value: string): string {
  return value
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/^\s*#+\s+/gm, "")
    .replace(/^\s*[-*]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractShortSummary(body: string): string | null {
  const shortMatch = /\*\*Коротко:\*\*\s*([^\n]+)/.exec(body);
  if (shortMatch?.[1]) return cleanMarkdownText(shortMatch[1]);

  const withoutMarker = body.replace(/<!--[\s\S]*?-->/g, "").trim();
  const paragraphs = withoutMarker
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => !part.startsWith("### "))
    .filter((part) => !part.startsWith("**") || !/^\*\*[^*]+\*\*$/.test(part));
  const paragraph = paragraphs.find((part) => !part.startsWith("-"));
  return paragraph ? cleanMarkdownText(paragraph) : null;
}

function extractTurnLineValue(label: string, body: string): string | null {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^[*-]?\\s*${escaped}:\\s*(.+)$`, "mi").exec(body);
  return match?.[1] ? cleanMarkdownText(match[1]) : null;
}

function parseBridgeComment(body: string): ParsedBridgeComment | null {
  const role = extractDisplayRole(body);
  if (!role) return null;
  return {
    role,
    title: extractFirstBoldLine(body),
    summary: extractShortSummary(body),
    standUrl: extractTurnLineValue("Стенд", body) ?? extractTurnLineValue("Preview", body),
    evidenceUrl: extractTurnLineValue("Evidence", body),
    verifierScope: extractTurnLineValue("Что проверено", body),
  };
}

function isPlainUserComment(comment: Pick<IssueComment, "authorAgentId" | "authorUserId" | "body">): boolean {
  if (!comment.authorUserId || comment.authorAgentId) return false;
  return !comment.body.includes("paperclip-display-author:");
}

function shouldIgnoreAsOperationalUserComment(body: string): boolean {
  const normalized = cleanMarkdownText(body).toLowerCase();
  return normalized.startsWith("recovery reroute:");
}

function isTurnStartRole(role: string): boolean {
  const normalized = role.trim().toLowerCase();
  return normalized === "delivery orchestrator" || normalized === "atlas executor";
}

function buildInitialRequest(issue: Pick<Issue, "title" | "description">): string | null {
  const description = issue.description?.trim();
  if (description) return description;
  return issue.title?.trim() || null;
}

function makeTurn(sequence: number, request: string | null): IssueExecutionTurn {
  return {
    sequence,
    request,
    startedAt: null,
    settledAt: null,
    status: "running",
    verifierScope: null,
    standUrl: null,
    evidenceUrl: null,
    outcome: null,
    events: [],
  };
}

function isSettledRole(role: string): boolean {
  const normalized = role.trim().toLowerCase();
  return normalized === "technical verifier" || normalized === "reporter";
}

export function buildIssueExecutionCommentContext(
  input: IssueExecutionCommentContextInput,
): IssueExecutionCommentContext {
  const ordered = [...input.comments].sort(
    (a, b) => new Date(normalizeTimestamp(a.createdAt)).getTime() - new Date(normalizeTimestamp(b.createdAt)).getTime(),
  );

  const turns: IssueExecutionTurn[] = [makeTurn(1, buildInitialRequest(input.issue))];
  let currentTurn = turns[0];
  const pendingUserRequests: string[] = [];

  for (const comment of ordered) {
    if (isPlainUserComment(comment)) {
      const request = cleanMarkdownText(comment.body);
      if (!request || shouldIgnoreAsOperationalUserComment(request)) continue;
      pendingUserRequests.push(request);
      continue;
    }

    const parsed = parseBridgeComment(comment.body);
    if (!parsed) continue;

    if (isTurnStartRole(parsed.role) && currentTurn.events.length > 0 && pendingUserRequests.length > 0) {
      currentTurn.status = currentTurn.settledAt ? "settled" : currentTurn.status;
      const nextRequest = pendingUserRequests.shift() ?? null;
      currentTurn = makeTurn(turns.length + 1, nextRequest);
      turns.push(currentTurn);
    }

    const createdAt = normalizeTimestamp(comment.createdAt);
    currentTurn.startedAt ??= createdAt;
    currentTurn.events.push({
      role: parsed.role,
      title: parsed.title,
      summary: parsed.summary,
      createdAt,
    });

    if (parsed.standUrl) currentTurn.standUrl = parsed.standUrl;
    if (parsed.evidenceUrl) currentTurn.evidenceUrl = parsed.evidenceUrl;
    if (parsed.verifierScope) currentTurn.verifierScope = parsed.verifierScope;
    if (parsed.title) currentTurn.outcome = parsed.title;
    if (isSettledRole(parsed.role)) {
      currentTurn.settledAt = createdAt;
      currentTurn.status = "settled";
    }
  }

  const latestExecutedTurn = [...turns].reverse().find((turn) => turn.events.length > 0) ?? null;
  let projectionWarning: string | null = null;
  if (pendingUserRequests.length > 0) {
    projectionWarning = `После последнего Atlas turn появились новые user comments (${pendingUserRequests.length}), но новый execution ещё не начался.`;
  } else if (
    latestExecutedTurn
    && input.projectedTurnNumber !== null
    && input.projectedTurnNumber !== undefined
    && latestExecutedTurn.sequence > input.projectedTurnNumber
  ) {
    projectionWarning = `История comments уже дошла до TURN ${latestExecutedTurn.sequence}, но atlas-execution всё ещё проецируется как TURN ${input.projectedTurnNumber}.`;
  }

  return {
    turns,
    latestExecutedTurn,
    pendingUserRequests,
    projectionWarning,
  };
}
