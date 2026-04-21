import type { Agent, Issue, LiveEvent } from "@paperclipai/shared";

export type IssueChatLiveSignalState =
  | "accepted"
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "blocked";

export type IssueChatLiveTone = "working" | "success" | "warning" | "danger" | "neutral";

export interface IssueChatLiveSignal {
  state: IssueChatLiveSignalState;
  title: string;
  summary: string;
  detail: string | null;
  turnLabel: string | null;
  updatedAt: string;
}

export interface IssueChatLiveFeedItem {
  key: string;
  createdAt: string;
  title: string;
  summary: string;
  tone: IssueChatLiveTone;
}

export interface IssueChatLiveUpdate {
  signal: IssueChatLiveSignal | null;
  feedItem: IssueChatLiveFeedItem | null;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}\u2026`;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function buildIssueRefs(issue: Pick<Issue, "id" | "identifier"> | null | undefined): Set<string> {
  const refs = new Set<string>();
  if (issue?.id) refs.add(issue.id);
  if (issue?.identifier) refs.add(issue.identifier);
  return refs;
}

function matchesIssueRefs(
  refs: Set<string>,
  entityId: string | null,
  details: Record<string, unknown> | null,
): boolean {
  if (entityId && refs.has(entityId)) return true;
  const identifier = readString(details?.identifier) ?? readString(details?.issueIdentifier);
  if (identifier && refs.has(identifier)) return true;
  const issueId = readString(details?.issueId);
  return !!issueId && refs.has(issueId);
}

function resolveAgentLabel(agents: Agent[] | null | undefined, agentId: string | null): string {
  if (!agentId) return "Agent";
  return agents?.find((agent) => agent.id === agentId)?.name ?? "Agent";
}

function resolveTargetAgentLabel(
  agents: Agent[] | null | undefined,
  details: Record<string, unknown> | null,
  fallbackAgentId: string | null,
): string {
  const targetAgentName = readString(details?.targetAgentName);
  if (targetAgentName) return targetAgentName;
  const targetAgentId = readString(details?.targetAgentId) ?? fallbackAgentId;
  return resolveAgentLabel(agents, targetAgentId);
}

function normalizeTurnLabel(
  details: Record<string, unknown> | null,
  payload: Record<string, unknown>,
): string | null {
  const explicit =
    readString(details?.turnLabel)
    ?? readString(payload.turnLabel)
    ?? null;
  if (explicit) return explicit;
  const turnNumber =
    typeof details?.turnNumber === "number"
      ? details.turnNumber
      : typeof payload.turnNumber === "number"
        ? payload.turnNumber
        : typeof details?.nextTurn === "number"
          ? details.nextTurn
          : null;
  return Number.isFinite(turnNumber) ? `TURN ${turnNumber}` : null;
}

function buildFeedItem(
  key: string,
  createdAt: string,
  title: string,
  summary: string,
  tone: IssueChatLiveTone,
): IssueChatLiveFeedItem {
  return {
    key,
    createdAt,
    title,
    summary,
    tone,
  };
}

function buildSignal(
  state: IssueChatLiveSignalState,
  createdAt: string,
  title: string,
  summary: string,
  detail: string | null,
  turnLabel: string | null,
): IssueChatLiveSignal {
  return {
    state,
    title,
    summary,
    detail,
    turnLabel,
    updatedAt: createdAt,
  };
}

function fromActivityEvent(
  event: LiveEvent,
  issueRefs: Set<string>,
  agents: Agent[] | null | undefined,
): IssueChatLiveUpdate | null {
  if (event.type !== "activity.logged") return null;
  const payload = readRecord(event.payload) ?? {};
  const details = readRecord(payload.details);
  const action = readString(payload.action);
  const entityType = readString(payload.entityType);
  const entityId = readString(payload.entityId);

  if (entityType !== "issue" || !matchesIssueRefs(issueRefs, entityId, details)) {
    return null;
  }

  const agentLabel = resolveAgentLabel(agents, readString(payload.agentId));
  const requestType = readString(details?.requestType);
  const turnLabel = normalizeTurnLabel(details, payload);

  if (action === "issue.followup_requested") {
    const targetAgentLabel = resolveTargetAgentLabel(agents, details, readString(payload.agentId));
    const title = "Thinking";
    const summary = requestType === "directed_agent"
      ? targetAgentLabel
      : turnLabel ?? agentLabel;
    return {
      signal: buildSignal("accepted", event.createdAt, title, summary, null, turnLabel),
      feedItem: buildFeedItem(`activity:${event.id}`, event.createdAt, title, summary, "working"),
    };
  }

  if (action === "issue.followup_blocked") {
    const targetAgentLabel = resolveTargetAgentLabel(agents, details, readString(payload.agentId));
    const error = readString(details?.error)
      ?? (requestType === "directed_agent"
        ? "Комментарий сохранён, но сообщение не удалось отправить выбранному агенту."
        : "Комментарий сохранён, но follow-up не удалось отправить в Atlas.");
    return {
      signal: buildSignal(
        "blocked",
        event.createdAt,
        "Blocked",
        error,
        null,
        turnLabel,
      ),
      feedItem: buildFeedItem(
        `activity:${event.id}`,
        event.createdAt,
        "Blocked",
        error,
        "danger",
      ),
    };
  }

  if (action === "issue.comment_added" && readString(payload.actorType) === "agent") {
    const snippet = readString(details?.bodySnippet);
    if (!snippet) return null;
    return {
      signal: null,
      feedItem: buildFeedItem(
        `activity:${event.id}`,
        event.createdAt,
        `${agentLabel} ответил в тред`,
        snippet,
        "neutral",
      ),
    };
  }

  return null;
}

function fromRunLogEvent(
  event: LiveEvent,
  issueRefs: Set<string>,
  agents: Agent[] | null | undefined,
): IssueChatLiveUpdate | null {
  if (event.type !== "heartbeat.run.log") return null;
  const payload = readRecord(event.payload) ?? {};
  const issueId = readString(payload.issueId);
  if (!issueId || !issueRefs.has(issueId)) return null;

  const rawChunk = readString(payload.chunk);
  if (!rawChunk) return null;
  const lines = rawChunk
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const summary = truncate(lines.at(-1) ?? rawChunk.trim(), 180);
  if (!summary) return null;

  const stream = readString(payload.stream) ?? "stdout";
  const agentLabel = resolveAgentLabel(agents, readString(payload.agentId));
  return {
    signal: null,
    feedItem: buildFeedItem(
      `run-log:${event.id}`,
      event.createdAt,
      stream === "stderr" ? `${agentLabel}: stderr` : `${agentLabel}: live output`,
      summary,
      stream === "stderr" ? "danger" : stream === "system" ? "neutral" : "working",
    ),
  };
}

function fromRunQueuedEvent(
  event: LiveEvent,
  issueRefs: Set<string>,
  agents: Agent[] | null | undefined,
): IssueChatLiveUpdate | null {
  if (event.type !== "heartbeat.run.queued") return null;
  const payload = readRecord(event.payload) ?? {};
  const issueId = readString(payload.issueId);
  if (!issueId || !issueRefs.has(issueId)) return null;

  const agentLabel = resolveAgentLabel(agents, readString(payload.agentId));
  const turnLabel = readString(payload.triggerDetail) ?? readString(payload.turnLabel) ?? null;
  const summary = [turnLabel, agentLabel].filter(Boolean).join(" · ") || agentLabel;
  return {
    signal: buildSignal("queued", event.createdAt, "Starting", summary, null, turnLabel),
    feedItem: buildFeedItem(`run:${event.id}`, event.createdAt, "Starting", summary, "working"),
  };
}

function fromRunStatusEvent(
  event: LiveEvent,
  issueRefs: Set<string>,
  agents: Agent[] | null | undefined,
): IssueChatLiveUpdate | null {
  if (event.type !== "heartbeat.run.status") return null;
  const payload = readRecord(event.payload) ?? {};
  const issueId = readString(payload.issueId);
  if (!issueId || !issueRefs.has(issueId)) return null;

  const agentLabel = resolveAgentLabel(agents, readString(payload.agentId));
  const status = readString(payload.status)?.toLowerCase() ?? "updated";
  const detail = readString(payload.error) ?? readString(payload.errorCode) ?? readString(payload.triggerDetail);
  const turnLabel = readString(payload.triggerDetail) ?? readString(payload.turnLabel) ?? null;

  if (status === "running") {
    const summary = [turnLabel, agentLabel].filter(Boolean).join(" · ") || agentLabel;
    return {
      signal: buildSignal("running", event.createdAt, "Running", summary, null, turnLabel),
      feedItem: buildFeedItem(`run:${event.id}`, event.createdAt, "Running", summary, "working"),
    };
  }

  if (status === "succeeded") {
    const summary = [turnLabel, agentLabel].filter(Boolean).join(" · ") || agentLabel;
    return {
      signal: buildSignal("completed", event.createdAt, "Done", summary, null, turnLabel),
      feedItem: buildFeedItem(`run:${event.id}`, event.createdAt, "Done", summary, "success"),
    };
  }

  if (status === "failed" || status === "timed_out" || status === "cancelled") {
    const summary = detail ?? agentLabel;
    return {
      signal: buildSignal("failed", event.createdAt, "Failed", summary, null, null),
      feedItem: buildFeedItem(`run:${event.id}`, event.createdAt, "Failed", summary, "danger"),
    };
  }

  return {
    signal: null,
    feedItem: buildFeedItem(
      `run:${event.id}`,
      event.createdAt,
      `${agentLabel} обновил run`,
      `${agentLabel} сообщил новый статус: ${status}.`,
      "neutral",
    ),
  };
}

function fromRunEvent(
  event: LiveEvent,
  issueRefs: Set<string>,
  agents: Agent[] | null | undefined,
): IssueChatLiveUpdate | null {
  if (event.type !== "heartbeat.run.event") return null;
  const payload = readRecord(event.payload) ?? {};
  const issueId = readString(payload.issueId);
  if (!issueId || !issueRefs.has(issueId)) return null;

  const message = readString(payload.message);
  if (!message) return null;

  const agentLabel = resolveAgentLabel(agents, readString(payload.agentId));
  const eventType = readString(payload.eventType) ?? "event";
  return {
    signal: null,
    feedItem: buildFeedItem(
      `run-event:${event.id}`,
      event.createdAt,
      `${agentLabel}: ${eventType}`,
      message,
      eventType === "error" ? "danger" : "working",
    ),
  };
}

export function normalizeIssueChatLiveEvent(input: {
  event: LiveEvent;
  issue: Pick<Issue, "id" | "identifier"> | null | undefined;
  agents?: Agent[] | null;
}): IssueChatLiveUpdate | null {
  const issueRefs = buildIssueRefs(input.issue);
  if (issueRefs.size === 0) return null;

  return (
    fromActivityEvent(input.event, issueRefs, input.agents)
    ?? fromRunQueuedEvent(input.event, issueRefs, input.agents)
    ?? fromRunStatusEvent(input.event, issueRefs, input.agents)
    ?? fromRunEvent(input.event, issueRefs, input.agents)
    ?? fromRunLogEvent(input.event, issueRefs, input.agents)
  );
}
