import type { Issue, IssueComment } from "@paperclipai/shared";

export interface IssueExecutionTurnEvent {
  role: string;
  title: string | null;
  summary: string | null;
  createdAt: string;
  sourceCommentId: string | null;
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
  latestCommentId: string | null;
  events: IssueExecutionTurnEvent[];
}

export interface IssueExecutionCommentContext {
  turns: IssueExecutionTurn[];
  latestExecutedTurn: IssueExecutionTurn | null;
  pendingUserRequests: string[];
  pendingConversation: IssueNarrativeChatMessage[];
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
    Pick<IssueComment, "id" | "authorAgentId" | "authorUserId" | "body" | "createdAt">
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
  turnNumber: number | null;
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

function extractTurnNumber(body: string): number | null {
  const labeledMatch = /(?:^|\n)\s*[-*]?\s*(?:Текущий\s+turn|Turn|Задача)\s*:\s*`?TURN\s*(\d+)`?/im.exec(body);
  if (labeledMatch?.[1]) {
    const parsed = Number.parseInt(labeledMatch[1], 10);
    if (Number.isFinite(parsed)) return parsed;
  }

  const genericMatch = /\bTURN\s*(\d+)\b/i.exec(body);
  if (genericMatch?.[1]) {
    const parsed = Number.parseInt(genericMatch[1], 10);
    if (Number.isFinite(parsed)) return parsed;
  }

  return null;
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
    turnNumber: extractTurnNumber(body),
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
  return normalized.startsWith("recovery reroute:")
    || normalized.startsWith("[instant-chat-smoke ");
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
    latestCommentId: null,
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

function humanizeOutcome(outcome: string | null): string | null {
  const normalized = cleanMarkdownText(outcome ?? "").toLowerCase();
  if (!normalized) return null;
  if (normalized.includes("проверка не прошла") || normalized.includes("с замечаниями")) {
    return "автопроверка не подтвердила результат";
  }
  if (normalized.includes("готова к ревью") || normalized.includes("готово для проверки человеком")) {
    return "правка доведена до review";
  }
  if (normalized.includes("attach-ready") || normalized.includes("взят в работу") || normalized.includes("execution запущен")) {
    return "задача взята в работу";
  }
  return cleanMarkdownText(outcome ?? "");
}

function extractImplementationSummary(turn: IssueExecutionTurn): string | null {
  const preferredRoles = ["reporter", "atlas executor", "stand controller"];
  for (const role of preferredRoles) {
    const match = [...turn.events]
      .reverse()
      .find((event) => event.role.trim().toLowerCase() === role && event.summary);
    const summary = cleanMarkdownText(match?.summary ?? "");
    if (summary) return summary;
  }
  const fallbackSummary = [...turn.events]
    .reverse()
    .map((event) => cleanMarkdownText(event.summary ?? event.title ?? ""))
    .find(Boolean);
  return fallbackSummary ?? null;
}

function buildNarrativeLinks(turn: IssueExecutionTurn): IssueNarrativeChatLink[] {
  const links: IssueNarrativeChatLink[] = [
    { label: "Полное описание", url: "#document-atlas-execution" },
    { label: "Diff / файлы", url: "#document-atlas-change-summary" },
    { label: "Артефакты / debug", url: "#document-atlas-debug-pack" },
  ];
  if (turn.latestCommentId) {
    links.push({ label: "Комментарий", url: `#comment-${turn.latestCommentId}` });
  }
  if (turn.standUrl) links.push({ label: "Открыть стенд", url: turn.standUrl });
  if (turn.evidenceUrl) links.push({ label: "Открыть evidence", url: turn.evidenceUrl });
  return links;
}

function summarizeTurnForHuman(turn: IssueExecutionTurn): Omit<IssueNarrativeChatMessage, "id" | "createdAt" | "speaker"> | null {
  const outcome = cleanMarkdownText(turn.outcome ?? "");
  const proof = humanizeVerifierScope(turn.verifierScope);
  const implementation = extractImplementationSummary(turn);
  const links = buildNarrativeLinks(turn);

  if (!outcome && !proof) return null;

  const lowerOutcome = outcome.toLowerCase();
  if (lowerOutcome.includes("проверка не прошла") || lowerOutcome.includes("с замечаниями")) {
    return {
      body: compactLines([
        `TURN ${turn.sequence}: ${humanizeOutcome(turn.outcome) ?? "автопроверка не подтвердила результат"}.`,
        implementation ? `Что сделали: ${implementation}.` : null,
        proof ? `Что доказано: ${proof}` : null,
      ]),
      tone: "error",
      links,
    };
  }

  if (lowerOutcome.includes("готова к ревью") || lowerOutcome.includes("готово для проверки человеком")) {
    const genericProof = proof?.includes("не доказывает") || proof?.includes("слишком общей");
    return {
      body: compactLines([
        `TURN ${turn.sequence}: ${humanizeOutcome(turn.outcome) ?? "правка доведена до review"}.`,
        implementation ? `Что сделали: ${implementation}.` : null,
        proof
          ? genericProof
            ? `Что доказано: ${proof}`
            : `Что доказано: ${proof}`
          : null,
      ]),
      tone: genericProof ? "warn" : "success",
      links,
    };
  }

  if (lowerOutcome.includes("attach-ready") || lowerOutcome.includes("взят в работу") || lowerOutcome.includes("execution запущен")) {
    return {
      body: compactLines([
        `TURN ${turn.sequence}: ${humanizeOutcome(turn.outcome) ?? "задача взята в работу"}.`,
        implementation ? `Что сделали: ${implementation}.` : null,
      ]),
      tone: "working",
      links,
    };
  }

  return {
    body: compactLines([
      `TURN ${turn.sequence}: ${humanizeOutcome(turn.outcome) ?? "есть новое обновление по задаче"}.`,
      implementation ? `Что сделали: ${implementation}.` : null,
      proof ? `Что доказано: ${proof}` : null,
    ]),
    tone: "info",
    links,
  };
}

function summarizeBridgeCommentForHuman(comment: ParsedBridgeComment, sourceCommentId: string | null): Omit<IssueNarrativeChatMessage, "id" | "createdAt" | "speaker"> | null {
  const title = cleanMarkdownText(comment.title ?? "");
  const proof = humanizeVerifierScope(comment.verifierScope);
  const links: IssueNarrativeChatLink[] = [
    { label: "Полное описание", url: "#document-atlas-execution" },
    { label: "Diff / файлы", url: "#document-atlas-change-summary" },
    { label: "Артефакты / debug", url: "#document-atlas-debug-pack" },
  ];
  if (sourceCommentId) links.push({ label: "Комментарий", url: `#comment-${sourceCommentId}` });
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

function buildPendingConversationMessages(input: {
  comments: Array<
    Pick<IssueComment, "id" | "authorAgentId" | "authorUserId" | "body" | "createdAt">
  >;
  latestExecutedTurn: IssueExecutionTurn | null;
}): IssueNarrativeChatMessage[] {
  const boundaryTimestamp = input.latestExecutedTurn?.settledAt
    ?? input.latestExecutedTurn?.startedAt
    ?? null;
  const boundaryMs = boundaryTimestamp
    ? new Date(normalizeTimestamp(boundaryTimestamp)).getTime()
    : Number.NEGATIVE_INFINITY;

  return input.comments
    .filter((comment) => new Date(normalizeTimestamp(comment.createdAt)).getTime() > boundaryMs)
    .flatMap((comment): IssueNarrativeChatMessage[] => {
      if (isPlainUserComment(comment)) {
        const request = cleanMarkdownText(comment.body);
        if (!request || shouldIgnoreAsOperationalUserComment(request)) return [];
        return [{
          id: `pending-comment-${comment.id}`,
          speaker: "user",
          body: request,
          createdAt: normalizeTimestamp(comment.createdAt),
          tone: "info",
        }];
      }

      if (parseBridgeComment(comment.body) || parseMergeRequestComment(comment.body)) {
        return [];
      }

      const body = cleanMarkdownText(comment.body);
      if (!body) return [];

      return [{
        id: `pending-comment-${comment.id}`,
        speaker: "assistant",
        body,
        createdAt: normalizeTimestamp(comment.createdAt),
        tone: "working",
      }];
    });
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
  const turnBySequence = new Map<number, IssueExecutionTurn>([[1, currentTurn]]);

  function ensureTurn(sequence: number): IssueExecutionTurn {
    while (turns.length < sequence) {
      const nextTurn = makeTurn(turns.length + 1, pendingUserRequests.shift() ?? null);
      turns.push(nextTurn);
      turnBySequence.set(nextTurn.sequence, nextTurn);
    }
    return turnBySequence.get(sequence)!;
  }

  for (const comment of ordered) {
    if (isPlainUserComment(comment)) {
      const request = cleanMarkdownText(comment.body);
      if (!request || shouldIgnoreAsOperationalUserComment(request)) continue;
      pendingUserRequests.push(request);
      continue;
    }

    const parsed = parseBridgeComment(comment.body);
    if (!parsed) continue;

    let targetTurn = currentTurn;

    if (parsed.turnNumber && parsed.turnNumber > 0) {
      targetTurn = ensureTurn(parsed.turnNumber);
      if (targetTurn.sequence > currentTurn.sequence) {
        currentTurn.status = currentTurn.settledAt ? "settled" : currentTurn.status;
        currentTurn = targetTurn;
      }
    } else if (isTurnStartRole(parsed.role) && currentTurn.events.length > 0 && pendingUserRequests.length > 0) {
      currentTurn.status = currentTurn.settledAt ? "settled" : currentTurn.status;
      currentTurn = ensureTurn(turns.length + 1);
      targetTurn = currentTurn;
    }

    const createdAt = normalizeTimestamp(comment.createdAt);
    targetTurn.startedAt ??= createdAt;
    targetTurn.events.push({
      role: parsed.role,
      title: parsed.title,
      summary: parsed.summary,
      createdAt,
      sourceCommentId: comment.id,
    });
    targetTurn.latestCommentId = comment.id;

    if (parsed.standUrl) targetTurn.standUrl = parsed.standUrl;
    if (parsed.evidenceUrl) targetTurn.evidenceUrl = parsed.evidenceUrl;
    if (parsed.verifierScope) targetTurn.verifierScope = parsed.verifierScope;
    if (parsed.title) targetTurn.outcome = parsed.title;
    if (isSettledRole(parsed.role)) {
      targetTurn.settledAt = createdAt;
      targetTurn.status = "settled";
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
    pendingConversation: buildPendingConversationMessages({
      comments: ordered,
      latestExecutedTurn,
    }),
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
        reply: summarizeBridgeCommentForHuman(entry.parsed!, entry.candidate.id),
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
      continue;
    }

    const agentReply = [...replyCandidates]
      .reverse()
      .find((candidate) => !parseMergeRequestComment(candidate.body) && !parseBridgeComment(candidate.body) && Boolean(cleanMarkdownText(candidate.body)));

    if (agentReply) {
      messages.push({
        id: `comment-${comment.id}-agent-reply`,
        speaker: "assistant",
        createdAt: normalizeTimestamp(agentReply.createdAt),
        body: cleanMarkdownText(agentReply.body),
        tone: "working",
      });
    }
  }

  return messages.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
}
