import { useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import { pickTextColorForPillBg } from "@/lib/color-contrast";
import { Link, useLocation, useNavigate, useParams } from "@/lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { issuesApi } from "../api/issues";
import { ApiError } from "../api/client";
import { activityApi, type RunForIssue } from "../api/activity";
import { heartbeatsApi } from "../api/heartbeats";
import { agentsApi } from "../api/agents";
import { authApi } from "../api/auth";
import { projectsApi } from "../api/projects";
import { useCompany } from "../context/CompanyContext";
import { usePanel } from "../context/PanelContext";
import { useToast } from "../context/ToastContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { assigneeValueFromSelection, suggestedCommentAssigneeValue } from "../lib/assignees";
import { queryKeys } from "../lib/queryKeys";
import { createIssueDetailPath, readIssueDetailBreadcrumb } from "../lib/issueDetailBreadcrumb";
import {
  applyOptimisticIssueCommentUpdate,
  createOptimisticIssueComment,
  isQueuedIssueComment,
  mergeIssueComments,
  upsertIssueComment,
  type IssueCommentReassignment,
  type OptimisticIssueComment,
} from "../lib/optimistic-issue-comments";
import { useProjectOrder } from "../hooks/useProjectOrder";
import { relativeTime, cn, formatTokens, visibleRunCostUsd } from "../lib/utils";
import { InlineEditor } from "../components/InlineEditor";
import { CommentThread } from "../components/CommentThread";
import { IssueExecutionHeader } from "../components/IssueExecutionHeader";
import { IssueDocumentsSection } from "../components/IssueDocumentsSection";
import { IssueProperties } from "../components/IssueProperties";
import { IssueWorkspaceCard } from "../components/IssueWorkspaceCard";
import { IssueLiveSessionPanel } from "../components/IssueLiveSessionPanel";
import { IssueConversationComposer } from "../components/issue-conversation/IssueConversationComposer";
import { IssueConversationSurface } from "../components/issue-conversation/IssueConversationSurface";
import { buildIssueExecutionHeaderModel, buildPendingAtlasFollowupStatus, parseExecutionDocument } from "../lib/issue-execution-flow";
import { useIssueChatLiveTransport } from "../hooks/useIssueChatLiveTransport";
import { buildIssueExecutionCommentContext, buildIssueNarrativeChatMessages } from "../lib/issue-execution-turns";
import type { IssueConversationVerbosity } from "../lib/issue-conversation-model";
import { filterIssueTimelineRuns } from "../lib/issue-run-history";
import type { MentionOption } from "../components/MarkdownEditor";
import { ScrollToBottom } from "../components/ScrollToBottom";
import { StatusIcon } from "../components/StatusIcon";
import { PriorityIcon } from "../components/PriorityIcon";
import { StatusBadge } from "../components/StatusBadge";
import { Identity } from "../components/Identity";
import { PluginSlotMount, PluginSlotOutlet, usePluginSlots } from "@/plugins/slots";
import { PluginLauncherOutlet } from "@/plugins/launchers";
import { Separator } from "@/components/ui/separator";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Activity as ActivityIcon,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  EyeOff,
  Hexagon,
  ListTree,
  MessageSquare,
  MoreHorizontal,
  PanelsTopLeft,
  Paperclip,
  Repeat,
  SlidersHorizontal,
  Trash2,
} from "lucide-react";
import type { ActivityEvent } from "@paperclipai/shared";
import type { Agent, Issue, IssueAttachment, IssueComment } from "@paperclipai/shared";

type CommentReassignment = IssueCommentReassignment;
type IssueDetailComment = (IssueComment | OptimisticIssueComment) & {
  runId?: string | null;
  runAgentId?: string | null;
  interruptedRunId?: string | null;
  queueState?: "queued";
  queueTargetRunId?: string | null;
};

type PendingAtlasFollowup = {
  submittedAt: string;
  baseTurnNumber: number | null;
  commentId: string | null;
  dispatchStatus: "accepted" | "blocked";
  detail: string | null;
  turnNumber: number | null;
  turnLabel: string | null;
  requestType: "followup" | "merge_request" | "directed_agent" | null;
};

function isSyntheticAtlasRun(run: { syntheticSource?: string | null } | null | undefined): boolean {
  return run?.syntheticSource === "atlas_execution";
}

const ACTION_LABELS: Record<string, string> = {
  "issue.created": "created the issue",
  "issue.updated": "updated the issue",
  "issue.checked_out": "checked out the issue",
  "issue.released": "released the issue",
  "issue.comment_added": "added a comment",
  "issue.attachment_added": "added an attachment",
  "issue.attachment_removed": "removed an attachment",
  "issue.document_created": "created a document",
  "issue.document_updated": "updated a document",
  "issue.document_deleted": "deleted a document",
  "issue.deleted": "deleted the issue",
  "agent.created": "created an agent",
  "agent.updated": "updated the agent",
  "agent.paused": "paused the agent",
  "agent.resumed": "resumed the agent",
  "agent.terminated": "terminated the agent",
  "heartbeat.invoked": "invoked a heartbeat",
  "heartbeat.cancelled": "cancelled a heartbeat",
  "approval.created": "requested approval",
  "approval.approved": "approved",
  "approval.rejected": "rejected",
};

