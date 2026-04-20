import { memo, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { Link, useLocation } from "react-router-dom";
import type { IssueComment, Agent } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Check, Copy, Paperclip } from "lucide-react";
import { Identity } from "./Identity";
import { InlineEntitySelector, type InlineEntityOption } from "./InlineEntitySelector";
import { MarkdownBody } from "./MarkdownBody";
import { MarkdownEditor, type MarkdownEditorRef, type MentionOption } from "./MarkdownEditor";
import { StatusBadge } from "./StatusBadge";
import { AgentIcon } from "./AgentIconPicker";
import { formatDateTime } from "../lib/utils";
import { restoreSubmittedCommentDraft } from "../lib/comment-submit-draft";
import { PluginSlotOutlet } from "@/plugins/slots";

interface CommentWithRunMeta extends IssueComment {
  runId?: string | null;
  runAgentId?: string | null;
  clientId?: string;
  clientStatus?: "pending" | "queued";
  queueState?: "queued";
  queueTargetRunId?: string | null;
}

interface LinkedRunItem {
  runId: string;
  status: string;
  agentId: string;
  createdAt: Date | string;
  startedAt: Date | string | null;
}

interface CommentReassignment {
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
}

interface CommentThreadProps {
  comments: CommentWithRunMeta[];
  queuedComments?: CommentWithRunMeta[];
  linkedRuns?: LinkedRunItem[];
  companyId?: string | null;
  projectId?: string | null;
  onAdd: (body: string, reopen?: boolean, reassignment?: CommentReassignment) => Promise<void>;
  issueStatus?: string;
  agentMap?: Map<string, Agent>;
  imageUploadHandler?: (file: File) => Promise<string>;
  /** Callback to attach an image file to the parent issue (not inline in a comment). */
  onAttachImage?: (file: File) => Promise<void>;
  draftKey?: string;
  liveRunSlot?: React.ReactNode;
  enableReassign?: boolean;
  reassignOptions?: InlineEntityOption[];
  currentAssigneeValue?: string;
  suggestedAssigneeValue?: string;
  mentions?: MentionOption[];
  onInterruptQueued?: (runId: string) => Promise<void>;
  interruptingQueuedRunId?: string | null;
}

const DRAFT_DEBOUNCE_MS = 800;
const TERMINAL_ISSUE_STATUSES = new Set(["done", "cancelled", "completed", "closed", "in_review"]);
const COMMENT_MODEL_OPTIONS = [
  { value: "auto", label: "Model: Auto" },
  { value: "gpt-5.4", label: "GPT-5.4" },
  { value: "gpt-5.4-mini", label: "GPT-5.4 Mini" },
  { value: "gpt-5.2", label: "GPT-5.2" },
];
const COMMENT_REASONING_OPTIONS = [
  { value: "auto", label: "Reasoning: Auto" },
  { value: "minimal", label: "Minimal" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];
const COMPOSER_META_MARKER = "paperclip-compose";

function loadDraft(draftKey: string): string {
  try {
    return localStorage.getItem(draftKey) ?? "";
  } catch {
    return "";
  }
}

function saveDraft(draftKey: string, value: string) {
  try {
    if (value.trim()) {
      localStorage.setItem(draftKey, value);
    } else {
      localStorage.removeItem(draftKey);
    }
  } catch {
    // Ignore localStorage failures.
  }
}

function clearDraft(draftKey: string) {
  try {
    localStorage.removeItem(draftKey);
  } catch {
    // Ignore localStorage failures.
  }
}

function parseReassignment(target: string): CommentReassignment | null {
  if (!target || target === "__none__") {
    return { assigneeAgentId: null, assigneeUserId: null };
  }
  if (target.startsWith("agent:")) {
    const assigneeAgentId = target.slice("agent:".length);
    return assigneeAgentId ? { assigneeAgentId, assigneeUserId: null } : null;
  }
  if (target.startsWith("user:")) {
    const assigneeUserId = target.slice("user:".length);
    return assigneeUserId ? { assigneeAgentId: null, assigneeUserId } : null;
  }
  return null;
}

function parseComposerMeta(body: string): {
  cleanBody: string;
  model: string | null;
  reasoning: string | null;
} {
  const match = body.match(/^<!--\s*paperclip-compose:\s*(\{[\s\S]*?\})\s*-->\s*/);
  if (!match) {
    return { cleanBody: body, model: null, reasoning: null };
  }
  try {
    const parsed = JSON.parse(match[1]) as { model?: unknown; reasoning?: unknown };
    const model = typeof parsed.model === "string" && parsed.model.trim() ? parsed.model.trim() : null;
    const reasoning =
      typeof parsed.reasoning === "string" && parsed.reasoning.trim() ? parsed.reasoning.trim() : null;
    return {
      cleanBody: body.slice(match[0].length),
      model,
      reasoning,
    };
  } catch {
    return { cleanBody: body, model: null, reasoning: null };
  }
}

function buildComposerBody(params: {
  body: string;
  model: string;
  reasoning: string;
}) {
  const trimmed = params.body.trim();
  if (!trimmed) return "";
  if (params.model === "auto" && params.reasoning === "auto") {
    return trimmed;
  }
  return `<!-- ${COMPOSER_META_MARKER}: ${JSON.stringify({
    model: params.model,
    reasoning: params.reasoning,
  })} -->\n${trimmed}`;
}

function CopyMarkdownButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="text-muted-foreground hover:text-foreground transition-colors"
      title="Copy as markdown"
      onClick={() => {
        navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        });
      }}
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
    </button>
  );
}

