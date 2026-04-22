#!/usr/bin/env tsx

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildIssueConversationModel } from "../ui/src/lib/issue-conversation-model.ts";
import { buildIssueExecutionCommentContext, buildIssueNarrativeChatMessages } from "../ui/src/lib/issue-execution-turns.ts";
import { parseExecutionDocument } from "../ui/src/lib/issue-execution-flow.ts";

const DEFAULT_BASE_URL = process.env.PAPERCLIP_PUBLIC_URL || "https://org.homio.pro";
const DEFAULT_AUTH_FILE = path.join(os.homedir(), ".paperclip", "auth.json");
const DEFAULT_OUTPUT_DIR = "/Users/s1z0v/kd-projects/Paperclip/state/reports/issue-chat-debug";

type AuthRecord = {
  token: string;
  companyId: string | null;
};

type DebugAnomaly = {
  code: string;
  severity: "info" | "warn" | "error";
  message: string;
  detail?: Record<string, unknown>;
};

type ApiIssue = {
  id: string;
  identifier?: string | null;
  title: string;
  description?: string | null;
  companyId: string;
  status: string;
  priority?: string | null;
  assigneeAgentId?: string | null;
  executionRunId?: string | null;
  createdAt?: string | Date | null;
  updatedAt?: string | Date | null;
};

type ApiIssueComment = {
  id: string;
  authorAgentId?: string | null;
  authorUserId?: string | null;
  body: string;
  createdAt: string | Date;
};

type ApiIssueDocument = {
  id: string;
  key: string;
  title?: string | null;
  body?: string | null;
  updatedAt?: string | null;
};

type ApiLiveRun = {
  id: string;
  status: string;
  invocationSource: string;
  triggerDetail: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  agentId: string;
  agentName: string;
  adapterType: string;
  issueId?: string | null;
  syntheticSource?: "atlas_execution" | null;
  openable?: boolean;
  slotEnv?: string | null;
};

type ApiActiveRun = {
  id: string;
  status: string;
  agentId: string;
  agentName: string;
  adapterType: string;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
};

type ApiRunForIssue = {
  runId: string;
  status: string;
  agentId: string;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  invocationSource: string;
  usageJson: Record<string, unknown> | null;
  resultJson: Record<string, unknown> | null;
};

type ApiActivityEvent = {
  id: string;
  action: string | null;
  createdAt: string;
  actorType: string | null;
  entityType: string | null;
  entityId: string | null;
  details?: Record<string, unknown> | null;
};

type HeartbeatRunEvent = {
  seq?: number;
  type?: string;
  createdAt?: string;
  payload?: Record<string, unknown> | null;
};

function parseArgs(argv: string[]) {
  const args = {
    issueRef: null as string | null,
    baseUrl: DEFAULT_BASE_URL,
    authFile: DEFAULT_AUTH_FILE,
    outputDir: DEFAULT_OUTPUT_DIR,
    activityLimit: 80,
    eventLimit: 80,
    logBytes: 20_000,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--") {
      continue;
    }
    if ((arg === "--issue" || arg === "-i") && next) {
      args.issueRef = next;
      index += 1;
      continue;
    }
    if (arg === "--base-url" && next) {
      args.baseUrl = next;
      index += 1;
      continue;
    }
    if (arg === "--auth-file" && next) {
      args.authFile = next;
      index += 1;
      continue;
    }
    if (arg === "--output-dir" && next) {
      args.outputDir = next;
      index += 1;
      continue;
    }
    if (arg === "--activity-limit" && next) {
      args.activityLimit = Number.parseInt(next, 10);
      index += 1;
      continue;
    }
    if (arg === "--event-limit" && next) {
      args.eventLimit = Number.parseInt(next, 10);
      index += 1;
      continue;
    }
    if (arg === "--log-bytes" && next) {
      args.logBytes = Number.parseInt(next, 10);
      index += 1;
      continue;
    }
    if (!arg.startsWith("--") && !args.issueRef) {
      args.issueRef = arg;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!args.issueRef) {
    throw new Error("Usage: pnpm debug:issue-chat -- --issue HOM-957");
  }
  return args;
}