function humanizeValue(value: unknown): string {
  if (typeof value !== "string") return String(value ?? "none");
  return value.replace(/_/g, " ");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function usageNumber(usage: Record<string, unknown> | null, ...keys: string[]) {
  if (!usage) return 0;
  for (const key of keys) {
    const value = usage[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return 0;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "\u2026";
}

function isMarkdownFile(file: File) {
  const name = file.name.toLowerCase();
  return (
    name.endsWith(".md") ||
    name.endsWith(".markdown") ||
    file.type === "text/markdown"
  );
}

function fileBaseName(filename: string) {
  return filename.replace(/\.[^.]+$/, "");
}

function slugifyDocumentKey(input: string) {
  const slug = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "document";
}

function titleizeFilename(input: string) {
  return input
    .split(/[-_ ]+/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatAction(action: string, details?: Record<string, unknown> | null): string {
  if (action === "issue.updated" && details) {
    const previous = (details._previous ?? {}) as Record<string, unknown>;
    const parts: string[] = [];

    if (details.status !== undefined) {
      const from = previous.status;
      parts.push(
        from
          ? `changed the status from ${humanizeValue(from)} to ${humanizeValue(details.status)}`
          : `changed the status to ${humanizeValue(details.status)}`
      );
    }
    if (details.priority !== undefined) {
      const from = previous.priority;
      parts.push(
        from
          ? `changed the priority from ${humanizeValue(from)} to ${humanizeValue(details.priority)}`
          : `changed the priority to ${humanizeValue(details.priority)}`
      );
    }
    if (details.assigneeAgentId !== undefined || details.assigneeUserId !== undefined) {
      parts.push(
        details.assigneeAgentId || details.assigneeUserId
          ? "assigned the issue"
          : "unassigned the issue",
      );
    }
    if (details.title !== undefined) parts.push("updated the title");
    if (details.description !== undefined) parts.push("updated the description");

    if (parts.length > 0) return parts.join(", ");
  }
  if (
    (action === "issue.document_created" || action === "issue.document_updated" || action === "issue.document_deleted") &&
    details
  ) {
    const key = typeof details.key === "string" ? details.key : "document";
    const title = typeof details.title === "string" && details.title ? ` (${details.title})` : "";
    return `${ACTION_LABELS[action] ?? action} ${key}${title}`;
  }
  return ACTION_LABELS[action] ?? action.replace(/[._]/g, " ");
}

function ActorIdentity({ evt, agentMap }: { evt: ActivityEvent; agentMap: Map<string, Agent> }) {
  const id = evt.actorId;
  if (evt.actorType === "agent") {
    const agent = agentMap.get(id);
    return <Identity name={agent?.name ?? id.slice(0, 8)} size="sm" />;
  }
  if (evt.actorType === "system") return <Identity name="System" size="sm" />;
  if (evt.actorType === "user") return <Identity name="Board" size="sm" />;
  return <Identity name={id || "Unknown"} size="sm" />;
}

function formatClockTime(value: string | Date | null | undefined) {
  if (!value) return "—";
  return new Date(value).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatFullTimeTitle(value: string | Date | null | undefined) {
  if (!value) return "";
  return new Date(value).toLocaleString();
}

function normalizeHistoryText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function extractRunSummary(run: RunForIssue) {
  const result = asRecord(run.resultJson);
  const summary = normalizeHistoryText(result?.summary) ?? normalizeHistoryText(result?.result);
  if (summary) return truncate(summary, 220);
  const usage = asRecord(run.usageJson);
  const totalTokens =
    usageNumber(usage, "inputTokens", "input_tokens")
    + usageNumber(usage, "outputTokens", "output_tokens")
    + usageNumber(usage, "cachedInputTokens", "cached_input_tokens", "cache_read_input_tokens");
  if (totalTokens > 0) return `Tokens ${formatTokens(totalTokens)}`;
  return null;
}

function HistoryRunRow({
  run,
  agentName,
}: {
  run: RunForIssue;
  agentName: string;
}) {
  const startAt = run.startedAt ?? run.createdAt;
  const endAt = run.finishedAt;
  const summary = extractRunSummary(run);
  const invocationSource =
    typeof run.invocationSource === "string" && run.invocationSource.trim()
      ? run.invocationSource.replaceAll("_", " ")
      : null;

  return (
    <div className="rounded-2xl border border-border bg-card px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <Identity name={agentName} size="sm" />
        <StatusBadge status={run.status} />
        <Link
          to={`/agents/${run.agentId}/runs/${run.runId}`}
          className="font-mono text-xs text-muted-foreground hover:text-foreground hover:underline"
        >
          {run.runId.slice(0, 8)}
        </Link>
        <span className="ml-auto text-xs text-muted-foreground" title={formatFullTimeTitle(startAt)}>
          {formatClockTime(startAt)}
          {endAt ? ` → ${formatClockTime(endAt)}` : ""}
        </span>
      </div>
      {invocationSource || summary ? (
        <div className="mt-2 flex flex-wrap gap-2 text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
          {invocationSource ? <span>{invocationSource}</span> : null}
          {summary ? <span className="normal-case tracking-normal text-xs text-foreground/80">{summary}</span> : null}
        </div>
      ) : null}
    </div>
  );
}

export function IssueDetail() {
  const { issueId } = useParams<{ issueId: string }>();
  const { selectedCompanyId } = useCompany();
  const { openPanel, closePanel, panelVisible, setPanelVisible } = usePanel();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const { pushToast } = useToast();
  const [moreOpen, setMoreOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [mobilePropsOpen, setMobilePropsOpen] = useState(false);
  const [surfaceTab, setSurfaceTab] = useState("chat");
  const [dashboardTab, setDashboardTab] = useState("overview");
  const [historyTab, setHistoryTab] = useState("runs");
  const [conversationVerbosity, setConversationVerbosity] = useState<IssueConversationVerbosity>("auto");
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [attachmentDragActive, setAttachmentDragActive] = useState(false);
  const [optimisticComments, setOptimisticComments] = useState<OptimisticIssueComment[]>([]);
  const [pendingAtlasFollowup, setPendingAtlasFollowup] = useState<PendingAtlasFollowup | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const lastMarkedReadIssueIdRef = useRef<string | null>(null);

  const { data: issue, isLoading, error } = useQuery({
    queryKey: queryKeys.issues.detail(issueId!),
    queryFn: () => issuesApi.get(issueId!),
    enabled: !!issueId,
  });
  const resolvedCompanyId = issue?.companyId ?? selectedCompanyId;

  const { data: comments } = useQuery({
    queryKey: queryKeys.issues.comments(issueId!),
    queryFn: () => issuesApi.listComments(issueId!),
    enabled: !!issueId,
  });

  const { data: activity } = useQuery({
    queryKey: queryKeys.issues.activity(issueId!),
    queryFn: () => activityApi.forIssue(issueId!),
    enabled: !!issueId,
  });

  const { data: linkedRuns } = useQuery({
    queryKey: queryKeys.issues.runs(issueId!),
    queryFn: () => activityApi.runsForIssue(issueId!),
    enabled: !!issueId,
    refetchInterval: 5000,
  });

  const { data: linkedApprovals } = useQuery({
    queryKey: queryKeys.issues.approvals(issueId!),
    queryFn: () => issuesApi.listApprovals(issueId!),
    enabled: !!issueId,
  });

  const { data: attachments } = useQuery({
    queryKey: queryKeys.issues.attachments(issueId!),
    queryFn: () => issuesApi.listAttachments(issueId!),
    enabled: !!issueId,
  });

  const { data: liveRuns } = useQuery({
    queryKey: queryKeys.issues.liveRuns(issueId!),
    queryFn: () => heartbeatsApi.liveRunsForIssue(issueId!),
    enabled: !!issueId,
    refetchInterval: 3000,
  });

  const { data: activeRun } = useQuery({
    queryKey: queryKeys.issues.activeRun(issueId!),
    queryFn: () => heartbeatsApi.activeRunForIssue(issueId!),
    enabled: !!issueId,
    refetchInterval: 3000,
  });

  const hasLiveRuns = (liveRuns ?? []).length > 0 || !!activeRun;
  const { data: executionDocument } = useQuery({
    queryKey: [...queryKeys.issues.documents(issueId!), "atlas-execution", "detail"],
    queryFn: async () => {
      try {
        return await issuesApi.getDocument(issueId!, "atlas-execution");
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
    enabled: !!issueId,
    retry: false,
    refetchInterval: hasLiveRuns || pendingAtlasFollowup ? 3000 : false,
  });
  const parsedExecutionDocument = useMemo(
    () => parseExecutionDocument(executionDocument),
    [executionDocument],
  );
  const executionCommentContext = useMemo(() => {
    if (!issue) return null;
    return buildIssueExecutionCommentContext({
      issue,
      comments: comments ?? [],
      projectedTurnNumber: parsedExecutionDocument.turnNumber,
    });
  }, [comments, issue, parsedExecutionDocument.turnNumber]);
  const atlasExecutionPanelModel = useMemo(() => {
    return {
      ...parsedExecutionDocument,
      latestRequest: executionCommentContext?.latestExecutedTurn?.request ?? null,
      pendingRequests: executionCommentContext?.pendingUserRequests ?? [],
      turnHistory: executionCommentContext?.turns.map((turn) => ({
        sequence: turn.sequence,
        request: turn.request,
        status: turn.status,
        verifierScope: turn.verifierScope,
        outcome: turn.outcome,
        startedAt: turn.startedAt,
        settledAt: turn.settledAt,
      })) ?? [],
      projectionWarning: executionCommentContext?.projectionWarning ?? null,
    };
  }, [executionCommentContext, parsedExecutionDocument]);
  const atlasNarrativeChatMessages = useMemo(() => {
    if (!issue) return [];
    return buildIssueNarrativeChatMessages({
      issue,
      comments: comments ?? [],
      context: executionCommentContext,
    });
  }, [comments, executionCommentContext, issue]);
  const runningIssueRun = useMemo(
    () => (
      activeRun?.status === "running"
        ? activeRun
        : (liveRuns ?? []).find((run) => run.status === "running" && !isSyntheticAtlasRun(run)) ?? null
    ),
    [activeRun, liveRuns],
  );
  const sourceBreadcrumb = useMemo(
    () => readIssueDetailBreadcrumb(location.state, location.search) ?? { label: "Issues", href: "/issues" },
    [location.state, location.search],
  );

  const { data: allIssues } = useQuery({
    queryKey: queryKeys.issues.list(selectedCompanyId!),
    queryFn: () => issuesApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });

  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId!),
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const currentUserId = session?.user?.id ?? session?.session?.userId ?? null;
  const { orderedProjects } = useProjectOrder({
    projects: projects ?? [],
    companyId: selectedCompanyId,
    userId: currentUserId,
  });
  const { slots: issuePluginDetailSlots } = usePluginSlots({
    slotTypes: ["detailTab"],
    entityType: "issue",
    companyId: resolvedCompanyId,
    enabled: !!resolvedCompanyId,
  });
  const issuePluginTabItems = useMemo(
    () => issuePluginDetailSlots.map((slot) => ({
      value: `plugin:${slot.pluginKey}:${slot.id}`,
      label: slot.displayName,
      slot,
    })),
    [issuePluginDetailSlots],
  );
  const activePluginTab = issuePluginTabItems.find((item) => item.value === dashboardTab) ?? null;

  const agentMap = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const a of agents ?? []) map.set(a.id, a);
    return map;
  }, [agents]);

  // Filter out runs already shown by the live widget to avoid duplication
  const timelineRuns = useMemo(() => {
    const liveIds = new Set<string>();
    for (const r of liveRuns ?? []) liveIds.add(r.id);
    if (activeRun) liveIds.add(activeRun.id);
    const historicalRuns = liveIds.size === 0
      ? linkedRuns ?? []
      : (linkedRuns ?? []).filter((r) => !liveIds.has(r.runId));
    return filterIssueTimelineRuns(historicalRuns, agents ?? []);
  }, [linkedRuns, liveRuns, activeRun, agents]);

  const mentionOptions = useMemo<MentionOption[]>(() => {
    const options: MentionOption[] = [];
    const activeAgents = [...(agents ?? [])]
      .filter((agent) => agent.status !== "terminated")
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const agent of activeAgents) {
      options.push({
        id: `agent:${agent.id}`,
        name: agent.name,
        kind: "agent",
        agentId: agent.id,
        agentIcon: agent.icon,
      });
    }
    for (const project of orderedProjects) {
      options.push({
        id: `project:${project.id}`,
        name: project.name,
        kind: "project",
        projectId: project.id,
        projectColor: project.color,
      });
    }
    return options;
  }, [agents, orderedProjects]);

  const childIssues = useMemo(() => {
    if (!allIssues || !issue) return [];
    return allIssues
      .filter((i) => i.parentId === issue.id)
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  }, [allIssues, issue]);

  const commentReassignOptions = useMemo(() => {
    const options: Array<{ id: string; label: string; searchText?: string }> = [];
    const activeAgents = [...(agents ?? [])]
      .filter((agent) => agent.status !== "terminated")
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const agent of activeAgents) {
      options.push({ id: `agent:${agent.id}`, label: agent.name });
    }
    if (currentUserId) {
      options.push({ id: `user:${currentUserId}`, label: "Me" });
    }
    return options;
  }, [agents, currentUserId]);

  const actualAssigneeValue = useMemo(
    () => assigneeValueFromSelection(issue ?? {}),
    [issue],
  );

  const suggestedAssigneeValue = useMemo(
    () =>
      suggestedCommentAssigneeValue(
        issue ?? {},
        mergeIssueComments(comments ?? [], optimisticComments),
        currentUserId,
      ),
    [issue, comments, optimisticComments, currentUserId],
  );

  const threadComments = useMemo(
    () => mergeIssueComments(comments ?? [], optimisticComments),
    [comments, optimisticComments],
  );

  const commentsWithRunMeta = useMemo<IssueDetailComment[]>(() => {
    const activeRunStartedAt = runningIssueRun?.startedAt ?? runningIssueRun?.createdAt ?? null;
    const runMetaByCommentId = new Map<string, { runId: string; runAgentId: string | null; interruptedRunId: string | null }>();
    const agentIdByRunId = new Map<string, string>();
    for (const run of linkedRuns ?? []) {
      agentIdByRunId.set(run.runId, run.agentId);
    }
    for (const evt of activity ?? []) {
      if (evt.action !== "issue.comment_added" || !evt.runId) continue;
      const details = evt.details ?? {};
      const commentId = typeof details["commentId"] === "string" ? details["commentId"] : null;
      if (!commentId || runMetaByCommentId.has(commentId)) continue;
      const interruptedRunId =
        typeof details["interruptedRunId"] === "string" ? details["interruptedRunId"] : null;
      runMetaByCommentId.set(commentId, {
        runId: evt.runId,
        runAgentId: evt.agentId ?? agentIdByRunId.get(evt.runId) ?? null,
        interruptedRunId,
      });
    }
    return threadComments.map((comment) => {
      const meta = runMetaByCommentId.get(comment.id);
      const nextComment: IssueDetailComment = meta ? { ...comment, ...meta } : { ...comment };
      if (
        isQueuedIssueComment({
          comment: nextComment,
          activeRunStartedAt,
          runId: meta?.runId ?? nextComment.runId ?? null,
          interruptedRunId: meta?.interruptedRunId ?? nextComment.interruptedRunId ?? null,
        })
      ) {
        return {
          ...nextComment,
          queueState: "queued" as const,
          queueTargetRunId: runningIssueRun?.id ?? nextComment.queueTargetRunId ?? null,
        };
      }
      return nextComment;
    });
  }, [activity, threadComments, linkedRuns, runningIssueRun]);

  const queuedComments = useMemo(
    () => commentsWithRunMeta.filter((comment) => comment.queueState === "queued"),
    [commentsWithRunMeta],
  );

  const timelineComments = useMemo(
    () => commentsWithRunMeta.filter((comment) => comment.queueState !== "queued"),
    [commentsWithRunMeta],
  );

  const compactRunStatusGroups = useMemo(() => {
    const counts = new Map<string, number>();
    for (const run of timelineRuns) {
      counts.set(run.status, (counts.get(run.status) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([label, count]) => ({ label: humanizeValue(label), count }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  }, [timelineRuns]);

  const issueCostSummary = useMemo(() => {
    let input = 0;
    let output = 0;
    let cached = 0;
    let cost = 0;
    let hasCost = false;
    let hasTokens = false;

    for (const run of linkedRuns ?? []) {
      const usage = asRecord(run.usageJson);
      const result = asRecord(run.resultJson);
      const runInput = usageNumber(usage, "inputTokens", "input_tokens");
      const runOutput = usageNumber(usage, "outputTokens", "output_tokens");
      const runCached = usageNumber(
        usage,
        "cachedInputTokens",
        "cached_input_tokens",
        "cache_read_input_tokens",
      );
      const runCost = visibleRunCostUsd(usage, result);
      if (runCost > 0) hasCost = true;
      if (runInput + runOutput + runCached > 0) hasTokens = true;
      input += runInput;
      output += runOutput;
      cached += runCached;
      cost += runCost;
    }

    return {
      input,
      output,
      cached,
      cost,
      totalTokens: input + output,
      hasCost,
      hasTokens,
    };
  }, [linkedRuns]);

  const executionHeaderModel = useMemo(() => {
    if (!issue) return null;
    const baseModel = buildIssueExecutionHeaderModel({
      issue,
      executionDocument,
      linkedRuns: linkedRuns ?? [],
      liveRuns: liveRuns ?? [],
      activeRun,
      activity: activity ?? [],
      agents: agents ?? [],
    });
    const latestExecutedTurn = executionCommentContext?.latestExecutedTurn ?? null;
    const latestRequest = latestExecutedTurn?.request ?? null;
    const pendingRequests = executionCommentContext?.pendingUserRequests ?? [];
    const summaryParts = [
      latestRequest ? `Последний исполненный запрос: «${latestRequest}».` : null,
      baseModel.summary,
      pendingRequests.length > 0
        ? `После этого появились новые user comments (${pendingRequests.length}), поэтому текущая projection уже не отвечает на самый свежий запрос.`
        : null,
    ].filter(Boolean);
    return {
      ...baseModel,
      requestedChange: latestRequest,
      summary: summaryParts.join(" "),
      turnLabel: latestExecutedTurn ? `Turn ${latestExecutedTurn.sequence}` : baseModel.turnLabel,
      flowStatus: executionCommentContext?.projectionWarning ? "Projection stale" : baseModel.flowStatus,
      flowSeverity: executionCommentContext?.projectionWarning ? "warning" : baseModel.flowSeverity,
      mismatchText: executionCommentContext?.projectionWarning ?? baseModel.mismatchText,
    };
  }, [issue, executionDocument, linkedRuns, liveRuns, activeRun, activity, agents, executionCommentContext]);
  const issueChatLiveTransport = useIssueChatLiveTransport({
    companyId: issue?.companyId ?? null,
    issue: issue ? { id: issue.id, identifier: issue.identifier } : null,
    agents: agents ?? null,
  });
  const effectivePendingComposerStatus = useMemo(() => {
    if (!pendingAtlasFollowup) return null;
    return buildPendingAtlasFollowupStatus({
      pendingSince: pendingAtlasFollowup.submittedAt,
      baseTurnNumber: pendingAtlasFollowup.baseTurnNumber,
      parsed: parsedExecutionDocument,
      dispatch: {
        status: pendingAtlasFollowup.dispatchStatus,
        requestType: pendingAtlasFollowup.requestType,
        detail: pendingAtlasFollowup.detail,
        turnNumber: pendingAtlasFollowup.turnNumber,
        turnLabel: pendingAtlasFollowup.turnLabel,
      },
      live: issueChatLiveTransport.signal
        ? {
          state: issueChatLiveTransport.signal.state,
          title: issueChatLiveTransport.signal.title,
          summary: issueChatLiveTransport.signal.summary,
          detail: issueChatLiveTransport.signal.detail,
          turnLabel: issueChatLiveTransport.signal.turnLabel,
        }
        : null,
    });
  }, [issueChatLiveTransport.signal, parsedExecutionDocument, pendingAtlasFollowup]);
  const pendingComposerStatusCard = effectivePendingComposerStatus ? (
    <div
      className={cn(
        "rounded-lg border px-3 py-2 text-xs",
        effectivePendingComposerStatus.state === "failed" || effectivePendingComposerStatus.state === "blocked"
          ? "border-red-500/30 bg-red-500/[0.06] text-red-900 dark:text-red-100"
          : effectivePendingComposerStatus.state === "completed"
            ? "border-emerald-500/30 bg-emerald-500/[0.06] text-emerald-900 dark:text-emerald-100"
            : effectivePendingComposerStatus.state === "running"
              || effectivePendingComposerStatus.state === "accepted"
              || effectivePendingComposerStatus.state === "queued"
              ? "border-cyan-500/30 bg-cyan-500/[0.06] text-cyan-900 dark:text-cyan-100"
              : "border-amber-500/30 bg-amber-500/[0.06] text-amber-900 dark:text-amber-100"
      )}
    >
      <div className="font-medium">{effectivePendingComposerStatus.title}</div>
      <div className="mt-1 opacity-90">{effectivePendingComposerStatus.summary}</div>
      {effectivePendingComposerStatus.detail ? (
        <div className="mt-1 opacity-75">{effectivePendingComposerStatus.detail}</div>
      ) : null}
    </div>
  ) : null;

  const invalidateIssue = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(issueId!) });
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.activity(issueId!) });
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.runs(issueId!) });
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.approvals(issueId!) });
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.attachments(issueId!) });
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.documents(issueId!) });
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.liveRuns(issueId!) });
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.activeRun(issueId!) });
    if (selectedCompanyId) {
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(selectedCompanyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.listMineByMe(selectedCompanyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.listTouchedByMe(selectedCompanyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.listUnreadTouchedByMe(selectedCompanyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.sidebarBadges(selectedCompanyId) });
    }
  };

  const markIssueRead = useMutation({
    mutationFn: (id: string) => issuesApi.markRead(id),
    onSuccess: () => {
      if (selectedCompanyId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.listMineByMe(selectedCompanyId) });
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.listTouchedByMe(selectedCompanyId) });
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.listUnreadTouchedByMe(selectedCompanyId) });
        queryClient.invalidateQueries({ queryKey: queryKeys.sidebarBadges(selectedCompanyId) });
      }
    },
  });

  const updateIssue = useMutation({
    mutationFn: (data: Record<string, unknown>) => issuesApi.update(issueId!, data),
    onSuccess: () => {
      invalidateIssue();
    },
  });

  const addComment = useMutation({
    mutationFn: ({
      body,
      reopen,
      interrupt,
      commentTargetAgentId,
    }: {
      body: string;
      reopen?: boolean;
      interrupt?: boolean;
      commentTargetAgentId?: string | null;
    }) => issuesApi.addComment(issueId!, body, reopen, interrupt, commentTargetAgentId),
    onMutate: async ({ body, reopen, interrupt }) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.issues.comments(issueId!) });
      await queryClient.cancelQueries({ queryKey: queryKeys.issues.detail(issueId!) });

      const previousIssue = queryClient.getQueryData<Issue>(queryKeys.issues.detail(issueId!));
      const queuedComment = !interrupt && runningIssueRun;
      const optimisticComment = issue
        ? createOptimisticIssueComment({
            companyId: issue.companyId,
            issueId: issue.id,
            body,
            authorUserId: currentUserId,
            clientStatus: queuedComment ? "queued" : "pending",
            queueTargetRunId: queuedComment ? runningIssueRun.id : null,
          })
        : null;

      if (optimisticComment) {
        setOptimisticComments((current) => [...current, optimisticComment]);
      }
      if (previousIssue) {
        queryClient.setQueryData(
          queryKeys.issues.detail(issueId!),
          applyOptimisticIssueCommentUpdate(previousIssue, { reopen }),
        );
      }

      return {
        optimisticCommentId: optimisticComment?.clientId ?? null,
        previousIssue,
      };
    },
    onSuccess: (response, _variables, context) => {
      if (context?.optimisticCommentId) {
        setOptimisticComments((current) =>
          current.filter((entry) => entry.clientId !== context.optimisticCommentId),
        );
      }
      if (response.comment) {
        queryClient.setQueryData<IssueComment[]>(
          queryKeys.issues.comments(issueId!),
          (current) => upsertIssueComment(current, response.comment!),
        );
      }
      if (response.id) {
        queryClient.setQueryData<Issue>(queryKeys.issues.detail(issueId!), response);
      }
      const atlasFollowup = response.atlasFollowup;
      if (atlasFollowup?.status === "blocked") {
        setPendingAtlasFollowup({
          submittedAt: new Date().toISOString(),
          baseTurnNumber: parsedExecutionDocument.turnNumber,
          commentId: response.comment?.id ?? null,
          dispatchStatus: "blocked",
          detail: atlasFollowup.detail,
          turnNumber: atlasFollowup.turnNumber,
          turnLabel: atlasFollowup.turnLabel,
          requestType: atlasFollowup.requestType,
        });
        const blockedTitle =
          atlasFollowup.requestType === "directed_agent"
            ? "Blocked"
            : atlasFollowup.requestType === "merge_request"
              ? "MR blocked"
              : "Blocked";
        const blockedBody =
          atlasFollowup.detail
          ?? (atlasFollowup.requestType === "directed_agent"
            ? "Agent did not accept the message."
            : atlasFollowup.requestType === "merge_request"
              ? "MR request was not accepted."
              : "Atlas did not accept the follow-up.");
        pushToast({
          title: blockedTitle,
          body: blockedBody,
          tone: "warn",
        });
      } else if (atlasFollowup?.status === "accepted") {
        const submittedAt = new Date().toISOString();
        if (atlasFollowup.requestType === "followup") {
          const atlasExecutorAgent = (agents ?? []).find((agent) => {
            const candidate = `${agent.urlKey ?? ""} ${agent.name ?? ""} ${agent.role ?? ""}`.toLowerCase();
            return candidate.includes("atlas-executor") || candidate.includes("atlas executor");
          });
          queryClient.setQueryData(
            queryKeys.issues.liveRuns(issueId!),
            (current: import("../api/heartbeats").LiveRunForIssue[] | undefined) => {
              const next = (current ?? []).filter((run) => !isSyntheticAtlasRun(run));
              next.unshift({
                id: `atlas-followup:${response.comment?.id ?? submittedAt}`,
                status: "queued",
                invocationSource: "atlas_execution",
                triggerDetail: parsedExecutionDocument.turnLabel
                  ? `Follow-up after ${parsedExecutionDocument.turnLabel}`
                  : "Atlas follow-up",
                startedAt: submittedAt,
                finishedAt: null,
                createdAt: submittedAt,
                agentId: atlasExecutorAgent?.id ?? issue?.assigneeAgentId ?? "atlas-executor",
                agentName: atlasExecutorAgent?.name ?? "Atlas Executor",
                adapterType: atlasExecutorAgent?.adapterType ?? "atlas_execution",
                issueId: issueId!,
                syntheticSource: "atlas_execution",
                openable: false,
              });
              return next;
            },
          );
          queryClient.invalidateQueries({ queryKey: queryKeys.issues.liveRuns(issueId!) });
        }
        setPendingAtlasFollowup({
          submittedAt,
          baseTurnNumber: atlasFollowup?.turnNumber ?? parsedExecutionDocument.turnNumber,
          commentId: response.comment?.id ?? null,
          dispatchStatus: "accepted",
          detail: atlasFollowup?.detail ?? null,
          turnNumber: atlasFollowup?.turnNumber ?? null,
          turnLabel: atlasFollowup?.turnLabel ?? null,
          requestType: atlasFollowup?.requestType ?? "followup",
        });
      } else {
        setPendingAtlasFollowup(null);
      }
    },
    onError: (err, _variables, context) => {
      if (context?.optimisticCommentId) {
        setOptimisticComments((current) =>
          current.filter((entry) => entry.clientId !== context.optimisticCommentId),
        );
      }
      if (context?.previousIssue) {
        queryClient.setQueryData(queryKeys.issues.detail(issueId!), context.previousIssue);
      }
      pushToast({
        title: "Comment failed",
        body: err instanceof Error ? err.message : "Unable to post comment",
        tone: "error",
      });
    },
    onSettled: () => {
      invalidateIssue();
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.comments(issueId!) });
    },
  });

  const addCommentAndReassign = useMutation({
    mutationFn: ({
      body,
      reopen,
      interrupt,
      reassignment,
      commentTargetAgentId,
    }: {
      body: string;
      reopen?: boolean;
      interrupt?: boolean;
      reassignment: CommentReassignment;
      commentTargetAgentId?: string | null;
    }) =>
      issuesApi.update(issueId!, {
        comment: body,
        ...(commentTargetAgentId ? { commentTargetAgentId } : {}),
        assigneeAgentId: reassignment.assigneeAgentId,
        assigneeUserId: reassignment.assigneeUserId,
        ...(reopen ? { status: "todo" } : {}),
        ...(interrupt ? { interrupt } : {}),
      }),
    onMutate: async ({ body, reopen, reassignment, interrupt }) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.issues.comments(issueId!) });
      await queryClient.cancelQueries({ queryKey: queryKeys.issues.detail(issueId!) });

      const previousIssue = queryClient.getQueryData<Issue>(queryKeys.issues.detail(issueId!));
      const queuedComment = !interrupt && runningIssueRun;
      const optimisticComment = issue
        ? createOptimisticIssueComment({
            companyId: issue.companyId,
            issueId: issue.id,
            body,
            authorUserId: currentUserId,
            clientStatus: queuedComment ? "queued" : "pending",
            queueTargetRunId: queuedComment ? runningIssueRun.id : null,
          })
        : null;

      if (optimisticComment) {
        setOptimisticComments((current) => [...current, optimisticComment]);
      }
      if (previousIssue) {
        queryClient.setQueryData(
          queryKeys.issues.detail(issueId!),
          applyOptimisticIssueCommentUpdate(previousIssue, { reopen, reassignment }),
        );
      }

      return {
        optimisticCommentId: optimisticComment?.clientId ?? null,
        previousIssue,
      };
    },
    onSuccess: (result, _variables, context) => {
      if (context?.optimisticCommentId) {
        setOptimisticComments((current) =>
          current.filter((entry) => entry.clientId !== context.optimisticCommentId),
        );
      }

      const { comment, ...nextIssue } = result;
      queryClient.setQueryData(queryKeys.issues.detail(issueId!), nextIssue);
      if (comment) {
        queryClient.setQueryData<IssueComment[]>(
          queryKeys.issues.comments(issueId!),
          (current) => upsertIssueComment(current, comment),
        );
      }
      setPendingAtlasFollowup(null);
    },
    onError: (err, _variables, context) => {
      if (context?.optimisticCommentId) {
        setOptimisticComments((current) =>
          current.filter((entry) => entry.clientId !== context.optimisticCommentId),
        );
      }
      if (context?.previousIssue) {
        queryClient.setQueryData(queryKeys.issues.detail(issueId!), context.previousIssue);
      }
      pushToast({
        title: "Comment failed",
        body: err instanceof Error ? err.message : "Unable to post comment",
        tone: "error",
      });
    },
    onSettled: () => {
      invalidateIssue();
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.comments(issueId!) });
    },
  });

  const interruptQueuedComment = useMutation({
    mutationFn: (runId: string) => heartbeatsApi.cancel(runId),
    onSuccess: () => {
      invalidateIssue();
      pushToast({
        title: "Interrupt requested",
        body: "The active run is stopping so queued comments can continue next.",
        tone: "success",
      });
    },
    onError: (err) => {
      pushToast({
        title: "Interrupt failed",
        body: err instanceof Error ? err.message : "Unable to interrupt the active run",
        tone: "error",
      });
    },
  });

  const uploadAttachment = useMutation({
    mutationFn: async (file: File) => {
      if (!selectedCompanyId) throw new Error("No company selected");
      return issuesApi.uploadAttachment(selectedCompanyId, issueId!, file);
    },
    onSuccess: () => {
      setAttachmentError(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.attachments(issueId!) });
      invalidateIssue();
    },
    onError: (err) => {
      setAttachmentError(err instanceof Error ? err.message : "Upload failed");
    },
  });

  const importMarkdownDocument = useMutation({
    mutationFn: async (file: File) => {
      const baseName = fileBaseName(file.name);
      const key = slugifyDocumentKey(baseName);
      const existing = (issue?.documentSummaries ?? []).find((doc) => doc.key === key) ?? null;
      const body = await file.text();
      const inferredTitle = titleizeFilename(baseName);
      const nextTitle = existing?.title ?? inferredTitle ?? null;
      return issuesApi.upsertDocument(issueId!, key, {
        title: key === "plan" ? null : nextTitle,
        format: "markdown",
        body,
        baseRevisionId: existing?.latestRevisionId ?? null,
      });
    },
    onSuccess: () => {
      setAttachmentError(null);
      invalidateIssue();
    },
    onError: (err) => {
      setAttachmentError(err instanceof Error ? err.message : "Document import failed");
    },
  });

  const deleteAttachment = useMutation({
    mutationFn: (attachmentId: string) => issuesApi.deleteAttachment(attachmentId),
    onSuccess: () => {
      setAttachmentError(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.attachments(issueId!) });
      invalidateIssue();
    },
    onError: (err) => {
      setAttachmentError(err instanceof Error ? err.message : "Delete failed");
    },
  });

  useEffect(() => {
    const titleLabel = issue?.title ?? issueId ?? "Issue";
    setBreadcrumbs([
      sourceBreadcrumb,
      { label: hasLiveRuns ? `🔵 ${titleLabel}` : titleLabel },
    ]);
  }, [setBreadcrumbs, sourceBreadcrumb, issue, issueId, hasLiveRuns]);

  // Redirect to identifier-based URL if navigated via UUID
  useEffect(() => {
    if (issue?.identifier && issueId !== issue.identifier) {
      navigate(createIssueDetailPath(issue.identifier, location.state, location.search), {
        replace: true,
        state: location.state,
      });
    }
  }, [issue, issueId, navigate, location.state, location.search]);

  useEffect(() => {
    if (!issue?.id) return;
    if (lastMarkedReadIssueIdRef.current === issue.id) return;
    lastMarkedReadIssueIdRef.current = issue.id;
    markIssueRead.mutate(issue.id);
  }, [issue?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (issue) {
      openPanel(
        <IssueProperties issue={issue} onUpdate={(data) => updateIssue.mutate(data)} />
      );
    }
    return () => closePanel();
  }, [issue]); // eslint-disable-line react-hooks/exhaustive-deps

  const copyIssueToClipboard = async () => {
    if (!issue) return;
    const decodeEntities = (text: string) => {
      const el = document.createElement("textarea");
      el.innerHTML = text;
      return el.value;
    };
    const title = decodeEntities(issue.title);
    const body = decodeEntities(issue.description ?? "");
    const md = `# ${issue.identifier}: ${title}\n\n${body}`.trimEnd();
    await navigator.clipboard.writeText(md);
    setCopied(true);
    pushToast({ title: "Copied to clipboard", tone: "success" });
    setTimeout(() => setCopied(false), 2000);
  };

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading...</p>;
  if (error) return <p className="text-sm text-destructive">{error.message}</p>;
  if (!issue) return null;

  // Ancestors are returned oldest-first from the server (root at end, immediate parent at start)
  const ancestors = issue.ancestors ?? [];
  const handleFilePicked = async (evt: ChangeEvent<HTMLInputElement>) => {
    const files = evt.target.files;
    if (!files || files.length === 0) return;
    for (const file of Array.from(files)) {
      if (isMarkdownFile(file)) {
        await importMarkdownDocument.mutateAsync(file);
      } else {
        await uploadAttachment.mutateAsync(file);
      }
    }
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const handleAttachmentDrop = async (evt: DragEvent<HTMLDivElement>) => {
    evt.preventDefault();
    setAttachmentDragActive(false);
    const files = evt.dataTransfer.files;
    if (!files || files.length === 0) return;
    for (const file of Array.from(files)) {
      if (isMarkdownFile(file)) {
        await importMarkdownDocument.mutateAsync(file);
      } else {
        await uploadAttachment.mutateAsync(file);
      }
    }
  };

  const isImageAttachment = (attachment: IssueAttachment) => attachment.contentType.startsWith("image/");
  const attachmentList = attachments ?? [];
  const hasAttachments = attachmentList.length > 0;
  const attachmentUploadButton = (
    <>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*,application/pdf,text/plain,text/markdown,application/json,text/csv,text/html,.md,.markdown"
        className="hidden"
        onChange={handleFilePicked}
        multiple
      />
      <Button
        variant="outline"
        size="sm"
        onClick={() => fileInputRef.current?.click()}
        disabled={uploadAttachment.isPending || importMarkdownDocument.isPending}
        className={cn(
          "shadow-none",
          attachmentDragActive && "border-primary bg-primary/5",
        )}
      >
        <Paperclip className="h-3.5 w-3.5 mr-1.5" />
        {uploadAttachment.isPending || importMarkdownDocument.isPending ? "Uploading..." : (
          <>
            <span className="hidden sm:inline">Upload attachment</span>
            <span className="sm:hidden">Upload</span>
          </>
        )}
      </Button>
    </>
  );

  return (
    <div className="w-full max-w-7xl space-y-6">
      {/* Parent chain breadcrumb */}
      {ancestors.length > 0 && (
        <nav className="flex items-center gap-1 text-xs text-muted-foreground flex-wrap">
          {[...ancestors].reverse().map((ancestor, i) => (
            <span key={ancestor.id} className="flex items-center gap-1">
              {i > 0 && <ChevronRight className="h-3 w-3 shrink-0" />}
              <Link
                to={createIssueDetailPath(ancestor.identifier ?? ancestor.id, location.state, location.search)}
                state={location.state}
                className="hover:text-foreground transition-colors truncate max-w-[200px]"
                title={ancestor.title}
              >
                {ancestor.title}
              </Link>
            </span>
          ))}
          <ChevronRight className="h-3 w-3 shrink-0" />
          <span className="text-foreground/60 truncate max-w-[200px]">{issue.title}</span>
        </nav>
      )}

      {issue.hiddenAt && (
        <div className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <EyeOff className="h-4 w-4 shrink-0" />
          This issue is hidden
        </div>
      )}

      <div className="space-y-3">
        <div className="flex items-center gap-2 min-w-0 flex-wrap">
          <StatusIcon
            status={issue.status}
            onChange={(status) => updateIssue.mutate({ status })}
          />
          <PriorityIcon
            priority={issue.priority}
            onChange={(priority) => updateIssue.mutate({ priority })}
          />
          <span className="text-sm font-mono text-muted-foreground shrink-0">{issue.identifier ?? issue.id.slice(0, 8)}</span>

          {hasLiveRuns && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-cyan-500/10 border border-cyan-500/30 px-2 py-0.5 text-[10px] font-medium text-cyan-600 dark:text-cyan-400 shrink-0">
              <span className="relative flex h-1.5 w-1.5">
                <span className="animate-pulse absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-cyan-400" />
              </span>
              Live
            </span>
          )}

          {issue.originKind === "routine_execution" && issue.originId && (
            <Link
              to={`/routines/${issue.originId}`}
              className="inline-flex items-center gap-1 rounded-full bg-violet-500/10 border border-violet-500/30 px-2 py-0.5 text-[10px] font-medium text-violet-600 dark:text-violet-400 shrink-0 hover:bg-violet-500/20 transition-colors"
            >
              <Repeat className="h-3 w-3" />
              Routine
            </Link>
          )}

          {issue.projectId ? (
            <Link
              to={`/projects/${issue.projectId}`}
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors rounded px-1 -mx-1 py-0.5 min-w-0"
            >
              <Hexagon className="h-3 w-3 shrink-0" />
              <span className="truncate">{(projects ?? []).find((p) => p.id === issue.projectId)?.name ?? issue.projectId.slice(0, 8)}</span>
            </Link>
          ) : (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground opacity-50 px-1 -mx-1 py-0.5">
              <Hexagon className="h-3 w-3 shrink-0" />
              No project
            </span>
          )}

          {(issue.labels ?? []).length > 0 && (
            <div className="hidden sm:flex items-center gap-1">
              {(issue.labels ?? []).slice(0, 4).map((label) => (
                <span
                  key={label.id}
                  className="inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium"
                  style={{
                    borderColor: label.color,
                    color: pickTextColorForPillBg(label.color, 0.12),
                    backgroundColor: `${label.color}1f`,
                  }}
                >
                  {label.name}
                </span>
              ))}
              {(issue.labels ?? []).length > 4 && (
                <span className="text-[10px] text-muted-foreground">+{(issue.labels ?? []).length - 4}</span>
              )}
            </div>
          )}

          <div className="ml-auto flex items-center gap-0.5 md:hidden shrink-0">
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={copyIssueToClipboard}
              title="Copy issue as markdown"
            >
              {copied ? <Check className="h-4 w-4 text-green-500" /> : <Copy className="h-4 w-4" />}
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => setMobilePropsOpen(true)}
              title="Properties"
            >
              <SlidersHorizontal className="h-4 w-4" />
            </Button>
          </div>

          <div className="hidden md:flex items-center md:ml-auto shrink-0">
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={copyIssueToClipboard}
              title="Copy issue as markdown"
            >
              {copied ? <Check className="h-4 w-4 text-green-500" /> : <Copy className="h-4 w-4" />}
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              className={cn(
                "shrink-0 transition-opacity duration-200",
                panelVisible ? "opacity-0 pointer-events-none w-0 overflow-hidden" : "opacity-100",
              )}
              onClick={() => setPanelVisible(true)}
              title="Show properties"
            >
              <SlidersHorizontal className="h-4 w-4" />
            </Button>

            <Popover open={moreOpen} onOpenChange={setMoreOpen}>
              <PopoverTrigger asChild>
                <Button variant="ghost" size="icon-xs" className="shrink-0">
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </PopoverTrigger>
            <PopoverContent className="w-44 p-1" align="end">
              <button
                className="flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50 text-destructive"
                onClick={() => {
                  updateIssue.mutate(
                    { hiddenAt: new Date().toISOString() },
                    { onSuccess: () => navigate("/issues/all") },
                  );
                  setMoreOpen(false);
                }}
              >
                <EyeOff className="h-3 w-3" />
                Hide this Issue
              </button>
            </PopoverContent>
            </Popover>
          </div>
        </div>

        <InlineEditor
          value={issue.title}
          onSave={(title) => updateIssue.mutateAsync({ title })}
          as="h2"
          className="text-xl font-bold"
        />

        <InlineEditor
          value={issue.description ?? ""}
          onSave={(description) => updateIssue.mutateAsync({ description })}
          as="p"
          className="text-[15px] leading-7 text-foreground"
          placeholder="Add a description..."
          multiline
          mentions={mentionOptions}
          imageUploadHandler={async (file) => {
            const attachment = await uploadAttachment.mutateAsync(file);
            return attachment.contentPath;
          }}
        />
      </div>

      {executionHeaderModel ? (
        <IssueExecutionHeader
          model={executionHeaderModel}
          issueKey={issue.identifier ?? issue.id.slice(0, 8)}
          issueStatus={issue.status}
        />
      ) : null}

      <Tabs value={surfaceTab} onValueChange={setSurfaceTab} className="space-y-4">
        <TabsList variant="line" className="w-full justify-start gap-1">
          <TabsTrigger value="chat" className="gap-1.5">
            <MessageSquare className="h-3.5 w-3.5" />
            Chat
          </TabsTrigger>
          <TabsTrigger value="dashboard" className="gap-1.5">
            <PanelsTopLeft className="h-3.5 w-3.5" />
            Task Dashboard
          </TabsTrigger>
          <TabsTrigger value="history" className="gap-1.5">
            <ActivityIcon className="h-3.5 w-3.5" />
            History
          </TabsTrigger>
        </TabsList>

        <TabsContent value="chat" className="space-y-4">
          <IssueConversationSurface
            companyId={issue.companyId}
            liveRuns={liveRuns ?? []}
            context={executionCommentContext}
            verbosity={conversationVerbosity}
            onVerbosityChange={setConversationVerbosity}
            pendingFollowupStatus={effectivePendingComposerStatus}
            liveFeed={issueChatLiveTransport.feed}
          />

          <IssueConversationComposer
            key={issue.id}
            onAdd={async (body, reopen, reassignment, commentTargetAgentId, options) => {
              if (reassignment) {
                await addCommentAndReassign.mutateAsync({
                  body,
                  reopen,
                  reassignment,
                  commentTargetAgentId,
                  ...(options?.interrupt ? { interrupt: true } : {}),
                });
                return;
              }
              await addComment.mutateAsync({
                body,
                reopen,
                commentTargetAgentId,
                ...(options?.interrupt ? { interrupt: true } : {}),
              });
            }}
            imageUploadHandler={async (file) => {
              const attachment = await uploadAttachment.mutateAsync(file);
              return attachment.contentPath;
            }}
            onAttachImage={async (file) => {
              await uploadAttachment.mutateAsync(file);
            }}
            composerStatusSlot={pendingComposerStatusCard}
            enableReassign
            reassignOptions={commentReassignOptions}
            currentAssigneeValue={actualAssigneeValue}
            suggestedAssigneeValue={suggestedAssigneeValue}
            mentions={mentionOptions}
            agentMap={agentMap}
            draftKey={`paperclip:issue-comment-draft:${issue.id}`}
            issueStatus={issue.status}
          />
        </TabsContent>

        <TabsContent value="dashboard" className="space-y-4">
          <div className="rounded-2xl border border-border bg-card/80 p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="space-y-2">
                <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                  Task Dashboard
                </p>
                <h3 className="text-lg font-semibold text-foreground">
                  Один обзор по задаче без повторения чата и сырого execution noise.
                </h3>
                <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
                  Здесь живут статус задачи, доказательства, документы и инфраструктурные панели. Полный диалог остается в Chat, а аудит событий уезжает в History.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <StatusBadge status={issue.status} />
                {hasLiveRuns ? <StatusBadge status="running" /> : null}
                {queuedComments.length > 0 ? (
                  <span className="inline-flex items-center rounded-full border border-border bg-accent/20 px-3 py-1 text-xs font-medium text-foreground">
                    Queue {queuedComments.length}
                  </span>
                ) : null}
                {linkedApprovals?.length ? (
                  <span className="inline-flex items-center rounded-full border border-border bg-accent/20 px-3 py-1 text-xs font-medium text-foreground">
                    Approvals {linkedApprovals.length}
                  </span>
                ) : null}
              </div>
            </div>
          </div>

          <Tabs value={dashboardTab} onValueChange={setDashboardTab} className="space-y-3">
            <TabsList variant="line" className="w-full justify-start gap-1">
              <TabsTrigger value="overview" className="gap-1.5">
                <Hexagon className="h-3.5 w-3.5" />
                Overview
              </TabsTrigger>
              <TabsTrigger value="subissues" className="gap-1.5">
                <ListTree className="h-3.5 w-3.5" />
                Sub-issues
              </TabsTrigger>
              {linkedApprovals && linkedApprovals.length > 0 ? (
                <TabsTrigger value="approvals" className="gap-1.5">
                  <Check className="h-3.5 w-3.5" />
                  Approvals
                </TabsTrigger>
              ) : null}
              {issuePluginTabItems.map((item) => (
                <TabsTrigger key={item.value} value={item.value}>
                  {item.label}
                </TabsTrigger>
              ))}
            </TabsList>

            <TabsContent value="overview" className="space-y-4">
              <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
                <div className="space-y-4">
                  <IssueLiveSessionPanel
                    issueId={issueId!}
                    companyId={issue.companyId}
                    atlasExecutionFallback={atlasExecutionPanelModel}
                    chatMessages={atlasNarrativeChatMessages}
                  />

                  <PluginSlotOutlet
                    slotTypes={["toolbarButton", "contextMenuItem"]}
                    entityType="issue"
                    context={{
                      companyId: issue.companyId,
                      projectId: issue.projectId ?? null,
                      entityId: issue.id,
                      entityType: "issue",
                    }}
                    className="flex flex-wrap gap-2"
                    itemClassName="inline-flex"
                    missingBehavior="placeholder"
                  />

                  <PluginLauncherOutlet
                    placementZones={["toolbarButton"]}
                    entityType="issue"
                    context={{
                      companyId: issue.companyId,
                      projectId: issue.projectId ?? null,
                      entityId: issue.id,
                      entityType: "issue",
                    }}
                    className="flex flex-wrap gap-2"
                    itemClassName="inline-flex"
                  />

                  <PluginSlotOutlet
                    slotTypes={["taskDetailView"]}
                    entityType="issue"
                    context={{
                      companyId: issue.companyId,
                      projectId: issue.projectId ?? null,
                      entityId: issue.id,
                      entityType: "issue",
                    }}
                    className="space-y-3"
                    itemClassName="rounded-lg border border-border p-3"
                    missingBehavior="placeholder"
                  />
                </div>

                <div className="space-y-4">
                  <IssueWorkspaceCard
                    issue={issue}
                    project={orderedProjects.find((p) => p.id === issue.projectId) ?? null}
                    onUpdate={(data) => updateIssue.mutate(data)}
                  />
                </div>
              </div>

              <Separator />

              <IssueDocumentsSection
                issue={issue}
                canDeleteDocuments={Boolean(session?.user?.id)}
                mentions={mentionOptions}
                imageUploadHandler={async (file) => {
                  const attachment = await uploadAttachment.mutateAsync(file);
                  return attachment.contentPath;
                }}
                extraActions={!hasAttachments ? attachmentUploadButton : undefined}
              />

              {hasAttachments ? (
                <div
                  className={cn("space-y-3 rounded-lg transition-colors")}
                  onDragEnter={(evt) => {
                    evt.preventDefault();
                    setAttachmentDragActive(true);
                  }}
                  onDragOver={(evt) => {
                    evt.preventDefault();
                    setAttachmentDragActive(true);
                  }}
                  onDragLeave={(evt) => {
                    if (evt.currentTarget.contains(evt.relatedTarget as Node | null)) return;
                    setAttachmentDragActive(false);
                  }}
                  onDrop={(evt) => void handleAttachmentDrop(evt)}
                >
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="text-sm font-medium text-muted-foreground">Attachments</h3>
                    {attachmentUploadButton}
                  </div>

                  {attachmentError && (
                    <p className="text-xs text-destructive">{attachmentError}</p>
                  )}

                  <div className="space-y-2">
                    {attachmentList.map((attachment) => (
                      <div key={attachment.id} className="border border-border rounded-md p-2">
                        <div className="flex items-center justify-between gap-2">
                          <a
                            href={attachment.contentPath}
                            target="_blank"
                            rel="noreferrer"
                            className="text-xs hover:underline truncate"
                            title={attachment.originalFilename ?? attachment.id}
                          >
                            {attachment.originalFilename ?? attachment.id}
                          </a>
                          <button
                            type="button"
                            className="text-muted-foreground hover:text-destructive"
                            onClick={() => deleteAttachment.mutate(attachment.id)}
                            disabled={deleteAttachment.isPending}
                            title="Delete attachment"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                        <p className="text-[11px] text-muted-foreground">
                          {attachment.contentType} · {(attachment.byteSize / 1024).toFixed(1)} KB
                        </p>
                        {isImageAttachment(attachment) && (
                          <a href={attachment.contentPath} target="_blank" rel="noreferrer">
                            <img
                              src={attachment.contentPath}
                              alt={attachment.originalFilename ?? "attachment"}
                              className="mt-2 max-h-56 rounded border border-border object-contain bg-accent/10"
                              loading="lazy"
                            />
                          </a>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </TabsContent>

            <TabsContent value="subissues">
              {childIssues.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-border bg-card/40 px-4 py-5 text-sm text-muted-foreground">
                  No sub-issues.
                </div>
              ) : (
                <div className="overflow-hidden rounded-2xl border border-border bg-card">
                  {childIssues.map((child) => (
                    <Link
                      key={child.id}
                      to={createIssueDetailPath(child.identifier ?? child.id, location.state, location.search)}
                      state={location.state}
                      className="flex items-center justify-between gap-3 border-b border-border px-4 py-3 text-sm transition-colors last:border-b-0 hover:bg-accent/20"
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        <StatusIcon status={child.status} />
                        <PriorityIcon priority={child.priority} />
                        <span className="shrink-0 font-mono text-muted-foreground">
                          {child.identifier ?? child.id.slice(0, 8)}
                        </span>
                        <span className="truncate">{child.title}</span>
                      </div>
                      {child.assigneeAgentId && (() => {
                        const name = agentMap.get(child.assigneeAgentId)?.name;
                        return name
                          ? <Identity name={name} size="sm" />
                          : <span className="font-mono text-muted-foreground">{child.assigneeAgentId.slice(0, 8)}</span>;
                      })()}
                    </Link>
                  ))}
                </div>
              )}
            </TabsContent>

            {linkedApprovals && linkedApprovals.length > 0 ? (
              <TabsContent value="approvals">
                <div className="overflow-hidden rounded-2xl border border-border bg-card">
                  {linkedApprovals.map((approval) => (
                    <Link
                      key={approval.id}
                      to={`/approvals/${approval.id}`}
                      className="flex items-center justify-between gap-3 border-b border-border px-4 py-3 text-sm transition-colors last:border-b-0 hover:bg-accent/20"
                    >
                      <div className="flex items-center gap-2">
                        <StatusBadge status={approval.status} />
                        <span className="font-medium">
                          {approval.type.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}
                        </span>
                        <span className="font-mono text-muted-foreground">{approval.id.slice(0, 8)}</span>
                      </div>
                      <span className="text-xs text-muted-foreground" title={formatFullTimeTitle(approval.createdAt)}>
                        {formatClockTime(approval.createdAt)}
                      </span>
                    </Link>
                  ))}
                </div>
              </TabsContent>
            ) : null}

            {activePluginTab && (
              <TabsContent value={activePluginTab.value}>
                <PluginSlotMount
                  slot={activePluginTab.slot}
                  context={{
                    companyId: issue.companyId,
                    projectId: issue.projectId ?? null,
                    entityId: issue.id,
                    entityType: "issue",
                  }}
                  missingBehavior="placeholder"
                />
              </TabsContent>
            )}
          </Tabs>
        </TabsContent>

        <TabsContent value="history" className="space-y-4">
          <div className="rounded-2xl border border-border bg-card/80 p-4">
            <div className="space-y-2">
              <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">History</p>
              <h3 className="text-lg font-semibold text-foreground">Сжатый audit trail без дублей и одинаковых карточек.</h3>
              <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
                Здесь живут raw comments, runs и activity. Chat и Dashboard больше не повторяют этот поток.
              </p>
            </div>
          </div>

          <Tabs value={historyTab} onValueChange={setHistoryTab} className="space-y-3">
            <TabsList variant="line" className="w-full justify-start gap-1">
              <TabsTrigger value="runs" className="gap-1.5">
                <Repeat className="h-3.5 w-3.5" />
                Runs
              </TabsTrigger>
              <TabsTrigger value="comments" className="gap-1.5">
                <MessageSquare className="h-3.5 w-3.5" />
                Comments
              </TabsTrigger>
              <TabsTrigger value="activity" className="gap-1.5">
                <ActivityIcon className="h-3.5 w-3.5" />
                Activity
              </TabsTrigger>
            </TabsList>

            <TabsContent value="runs" className="space-y-4">
              {compactRunStatusGroups.length > 0 ? (
                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                  {compactRunStatusGroups.map((group) => (
                    <div key={group.label} className="rounded-2xl border border-border bg-card px-4 py-3">
                      <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Grouped</div>
                      <div className="mt-2 text-sm font-medium text-foreground">{group.label}</div>
                      <div className="mt-1 text-xs text-muted-foreground">{group.count} runs</div>
                    </div>
                  ))}
                </div>
              ) : null}

              {!timelineRuns.length ? (
                <div className="rounded-2xl border border-dashed border-border bg-card/40 px-4 py-5 text-sm text-muted-foreground">
                  No runs yet.
                </div>
              ) : (
                <div className="space-y-3">
                  {timelineRuns.slice(0, 40).map((run) => (
                    <HistoryRunRow
                      key={run.runId}
                      run={run}
                      agentName={agentMap.get(run.agentId)?.name ?? run.agentId.slice(0, 8)}
                    />
                  ))}
                </div>
              )}
            </TabsContent>

            <TabsContent value="comments">
              <CommentThread
                comments={timelineComments}
                queuedComments={queuedComments}
                linkedRuns={[]}
                companyId={issue.companyId}
                projectId={issue.projectId}
                issueStatus={issue.status}
                agentMap={agentMap}
                draftKey={`paperclip:issue-comment-draft:${issue.id}`}
                enableReassign
                reassignOptions={commentReassignOptions}
                currentAssigneeValue={actualAssigneeValue}
                suggestedAssigneeValue={suggestedAssigneeValue}
                mentions={mentionOptions}
                onInterruptQueued={async (runId) => {
                  await interruptQueuedComment.mutateAsync(runId);
                }}
                interruptingQueuedRunId={interruptQueuedComment.isPending ? runningIssueRun?.id ?? null : null}
                onAdd={async () => {}}
                imageUploadHandler={async (file) => {
                  const attachment = await uploadAttachment.mutateAsync(file);
                  return attachment.contentPath;
                }}
                onAttachImage={async (file) => {
                  await uploadAttachment.mutateAsync(file);
                }}
                showComposer={false}
                title="Comments"
              />
            </TabsContent>

            <TabsContent value="activity">
              {linkedRuns && linkedRuns.length > 0 && (
                <div className="mb-3 rounded-2xl border border-border bg-card px-4 py-3">
                  <div className="text-sm font-medium text-muted-foreground mb-1">Cost Summary</div>
                  {!issueCostSummary.hasCost && !issueCostSummary.hasTokens ? (
                    <div className="text-xs text-muted-foreground">No cost data yet.</div>
                  ) : (
                    <div className="flex flex-wrap gap-3 text-xs text-muted-foreground tabular-nums">
                      {issueCostSummary.hasCost && (
                        <span className="font-medium text-foreground">
                          ${issueCostSummary.cost.toFixed(4)}
                        </span>
                      )}
                      {issueCostSummary.hasTokens && (
                        <span>
                          Tokens {formatTokens(issueCostSummary.totalTokens)}
                          {issueCostSummary.cached > 0
                            ? ` (in ${formatTokens(issueCostSummary.input)}, out ${formatTokens(issueCostSummary.output)}, cached ${formatTokens(issueCostSummary.cached)})`
                            : ` (in ${formatTokens(issueCostSummary.input)}, out ${formatTokens(issueCostSummary.output)})`}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              )}
              {!activity || activity.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-border bg-card/40 px-4 py-5 text-sm text-muted-foreground">
                  No activity yet.
                </div>
              ) : (
                <div className="space-y-2">
                  {activity.slice(0, 60).map((evt) => (
                    <div key={evt.id} className="rounded-2xl border border-border bg-card px-4 py-3">
                      <div className="flex items-center gap-2">
                        <ActorIdentity evt={evt} agentMap={agentMap} />
                        <span className="text-sm text-foreground">{formatAction(evt.action, evt.details)}</span>
                        <span className="ml-auto text-xs text-muted-foreground" title={formatFullTimeTitle(evt.createdAt)}>
                          {formatClockTime(evt.createdAt)}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </TabsContent>
          </Tabs>
        </TabsContent>
      </Tabs>

      {/* Mobile properties drawer */}
      <Sheet open={mobilePropsOpen} onOpenChange={setMobilePropsOpen}>
        <SheetContent side="bottom" className="max-h-[85dvh] pb-[env(safe-area-inset-bottom)]">
          <SheetHeader>
            <SheetTitle className="text-sm">Properties</SheetTitle>
          </SheetHeader>
          <ScrollArea className="flex-1 overflow-y-auto">
            <div className="px-4 pb-4">
              <IssueProperties issue={issue} onUpdate={(data) => updateIssue.mutate(data)} inline />
            </div>
          </ScrollArea>
        </SheetContent>
      </Sheet>
      <ScrollToBottom />
    </div>
  );
}