function CommentCard({
  comment,
  agentMap,
  companyId,
  projectId,
  highlightCommentId,
  queued = false,
}: {
  comment: CommentWithRunMeta;
  agentMap?: Map<string, Agent>;
  companyId?: string | null;
  projectId?: string | null;
  highlightCommentId?: string | null;
  queued?: boolean;
}) {
  const isHighlighted = highlightCommentId === comment.id;
  const isPending = comment.clientStatus === "pending";
  const isQueued = queued || comment.queueState === "queued" || comment.clientStatus === "queued";
  const composerMeta = parseComposerMeta(comment.body);
  const surfaceBody = composerMeta.cleanBody.trim() || comment.body;
  const isAgentMessage = Boolean(comment.authorAgentId);
  const metaBadges = [composerMeta.model, composerMeta.reasoning].filter(Boolean) as string[];

  return (
    <div
      key={comment.id}
      id={`comment-${comment.id}`}
      className={`overflow-hidden min-w-0 rounded-2xl border p-4 transition-colors duration-1000 ${
        isQueued
          ? "border-amber-300/70 bg-amber-50/70 dark:border-amber-500/40 dark:bg-amber-500/10"
          : isHighlighted
            ? "border-primary/50 bg-primary/5"
            : isAgentMessage
              ? "border-border bg-card"
              : "border-primary/20 bg-primary/5"
      } ${isPending ? "opacity-80" : ""}`}
    >
      <div className="mb-2 flex items-center justify-between gap-3">
        {comment.authorAgentId ? (
          <Link to={`/agents/${comment.authorAgentId}`} className="hover:underline">
            <Identity
              name={agentMap?.get(comment.authorAgentId)?.name ?? comment.authorAgentId.slice(0, 8)}
              size="sm"
            />
          </Link>
        ) : (
          <Identity name="You" size="sm" />
        )}
        <span className="flex items-center gap-1.5 text-xs">
          {isQueued ? (
            <span className="inline-flex items-center rounded-full border border-amber-400/60 bg-amber-100/70 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em] text-amber-800 dark:border-amber-400/40 dark:bg-amber-500/20 dark:text-amber-200">
              Queued
            </span>
          ) : null}
          {metaBadges.map((badge) => (
            <span
              key={badge}
              className="inline-flex items-center rounded-full border border-border/70 bg-accent/40 px-2 py-0.5 text-[10px] uppercase tracking-[0.14em] text-muted-foreground"
            >
              {badge}
            </span>
          ))}
          {companyId && !isPending ? (
            <PluginSlotOutlet
              slotTypes={["commentContextMenuItem"]}
              entityType="comment"
              context={{
                companyId,
                projectId: projectId ?? null,
                entityId: comment.id,
                entityType: "comment",
                parentEntityId: comment.issueId,
              }}
              className="flex flex-wrap items-center gap-1.5"
              itemClassName="inline-flex"
              missingBehavior="placeholder"
            />
          ) : null}
          {isPending ? (
            <span className="text-xs text-muted-foreground">{isQueued ? "Queueing..." : "Sending..."}</span>
          ) : (
            <a
              href={`#comment-${comment.id}`}
              className="text-xs text-muted-foreground hover:text-foreground hover:underline transition-colors"
            >
              {formatDateTime(comment.createdAt)}
            </a>
          )}
          <CopyMarkdownButton text={surfaceBody} />
        </span>
      </div>
      <MarkdownBody className="text-[15px] leading-7">{surfaceBody}</MarkdownBody>
      {companyId && !isPending ? (
        <div className="mt-2 space-y-2">
          <PluginSlotOutlet
            slotTypes={["commentAnnotation"]}
            entityType="comment"
            context={{
              companyId,
              projectId: projectId ?? null,
              entityId: comment.id,
              entityType: "comment",
              parentEntityId: comment.issueId,
            }}
            className="space-y-2"
            itemClassName="rounded-md"
            missingBehavior="placeholder"
          />
        </div>
      ) : null}
      {comment.runId && !isPending ? (
        <div className="mt-2 pt-2 border-t border-border/60">
          {comment.runAgentId ? (
            <Link
              to={`/agents/${comment.runAgentId}/runs/${comment.runId}`}
              className="inline-flex items-center rounded-md border border-border bg-accent/30 px-2 py-1 text-[10px] font-mono text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
            >
              run {comment.runId.slice(0, 8)}
            </Link>
          ) : (
            <span className="inline-flex items-center rounded-md border border-border bg-accent/30 px-2 py-1 text-[10px] font-mono text-muted-foreground">
              run {comment.runId.slice(0, 8)}
            </span>
          )}
        </div>
      ) : null}
    </div>
  );
}

