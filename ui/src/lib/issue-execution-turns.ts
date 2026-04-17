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

export interface IssueNarrativeChatLink {
  label: string;
  url: string;
}

export interface IssueNarrativeChatMessage {
  id: string;
  speaker: "user" | "assistant";
  body: string;
  createdAt: string;
  tone: "info" | "working" | "success" | "warn" | "error";
  links?: IssueNarrativeChatLink[];
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

interface ParsedMergeRequestComment {
  url: string;
  branch: string | null;
}

function normalizeTimestamp(value: Date | string | null | undefined): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value.trim().length > 0) return value;
  return "1970-01-01T00:00:00.000Z";
}

function extractDisplayRole(body: string): string | null {
  const markerMatch = /paperclip-display-author:\s*[^·\n]+·\s*([^\n>]+?)\s*-->/.exec(body);
  if (markerMatch?.[1]) return markerMatch[1].trim();
  const headingMatch = /^###+\s+(.+)$/m.exec(body);
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

function parseMergeRequestComment(body: string): ParsedMergeRequestComment | null {
  const urlMatch = /^MR:\s+(https?:\/\/\S+)$/mi.exec(body);
  if (!urlMatch?.[1]) return null;
  const branchMatch = /^Ветка:\s+`([^`]+)`$/mi.exec(body);
  return {
    url: urlMatch[1].trim(),
    branch: branchMatch?.[1]?.trim() || null,
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

function humanizeVerifierScope(scope: string | null): string | null {
  const normalized = cleanMarkdownText(scope ?? "").toLowerCase();
  if (!normalized) return null;
  if (normalized.includes("project media surface regression")) {
    return "Автопроверка посмотрела только страницу Project media. Она не доказывает fullscreen gallery, double tap, zoom, swipe и управление клавиатурой.";
  }
  if (normalized.includes("manual verify")) {
    return "Автопроверка была слишком общей и не доказала, что нужная правка действительно работает.";
  }
  return `Автопроверка проверила сценарий «${cleanMarkdownText(scope ?? "")}».`;
}

function summarizeTurnForHuman(turn: IssueExecutionTurn): Omit<IssueNarrativeChatMessage, "id" | "createdAt" | "speaker"> | null {
  const outcome = cleanMarkdownText(turn.outcome ?? "");
  const proof = humanizeVerifierScope(turn.verifierScope);
  const links: IssueNarrativeChatLink[] = [];
  if (turn.standUrl) links.push({ label: "Открыть стенд", url: turn.standUrl });
  if (turn.evidenceUrl) links.push({ label: "Открыть evidence", url: turn.evidenceUrl });

  if (!outcome && !proof) return null;

  const lowerOutcome = outcome.toLowerCase();
  if (lowerOutcome.includes("проверка не прошла") || lowerOutcome.includes("с замечаниями")) {
    return {
      body: compactLines([
        "Автопроверка не подтвердила результат.",
        proof,
      ]),
      tone: "error",
      links,
    };
  }

  if (lowerOutcome.includes("готова к ревью") || lowerOutcome.includes("готово для проверки человеком")) {
    const genericProof = proof?.includes("не доказывает") || proof?.includes("слишком общей");
    return {
      body: compactLines([
        genericProof
          ? "Правка дошла до review, но доказательство получилось слишком общим."
          : "Правка доведена до review.",
        proof,
      ]),
      tone: genericProof ? "warn" : "success",
      links,
    };
  }

  if (lowerOutcome.includes("attach-ready") || lowerOutcome.includes("взят в работу") || lowerOutcome.includes("execution запущен")) {
    return {
      body: compactLines([
        "Задача взята в работу.",
        turn.standUrl ? `Стенд уже есть: ${turn.standUrl}.` : null,
      ]),
      tone: "working",
      links,
    };
  }

  return {
    body: compactLines([
      outcome || "Есть новое обновление по задаче.",
      proof,
    ]),
    tone: "info",
    links,
  };
}

function summarizeBridgeCommentForHuman(comment: ParsedBridgeComment): Omit<IssueNarrativeChatMessage, "id" | "createdAt" | "speaker"> | null {
  const title = cleanMarkdownText(comment.title ?? "");
  const proof = humanizeVerifierScope(comment.verifierScope);
  const links: IssueNarrativeChatLink[] = [];
  if (comment.standUrl) links.push({ label: "Открыть стенд", url: comment.standUrl });
  if (comment.evidenceUrl) links.push({ label: "Открыть evidence", url: comment.evidenceUrl });

  if (!title && !comment.summary && !proof) return null;

  const lowerTitle = title.toLowerCase();
  if (lowerTitle.includes("attach-ready") || lowerTitle.includes("взят в работу") || lowerTitle.includes("execution запущен")) {
    return {
      body: compactLines([
        "Задача запущена, жду стенд и первый результат.",
        comment.standUrl ? `Стенд: ${comment.standUrl}.` : null,
      ]),
      tone: "working",
      links,
    };
  }
  if (lowerTitle.includes("проверка не прошла") || lowerTitle.includes("с замечаниями")) {
    return {
      body: compactLines([
        "Автопроверка не подтвердила результат.",
        proof,
      ]),
      tone: "error",
      links,
    };
  }
  if (lowerTitle.includes("готова к ревью") || lowerTitle.includes("готово для проверки человеком")) {
    const genericProof = proof?.includes("не доказывает") || proof?.includes("слишком общей");
    return {
      body: compactLines([
        genericProof
          ? "Правка выглядит готовой, но автопроверка пока не доказала именно тот результат, который ты просил."
          : "Правка выглядит готовой к review.",
        proof,
      ]),
      tone: genericProof ? "warn" : "success",
      links,
    };
  }
  return {
    body: compactLines([
      cleanMarkdownText(comment.summary ?? comment.title ?? ""),
      proof,
    ]),
    tone: "info",
    links,
  };
}

function compactLines(parts: Array<string | null | undefined>): string {
  return parts
    .map((part) => cleanMarkdownText(part ?? ""))
    .filter(Boolean)
    .join(" ");
}

function normalizeRequest(value: string | null | undefined): string {
  return cleanMarkdownText(value ?? "").toLowerCase();
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

export function buildIssueNarrativeChatMessages(input: {
  issue: Pick<Issue, "title" | "description" | "createdAt">;
  comments: Array<
    Pick<IssueComment, "id" | "authorAgentId" | "authorUserId" | "body" | "createdAt">
  >;
  context: IssueExecutionCommentContext | null;
}): IssueNarrativeChatMessage[] {
  const context = input.context;
  if (!context) return [];

  const orderedComments = [...input.comments].sort(
    (a, b) => new Date(normalizeTimestamp(a.createdAt)).getTime() - new Date(normalizeTimestamp(b.createdAt)).getTime(),
  );

  const matchedUserCommentIds = new Set<string>();
  const messages: IssueNarrativeChatMessage[] = [];
  const initialRequest = buildInitialRequest(input.issue);
  const firstTurn = context.turns[0] ?? null;

  if (initialRequest) {
    messages.push({
      id: "initial-request",
      speaker: "user",
      body: initialRequest,
      createdAt: normalizeTimestamp(input.issue.createdAt),
      tone: "info",
    });
  }

  for (const [index, turn] of context.turns.entries()) {
    if (index > 0 && turn.request) {
      const matchedComment = orderedComments.find((comment) => {
        if (!isPlainUserComment(comment) || matchedUserCommentIds.has(comment.id)) return false;
        return normalizeRequest(comment.body) === normalizeRequest(turn.request);
      });
      if (matchedComment) {
        matchedUserCommentIds.add(matchedComment.id);
      }
      messages.push({
        id: `turn-${turn.sequence}-request`,
        speaker: "user",
        body: turn.request,
        createdAt: normalizeTimestamp(matchedComment?.createdAt ?? turn.startedAt),
        tone: "info",
      });
    }

    const assistantReply = summarizeTurnForHuman(turn);
    if (assistantReply) {
      messages.push({
        id: `turn-${turn.sequence}-reply`,
        speaker: "assistant",
        createdAt: normalizeTimestamp(turn.settledAt ?? turn.startedAt),
        ...assistantReply,
      });
    }
  }

  const plainUserComments = orderedComments.filter((comment) => isPlainUserComment(comment));
  for (const [index, comment] of plainUserComments.entries()) {
    if (matchedUserCommentIds.has(comment.id)) continue;
    const request = cleanMarkdownText(comment.body);
    if (!request || shouldIgnoreAsOperationalUserComment(request)) continue;
    messages.push({
      id: `comment-${comment.id}`,
      speaker: "user",
      body: request,
      createdAt: normalizeTimestamp(comment.createdAt),
      tone: "info",
    });

    const nextUserCommentAt = plainUserComments[index + 1]?.createdAt
      ? new Date(normalizeTimestamp(plainUserComments[index + 1].createdAt)).getTime()
      : Number.POSITIVE_INFINITY;
    const commentCreatedAtMs = new Date(normalizeTimestamp(comment.createdAt)).getTime();
    const replyCandidates = orderedComments.filter((candidate) => {
      const candidateTime = new Date(normalizeTimestamp(candidate.createdAt)).getTime();
      if (candidateTime <= commentCreatedAtMs || candidateTime >= nextUserCommentAt) return false;
      return !isPlainUserComment(candidate);
    });

    const mergeRequestComment = replyCandidates
      .map((candidate) => ({ candidate, mr: parseMergeRequestComment(candidate.body) }))
      .find((entry) => entry.mr);
    if (mergeRequestComment?.mr) {
      messages.push({
        id: `comment-${comment.id}-mr`,
        speaker: "assistant",
        body: mergeRequestComment.mr.branch
          ? `Создал MR для этой ветки: ${mergeRequestComment.mr.branch}.`
          : "Создал MR для этой задачи.",
        createdAt: normalizeTimestamp(mergeRequestComment.candidate.createdAt),
        tone: "success",
        links: [{ label: "Открыть MR", url: mergeRequestComment.mr.url }],
      });
      continue;
    }

    const bridgeReply = replyCandidates
      .map((candidate) => ({ candidate, parsed: parseBridgeComment(candidate.body) }))
      .filter((entry) => entry.parsed)
      .map((entry) => ({
        createdAt: normalizeTimestamp(entry.candidate.createdAt),
        reply: summarizeBridgeCommentForHuman(entry.parsed!),
      }))
      .filter((entry) => entry.reply)
      .pop();

    if (bridgeReply?.reply) {
      messages.push({
        id: `comment-${comment.id}-reply`,
        speaker: "assistant",
        createdAt: bridgeReply.createdAt,
        ...bridgeReply.reply,
      });
    }
  }

  return messages.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
}