function extractIssueToken(raw: string): string {
  const direct = raw.trim();
  const match = direct.match(/\/issues\/([A-Za-z0-9-]+)/);
  return match?.[1] ?? direct;
}

async function loadAuth(baseUrl: string, authFile: string): Promise<AuthRecord> {
  if (process.env.PAPERCLIP_API_KEY?.trim()) {
    return {
      token: process.env.PAPERCLIP_API_KEY.trim(),
      companyId: process.env.PAPERCLIP_COMPANY_ID?.trim() || null,
    };
  }
  const raw = JSON.parse(await fs.readFile(authFile, "utf8")) as {
    credentials?: Record<string, { token?: string; companyId?: string; apiBase?: string }>;
  };
  const credentials = raw.credentials ?? {};
  const exact = credentials[baseUrl];
  const fallback = Object.values(credentials).find((entry) => entry.apiBase === baseUrl);
  const record = exact ?? fallback;
  if (!record?.token?.trim()) {
    throw new Error(`No token for ${baseUrl} in ${authFile}`);
  }
  return {
    token: record.token.trim(),
    companyId: record.companyId?.trim() || null,
  };
}

async function api<T>(baseUrl: string, token: string, pathname: string, init?: RequestInit, allow404 = false): Promise<T | null> {
  const response = await fetch(new URL(pathname, baseUrl), {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (allow404 && response.status === 404) {
    return null;
  }
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${init?.method || "GET"} ${pathname} failed: ${response.status} ${response.statusText} ${text}`);
  }
  return text ? JSON.parse(text) as T : null;
}

async function resolveIssue(baseUrl: string, token: string, companyId: string | null, issueRef: string): Promise<ApiIssue> {
  const direct = await api<ApiIssue>(baseUrl, token, `/api/issues/${encodeURIComponent(issueRef)}`, undefined, true);
  if (direct) return direct;
  if (!companyId) {
    throw new Error(`Issue ${issueRef} was not found directly and no companyId was available for search`);
  }
  const results = await api<ApiIssue[]>(
    baseUrl,
    token,
    `/api/companies/${encodeURIComponent(companyId)}/issues?q=${encodeURIComponent(issueRef)}`,
  );
  const issue = (results ?? []).find((entry) => entry.identifier === issueRef) ?? (results ?? [])[0] ?? null;
  if (!issue) {
    throw new Error(`Could not resolve issue ${issueRef}`);
  }
  return issue;
}

function ensureIso(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  if (typeof value === "string") return value;
  return value.toISOString();
}

function tailText(value: string, maxChars: number) {
  if (value.length <= maxChars) return value;
  return value.slice(value.length - maxChars);
}

function findAnomalies(input: {
  issue: ApiIssue;
  context: ReturnType<typeof buildIssueExecutionCommentContext>;
  model: ReturnType<typeof buildIssueConversationModel>;
  liveRuns: ApiLiveRun[];
  activeRun: ApiActiveRun | null;
  parsedExecution: ReturnType<typeof parseExecutionDocument> | null;
  activity: ApiActivityEvent[];
}): DebugAnomaly[] {
  const anomalies: DebugAnomaly[] = [];
  const { issue, context, model, liveRuns, activeRun, parsedExecution, activity } = input;

  for (const turn of model.turns) {
    for (const bundle of turn.phaseBundles) {
      if ((bundle.itemCount ?? 0) > 0 && (bundle.items?.length ?? 0) === 0) {
        anomalies.push({
          code: "empty_bundle_items",
          severity: "error",
          message: `Bundle "${bundle.label}" shows badge ${bundle.itemCount}, but has no items`,
          detail: { turnId: turn.id, bundleId: bundle.id, summary: bundle.summary },
        });
      }
    }
  }

  if (!activeRun && liveRuns.length === 0) {
    const staleTurn = model.turns.find((turn) => turn.status === "queued" || turn.status === "running");
    if (staleTurn) {
      anomalies.push({
        code: "stale_surface_status",
        severity: "error",
        message: `Surface says ${staleTurn.statusLabel}, but API has no active-run and no live-runs`,
        detail: { turnId: staleTurn.id, turnLabel: staleTurn.turnLabel, summary: staleTurn.summary },
      });
    }
  }

  if (context.pendingUserRequests.length > 0) {
    const messageBundles = model.turns.flatMap((turn) => turn.phaseBundles.filter((bundle) => bundle.label === "Messages"));
    const totalBundleItems = messageBundles.reduce((sum, bundle) => sum + (bundle.items?.length ?? 0), 0);
    if (totalBundleItems < Math.max(0, context.pendingUserRequests.length - 1)) {
      anomalies.push({
        code: "pending_requests_not_materialized",
        severity: "warn",
        message: "Some pending follow-up requests are not materialized into folded message items",
        detail: {
          pendingUserRequests: context.pendingUserRequests.length,
          foldedItems: totalBundleItems,
        },
      });
    }
  }

  if (issue.status === "in_progress" && !activeRun && liveRuns.length === 0) {
    anomalies.push({
      code: "issue_in_progress_without_live_execution",
      severity: "warn",
      message: "Issue is in_progress but API does not expose an active or live run",
      detail: {
        assigneeAgentId: issue.assigneeAgentId ?? null,
        executionRunId: issue.executionRunId ?? null,
      },
    });
  }

  if (parsedExecution && context.latestExecutedTurn && parsedExecution.turnNumber !== null && parsedExecution.turnNumber < context.latestExecutedTurn.sequence) {
    anomalies.push({
      code: "execution_projection_stale",
      severity: "warn",
      message: "atlas-execution projection is behind the latest executed turn parsed from comments",
      detail: {
        parsedTurn: parsedExecution.turnNumber,
        latestExecutedTurn: context.latestExecutedTurn.sequence,
      },
    });
  }

  const recentAccepted = activity
    .filter((event) => event.action === "issue.followup_requested" || event.action === "issue.followup_accepted")
    .slice(0, 5);
  if (recentAccepted.length > 0 && !activeRun && liveRuns.length === 0 && context.pendingUserRequests.length > 0) {
    anomalies.push({
      code: "accepted_followup_without_launch",
      severity: "warn",
      message: "Recent follow-up acceptance exists, but there is still no live execution",
      detail: {
        recentAcceptedCount: recentAccepted.length,
      },
    });
  }

  return anomalies;
}

function buildMarkdownReport(input: {
  issue: ApiIssue;
  context: ReturnType<typeof buildIssueExecutionCommentContext>;
  model: ReturnType<typeof buildIssueConversationModel>;
  parsedExecution: ReturnType<typeof parseExecutionDocument> | null;
  liveRuns: ApiLiveRun[];
  activeRun: ApiActiveRun | null;
  anomalies: DebugAnomaly[];
  activity: ApiActivityEvent[];
  runs: ApiRunForIssue[];
  runDiagnostics: Record<string, { eventsTail: HeartbeatRunEvent[]; logTail: string | null }>;
}): string {
  const { issue, context, model, parsedExecution, liveRuns, activeRun, anomalies, activity, runs, runDiagnostics } = input;
  const lines: string[] = [];

  lines.push(`# Issue Chat Debug Report — ${issue.identifier ?? issue.id}`);
  lines.push("");
  lines.push(`- Title: ${issue.title}`);
  lines.push(`- Status: ${issue.status}`);
  lines.push(`- Active run: ${activeRun ? `${activeRun.id} (${activeRun.status})` : "none"}`);
  lines.push(`- Live runs: ${liveRuns.length}`);
  lines.push(`- Pending user requests: ${context.pendingUserRequests.length}`);
  lines.push(`- Latest executed turn: ${context.latestExecutedTurn ? `TURN ${context.latestExecutedTurn.sequence}` : "none"}`);
  if (parsedExecution) {
    lines.push(`- atlas-execution turn: ${parsedExecution.turnLabel ?? "none"}`);
    lines.push(`- atlas-execution state: ${parsedExecution.executionState ?? "none"}`);
  }
  lines.push("");

  lines.push("## Anomalies");
  if (anomalies.length === 0) {
    lines.push("- none");
  } else {
    for (const anomaly of anomalies) {
      lines.push(`- [${anomaly.severity}] ${anomaly.code}: ${anomaly.message}`);
    }
  }
  lines.push("");

  lines.push("## Surface Turns");
  for (const turn of model.turns) {
    lines.push(`- ${turn.turnLabel ?? `Turn ${turn.sequence}`}: ${turn.statusLabel} — ${turn.summary}`);
    for (const bundle of turn.phaseBundles) {
      lines.push(`  - ${bundle.label}: badge=${bundle.itemCount ?? 0}, items=${bundle.items?.length ?? 0}, summary=${bundle.summary}`);
    }
  }
  lines.push("");

  lines.push("## Pending Requests");
  if (context.pendingUserRequests.length === 0) {
    lines.push("- none");
  } else {
    context.pendingUserRequests.forEach((message, index) => {
      lines.push(`- ${index + 1}. ${message}`);
    });
  }
  lines.push("");

  lines.push("## Recent Activity");
  const recentActivity = activity.slice(0, 12);
  if (recentActivity.length === 0) {
    lines.push("- none");
  } else {
    for (const event of recentActivity) {
      lines.push(`- ${event.createdAt}: ${event.action ?? "unknown"} (${event.actorType ?? "unknown"})`);
    }
  }
  lines.push("");

  lines.push("## Runs For Issue");
  if (runs.length === 0) {
    lines.push("- none");
  } else {
    for (const run of runs.slice(0, 12)) {
      lines.push(`- ${run.runId}: ${run.status} (${run.invocationSource})`);
    }
  }
  lines.push("");

  if (Object.keys(runDiagnostics).length > 0) {
    lines.push("## Run Diagnostics");
    for (const [runId, diagnostics] of Object.entries(runDiagnostics)) {
      lines.push(`### ${runId}`);
      lines.push(`- Events: ${diagnostics.eventsTail.length}`);
      if (diagnostics.logTail) {
        lines.push("");
        lines.push("```text");
        lines.push(diagnostics.logTail);
        lines.push("```");
        lines.push("");
      }
    }
  }

  return `${lines.join("\n")}\n`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = args.baseUrl.replace(/\/$/, "");
  const auth = await loadAuth(baseUrl, args.authFile);
  const issueToken = extractIssueToken(args.issueRef!);
  const issue = await resolveIssue(baseUrl, auth.token, auth.companyId, issueToken);

  const [comments, documents, liveRuns, activeRun, activity, runs] = await Promise.all([
    api<ApiIssueComment[]>(baseUrl, auth.token, `/api/issues/${encodeURIComponent(issue.id)}/comments`) ?? [],
    api<ApiIssueDocument[]>(baseUrl, auth.token, `/api/issues/${encodeURIComponent(issue.id)}/documents`) ?? [],
    api<ApiLiveRun[]>(baseUrl, auth.token, `/api/issues/${encodeURIComponent(issue.id)}/live-runs`) ?? [],
    api<ApiActiveRun | null>(baseUrl, auth.token, `/api/issues/${encodeURIComponent(issue.id)}/active-run`) ?? null,
    api<ApiActivityEvent[]>(baseUrl, auth.token, `/api/issues/${encodeURIComponent(issue.id)}/activity`) ?? [],
    api<ApiRunForIssue[]>(baseUrl, auth.token, `/api/issues/${encodeURIComponent(issue.id)}/runs`) ?? [],
  ]);

  const executionDocument = documents.find((document) => document.key === "atlas-execution") ?? null;
  const parsedExecution = executionDocument ? parseExecutionDocument(executionDocument as never) : null;
  const context = buildIssueExecutionCommentContext({
    issue: {
      title: issue.title,
      description: issue.description ?? "",
    },
    comments: comments.map((comment) => ({
      id: comment.id,
      authorAgentId: comment.authorAgentId ?? null,
      authorUserId: comment.authorUserId ?? null,
      body: comment.body,
      createdAt: comment.createdAt,
    })),
    projectedTurnNumber: parsedExecution?.turnNumber ?? null,
  });

  const narrativeMessages = buildIssueNarrativeChatMessages({
    issue: {
      title: issue.title,
      description: issue.description ?? "",
      createdAt: issue.createdAt ?? null,
    } as never,
    comments: comments.map((comment) => ({
      id: comment.id,
      authorAgentId: comment.authorAgentId ?? null,
      authorUserId: comment.authorUserId ?? null,
      body: comment.body,
      createdAt: comment.createdAt,
    })),
    context,
  });

  const model = buildIssueConversationModel({
    context,
    liveRuns: liveRuns as never,
    transcriptByRun: new Map(),
    verbosity: "debug",
  });

  const diagnosticRunIds = Array.from(new Set([
    ...(activeRun ? [activeRun.id] : []),
    ...liveRuns.filter((run) => run.openable !== false && run.syntheticSource !== "atlas_execution").map((run) => run.id),
  ]));

  const runDiagnostics: Record<string, { eventsTail: HeartbeatRunEvent[]; logTail: string | null }> = {};
  for (const runId of diagnosticRunIds) {
    const [eventsTail, logResponse] = await Promise.all([
      api<HeartbeatRunEvent[]>(baseUrl, auth.token, `/api/heartbeat-runs/${encodeURIComponent(runId)}/events?limit=${encodeURIComponent(String(args.eventLimit))}`) ?? [],
      api<{ content: string }>(baseUrl, auth.token, `/api/heartbeat-runs/${encodeURIComponent(runId)}/log?limitBytes=${encodeURIComponent(String(args.logBytes))}`, undefined, true),
    ]);
    runDiagnostics[runId] = {
      eventsTail: (eventsTail ?? []).slice(-args.eventLimit),
      logTail: logResponse?.content ? tailText(logResponse.content, args.logBytes) : null,
    };
  }

  const anomalies = findAnomalies({
    issue,
    context,
    model,
    liveRuns,
    activeRun,
    parsedExecution,
    activity,
  });

  const generatedAt = new Date().toISOString();
  const issueDir = path.join(args.outputDir, issue.identifier ?? issue.id);
  await fs.mkdir(issueDir, { recursive: true });
  const stamp = generatedAt.replace(/[:.]/g, "-");

  const report = {
    generatedAt,
    baseUrl,
    issue: {
      id: issue.id,
      identifier: issue.identifier ?? null,
      title: issue.title,
      status: issue.status,
      priority: issue.priority ?? null,
      assigneeAgentId: issue.assigneeAgentId ?? null,
      executionRunId: issue.executionRunId ?? null,
      createdAt: ensureIso(issue.createdAt) ?? null,
      updatedAt: ensureIso(issue.updatedAt) ?? null,
    },
    apiTruth: {
      commentsCount: comments.length,
      documentsCount: documents.length,
      liveRuns,
      activeRun,
      activitySample: activity.slice(0, args.activityLimit),
      runsSample: runs.slice(0, args.activityLimit),
      parsedExecution,
    },
    derivedTruth: {
      context,
      narrativeMessages,
      conversationModel: model,
    },
    runDiagnostics,
    anomalies,
  };

  const jsonPath = path.join(issueDir, `${stamp}.json`);
  const mdPath = path.join(issueDir, `${stamp}.md`);
  await fs.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await fs.writeFile(mdPath, buildMarkdownReport({
    issue,
    context,
    model,
    parsedExecution,
    liveRuns,
    activeRun,
    anomalies,
    activity,
    runs,
    runDiagnostics,
  }), "utf8");

  console.log(JSON.stringify({
    issue: issue.identifier ?? issue.id,
    jsonPath,
    mdPath,
    anomalies: anomalies.map((anomaly) => `${anomaly.severity}:${anomaly.code}`),
    liveRuns: liveRuns.length,
    activeRun: activeRun?.id ?? null,
    pendingUserRequests: context.pendingUserRequests.length,
  }, null, 2));
}

await main();