type TimelineItem =
  | { kind: "comment"; id: string; createdAtMs: number; comment: CommentWithRunMeta }
  | { kind: "run"; id: string; createdAtMs: number; run: LinkedRunItem };

const TimelineList = memo(function TimelineList({
  timeline,
  agentMap,
  companyId,
  projectId,
  highlightCommentId,
}: {
  timeline: TimelineItem[];
  agentMap?: Map<string, Agent>;
  companyId?: string | null;
  projectId?: string | null;
  highlightCommentId?: string | null;
}) {
  if (timeline.length === 0) {
    return <p className="text-sm text-muted-foreground">Пока нет ни одного сообщения.</p>;
  }

  return (
    <div className="space-y-4">
      {timeline.map((item) => {
        if (item.kind === "run") return null;

        const comment = item.comment;
        return (
          <CommentCard
            key={comment.id}
            comment={comment}
            agentMap={agentMap}
            companyId={companyId}
            projectId={projectId}
            highlightCommentId={highlightCommentId}
          />
        );
      })}
    </div>
  );
});

export function CommentThread({
  comments,
  queuedComments = [],
  linkedRuns = [],
  companyId,
  projectId,
  issueStatus,
  onAdd,
  agentMap,
  imageUploadHandler,
  onAttachImage,
  draftKey,
  liveRunSlot,
  enableReassign = false,
  reassignOptions = [],
  currentAssigneeValue = "",
  suggestedAssigneeValue,
  mentions: providedMentions,
  onInterruptQueued,
  interruptingQueuedRunId = null,
}: CommentThreadProps) {
  const [body, setBody] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const [selectedModel, setSelectedModel] = useState("auto");
  const [selectedReasoning, setSelectedReasoning] = useState("auto");
  const effectiveSuggestedAssigneeValue = suggestedAssigneeValue ?? currentAssigneeValue;
  const [reassignTarget, setReassignTarget] = useState(effectiveSuggestedAssigneeValue);
  const [highlightCommentId, setHighlightCommentId] = useState<string | null>(null);
  const editorRef = useRef<MarkdownEditorRef>(null);
  const attachInputRef = useRef<HTMLInputElement | null>(null);
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const location = useLocation();
  const hasScrolledRef = useRef(false);

  const timeline = useMemo<TimelineItem[]>(() => {
    return comments
      .map((comment) => ({
        kind: "comment" as const,
        id: comment.id,
        createdAtMs: new Date(comment.createdAt).getTime(),
        comment,
      }))
      .sort((a, b) => {
        if (a.createdAtMs !== b.createdAtMs) return a.createdAtMs - b.createdAtMs;
        return a.id.localeCompare(b.id);
      });
  }, [comments]);

  const shouldAutoReopen = TERMINAL_ISSUE_STATUSES.has((issueStatus ?? "").toLowerCase());

  // Build mention options from agent map (exclude terminated agents)
  const mentions = useMemo<MentionOption[]>(() => {
    if (providedMentions) return providedMentions;
    if (!agentMap) return [];
    return Array.from(agentMap.values())
      .filter((a) => a.status !== "terminated")
      .map((a) => ({
        id: `agent:${a.id}`,
        name: a.name,
        kind: "agent",
        agentId: a.id,
        agentIcon: a.icon,
      }));
  }, [agentMap, providedMentions]);

  useEffect(() => {
    if (!draftKey) return;
    setBody(loadDraft(draftKey));
  }, [draftKey]);

  useEffect(() => {
    if (!draftKey) return;
    if (draftTimer.current) clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => {
      saveDraft(draftKey, body);
    }, DRAFT_DEBOUNCE_MS);
  }, [body, draftKey]);

  useEffect(() => {
    return () => {
      if (draftTimer.current) clearTimeout(draftTimer.current);
    };
  }, []);

  useEffect(() => {
    setReassignTarget(effectiveSuggestedAssigneeValue);
  }, [effectiveSuggestedAssigneeValue]);

  // Scroll to comment when URL hash matches #comment-{id}
  useEffect(() => {
    const hash = location.hash;
    if (!hash.startsWith("#comment-") || comments.length + queuedComments.length === 0) return;
    const commentId = hash.slice("#comment-".length);
    // Only scroll once per hash
    if (hasScrolledRef.current) return;
    const el = document.getElementById(`comment-${commentId}`);
    if (el) {
      hasScrolledRef.current = true;
      setHighlightCommentId(commentId);
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      // Clear highlight after animation
      const timer = setTimeout(() => setHighlightCommentId(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [location.hash, comments, queuedComments]);

  async function handleSubmit() {
    const trimmed = body.trim();
    if (!trimmed) return;
    const payloadBody = buildComposerBody({
      body: trimmed,
      model: selectedModel,
      reasoning: selectedReasoning,
    });
    const hasReassignment = enableReassign && reassignTarget !== currentAssigneeValue;
    const reassignment = hasReassignment ? parseReassignment(reassignTarget) : null;
    const submittedBody = payloadBody;

    setSubmitting(true);
    setBody("");
    try {
      // TODO: wire an explicit "send + interrupt" action through the composer if we expose it in the UI.
      await onAdd(submittedBody, shouldAutoReopen ? true : undefined, reassignment ?? undefined);
      if (draftKey) clearDraft(draftKey);
      setReassignTarget(effectiveSuggestedAssigneeValue);
    } catch {
      setBody((current) =>
        restoreSubmittedCommentDraft({
          currentBody: current,
          submittedBody: trimmed,
        }),
      );
      // Parent mutation handlers surface the failure and the draft is restored for retry.
    } finally {
      setSubmitting(false);
    }
  }

  async function handleAttachFile(evt: ChangeEvent<HTMLInputElement>) {
    const file = evt.target.files?.[0];
    if (!file) return;
    setAttaching(true);
    try {
      if (imageUploadHandler) {
        const url = await imageUploadHandler(file);
        const safeName = file.name.replace(/[[\]]/g, "\\$&");
        const markdown = `![${safeName}](${url})`;
        setBody((prev) => prev ? `${prev}\n\n${markdown}` : markdown);
      } else if (onAttachImage) {
        await onAttachImage(file);
      }
    } finally {
      setAttaching(false);
      if (attachInputRef.current) attachInputRef.current.value = "";
    }
  }

  const canSubmit = !submitting && !!body.trim();
  const queueSummary = linkedRuns.length
    ? `${linkedRuns.length} archived run${linkedRuns.length === 1 ? "" : "s"} moved to History`
    : null;

  return (
    <div className="space-y-5">
      <div className="rounded-2xl border border-border bg-card/60 p-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-1">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-cyan-400">Chat</p>
            <h3 className="text-lg font-semibold">Продолжить задачу</h3>
            <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
              Нормальный рабочий чат без сырых run-строк. Вся техническая телеметрия и архивные turns живут в
              <strong> History</strong> и <strong>Task Dashboard</strong>.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span className="rounded-full border border-border px-3 py-1">{timeline.length} messages</span>
            {queuedComments.length ? (
              <span className="rounded-full border border-amber-400/40 bg-amber-500/10 px-3 py-1 text-amber-200">
                {queuedComments.length} queued
              </span>
            ) : null}
            {queueSummary ? <span className="rounded-full border border-border px-3 py-1">{queueSummary}</span> : null}
          </div>
        </div>
      </div>

      {timeline.length > 0 ? (
        <TimelineList
          timeline={timeline}
          agentMap={agentMap}
          companyId={companyId}
          projectId={projectId}
          highlightCommentId={highlightCommentId}
        />
      ) : null}

      {liveRunSlot}

      {queuedComments.length > 0 && (
        <div className="space-y-3 rounded-2xl border border-amber-300/30 bg-amber-500/5 p-4">
          <div className="flex items-center justify-between gap-2">
            <h4 className="text-xs font-semibold uppercase tracking-[0.18em] text-amber-300">
              Очередь follow-up ({queuedComments.length})
            </h4>
            {onInterruptQueued && queuedComments[0]?.queueTargetRunId ? (
              <Button
                size="sm"
                variant="outline"
                className="border-red-300 text-red-700 hover:bg-red-50 hover:text-red-800 dark:border-red-500/40 dark:text-red-300 dark:hover:bg-red-500/10"
                disabled={interruptingQueuedRunId === queuedComments[0].queueTargetRunId}
                onClick={() => void onInterruptQueued(queuedComments[0]!.queueTargetRunId!)}
              >
                {interruptingQueuedRunId === queuedComments[0].queueTargetRunId ? "Interrupting..." : "Interrupt"}
              </Button>
            ) : null}
          </div>
          <div className="space-y-3">
            {queuedComments.map((comment) => (
              <CommentCard
                key={comment.id}
                comment={comment}
                agentMap={agentMap}
                companyId={companyId}
                projectId={projectId}
                highlightCommentId={highlightCommentId}
                queued
              />
            ))}
          </div>
        </div>
      )}

      <div className="rounded-2xl border border-border bg-card p-4 shadow-sm">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="space-y-1">
            <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              Continue task
            </div>
            <div className="text-sm text-muted-foreground">
              Следующий turn отправится без возврата в raw comments. Assignee остается явным, reopen для terminal
              статусов делается автоматически.
            </div>
          </div>
          {shouldAutoReopen ? (
            <span className="rounded-full border border-emerald-400/30 bg-emerald-500/10 px-3 py-1 text-xs text-emerald-300">
              Auto-reopen enabled
            </span>
          ) : null}
        </div>
        <MarkdownEditor
          ref={editorRef}
          value={body}
          onChange={setBody}
          placeholder="Опиши следующий шаг, blocker или новый turn для Atlas…"
          mentions={mentions}
          onSubmit={handleSubmit}
          imageUploadHandler={imageUploadHandler}
          contentClassName="min-h-[140px] text-[15px] leading-7"
        />
        <div className="mt-4 flex flex-wrap items-center justify-end gap-3">
          {(imageUploadHandler || onAttachImage) && (
            <div className="mr-auto flex items-center gap-3">
              <input
                ref={attachInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                className="hidden"
                onChange={handleAttachFile}
              />
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => attachInputRef.current?.click()}
                disabled={attaching}
                title="Attach image"
              >
                <Paperclip className="h-4 w-4" />
              </Button>
            </div>
          )}
          {enableReassign && reassignOptions.length > 0 && (
            <InlineEntitySelector
              value={reassignTarget}
              options={reassignOptions}
              placeholder="Assignee"
              noneLabel="No assignee"
              searchPlaceholder="Search assignees..."
              emptyMessage="No assignees found."
              onChange={setReassignTarget}
              className="text-xs h-8"
              renderTriggerValue={(option) => {
                if (!option) return <span className="text-muted-foreground">Assignee</span>;
                const agentId = option.id.startsWith("agent:") ? option.id.slice("agent:".length) : null;
                const agent = agentId ? agentMap?.get(agentId) : null;
                return (
                  <>
                    {agent ? (
                      <AgentIcon icon={agent.icon} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    ) : null}
                    <span className="truncate">{option.label}</span>
                  </>
                );
              }}
              renderOption={(option) => {
                if (!option.id) return <span className="truncate">{option.label}</span>;
                const agentId = option.id.startsWith("agent:") ? option.id.slice("agent:".length) : null;
                const agent = agentId ? agentMap?.get(agentId) : null;
                return (
                  <>
                    {agent ? (
                      <AgentIcon icon={agent.icon} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    ) : null}
                    <span className="truncate">{option.label}</span>
                  </>
                );
              }}
            />
          )}
          <Select value={selectedModel} onValueChange={setSelectedModel}>
            <SelectTrigger className="min-w-[160px]">
              <SelectValue placeholder="Model" />
            </SelectTrigger>
            <SelectContent>
              {COMMENT_MODEL_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={selectedReasoning} onValueChange={setSelectedReasoning}>
            <SelectTrigger className="min-w-[170px]">
              <SelectValue placeholder="Reasoning" />
            </SelectTrigger>
            <SelectContent>
              {COMMENT_REASONING_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button size="sm" disabled={!canSubmit} onClick={handleSubmit}>
            {submitting ? "Sending..." : "Send"}
          </Button>
        </div>
      </div>
    </div>
  );
}
